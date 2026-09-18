/**
 * 定时任务的工作目录判定 — 主进程唯一权威口径
 *
 * 为什么单独成文件：判定要在多处复用（cron 到点执行、立即执行、只读健康度查询），
 * 任何一处各写一遍都会长出第二份真相。此处收敛成一个函数，执行拦截与对外查询
 * 共用同一份结果。
 *
 * 四态（写死在这里，别处不得再判）：
 *   unset        记录里的 workspaceId 为 null / 空串
 *   missing      workspaces 表按 id 查不到记录（库是好的，就是没这条）
 *   unavailable  「有记录但当前拿不到一个可用目录」，两种成因合成一态：
 *                (i)  记录存在，但它的 path 在磁盘上不是「存在的目录」；
 *                (ii) 工作区记录**读不到**（DB 抖动 / 句柄失效）—— 此时 path 为 null，
 *                     reason 写明是读取失败。**读失败不是「记录不存在」**：归到 missing
 *                     会把一次库故障演成「这条任务的工作目录没了」，用户照着去修目录是白修
 *                     （缺陷 task-16cdf257 的原始症状：库一抖，列表里所有任务同时被标红）。
 *   ok           其余
 * 只有 ok 允许任务运行。
 *
 * 读失败能被看见的前提：仓储侧另开了窄出口（`tryGetById` / `tryList`，见
 * src/main/repositories/sqlite/workspaceRepository.ts）—— 既有的 `getById` / `list`
 * 会把故障吞成 null / []，本模块若还走它们，下面的 catch 分支永远不可达。
 *
 * 依赖约束：本模块被 `src/main/scheduler/index.ts` 静态引入，而 index.ts 位于 Agent
 * Worker 的静态依赖闭包内 —— 故此处只引入不触碰 electron 的依赖（fs + sqlite 仓储），
 * 不得引入 window / electron（见 tests/main/deps/workerNoElectron.test.ts）。
 */
import fs from 'fs'
import {SqliteWorkspaceRepository} from '../repositories/sqlite/workspaceRepository'
import type {ScheduleWorkspaceHealth} from '@shared/types/scheduleWorkspace'

/** 判定所需的两个外部事实（可注入，便于边界测试不经数据库与磁盘） */
export interface WorkspaceGuardDeps {
    /** 按 id 查工作区记录；查不到返回 null */
    findWorkspace: (workspaceId: string) => {path: string} | null
    /** 该路径在磁盘上是否是一个存在的目录 */
    isDirectory: (dirPath: string) => boolean
}

/** 生产实现：工作区记录取自 workspaces 表，目录存在性取自 fs.statSync */
const defaultDeps: WorkspaceGuardDeps = {
    // 走仓储的**窄出口**：`getById` 会把「读失败」吞成 null，那样上面的 catch 分支永远
    // 不可达、故障必然被误归成 missing。这里把 fault 原样抛给 evaluateWorkspace 统一归因。
    findWorkspace: (workspaceId) => {
        const lookup = new SqliteWorkspaceRepository().tryGetById(workspaceId)
        if (lookup.kind === 'fault') throw lookup.error
        return lookup.kind === 'ok' ? lookup.workspace : null
    },
    isDirectory: isDirectoryOnDisk,
}

/** 生产实现的目录判定（fs.statSync + 静默把「不存在 / 无权限」当不可用） */
function isDirectoryOnDisk(dirPath: string): boolean {
    try {
        return fs.statSync(dirPath).isDirectory()
    } catch {
        // 静默：目录不存在 / 权限不足都是「不可用」这一正常判定结果，
        // 由 state 与 reason 承载并呈现给用户，这里上报只会制造噪声。
        return false
    }
}

/**
 * 单条判定的内核：给出「id → 记录」的查询函数与目录判定，得到四态。
 * 单条与批量（sweep）共用它，保证两条出口不可能得出不同结论。
 */
function evaluateWorkspace(
    workspaceId: string | null | undefined,
    findWorkspace: (workspaceId: string) => {path: string} | null,
    isDirectory: (dirPath: string) => boolean,
): ScheduleWorkspaceHealth {
    // 空串与 null 同义：都表示「这条任务没有工作目录」（新需求里这是不可保存的配置）
    if (workspaceId === null || workspaceId === undefined || workspaceId.trim() === '') {
        return {state: 'unset', path: null, reason: '未设置项目'}
    }

    let record: {path: string} | null
    try {
        record = findWorkspace(workspaceId)
    } catch (err) {
        // 拦下的**方向**不变（宁可拦下也不放行到任何兜底目录），改的是**归因与文案**：
        // 读失败判成 unavailable，不再谎称「工作目录已不存在」。
        return {
            state: 'unavailable',
            path: null,
            reason: `项目不可用（项目记录读取失败：${err instanceof Error ? err.message : String(err)}）`,
        }
    }

    if (!record) return {state: 'missing', path: null, reason: '项目已不存在'}
    if (!isDirectory(record.path)) {
        return {state: 'unavailable', path: record.path, reason: `项目不可用（${record.path}）`}
    }
    return {state: 'ok', path: record.path, reason: null}
}

/**
 * 判定一个任务的 workspaceId 能不能跑。
 *
 * @param workspaceId 任务记录里的 workspaceId（允许 null / undefined / 空串）
 * @param deps 外部事实来源，缺省为生产实现
 */
export function checkScheduleWorkspace(
    workspaceId: string | null | undefined,
    deps: WorkspaceGuardDeps = defaultDeps,
): ScheduleWorkspaceHealth {
    return evaluateWorkspace(workspaceId, deps.findWorkspace, deps.isDirectory)
}

// ─── 批量 sweep（只读健康度出口专用） ────────────────

/** sweep 的外部事实来源：整表列表 + 目录判定 */
export interface WorkspaceSweepDeps {
    /** 一次取回**全部**工作区记录（id → path） */
    listWorkspaces: () => Array<{id: string; path: string}>
    /** 该路径在磁盘上是否是一个存在的目录 */
    isDirectory: (dirPath: string) => boolean
}

const defaultSweepDeps: WorkspaceSweepDeps = {
    // 同样走窄出口：`list` 把读失败压成 `[]`（=「一个工作区都没有」），
    // 那样整表读故障会被逐条演成 missing，正是本票要消掉的「列表集体标红」。
    listWorkspaces: () => {
        const lookup = new SqliteWorkspaceRepository().tryList()
        if (lookup.kind === 'fault') throw lookup.error
        return lookup.workspaces
    },
    isDirectory: isDirectoryOnDisk,
}

/**
 * 批量判定（一次 sweep）。
 *
 * 成本口径（票 11 复核 S5）：旧实现是「每个任务各一次 getById + 一次 statSync」，
 * K 个任务被拦就是 K×N 次同步查询 + K×N 次 stat，全在主进程、无合并窗口。
 * 现在：
 * - **一次** `listWorkspaces()` 建「id → 记录」索引，不再逐个 getById；
 * - 目录存在性按**路径**记忆化 → 一次 sweep 只做 M 次 stat（M = 不同路径数，
 *   同一路径被多个工作区引用时也只 stat 一次）。
 *
 * 判定内核与单条共用 evaluateWorkspace，故两条出口结论必然一致。
 */
export function sweepWorkspaceHealth(
    workspaceIds: ReadonlyArray<string | null | undefined>,
    deps: WorkspaceSweepDeps = defaultSweepDeps,
): ScheduleWorkspaceHealth[] {
    let index = new Map<string, {path: string}>()
    let listError: string | null = null
    try {
        for (const ws of deps.listWorkspaces()) index.set(ws.id, {path: ws.path})
    } catch (err) {
        // 整表读失败：与单条「查记录本身失败」同口径 —— 拦下并说明（判成 unavailable），
        // 不静默按「全部可用」放行，也不谎称每条任务的记录都不存在。
        index = new Map()
        listError = err instanceof Error ? err.message : String(err)
    }

    const dirCache = new Map<string, boolean>()
    const isDirectory = (dirPath: string): boolean => {
        const cached = dirCache.get(dirPath)
        if (cached !== undefined) return cached
        const verdict = deps.isDirectory(dirPath)
        dirCache.set(dirPath, verdict)
        return verdict
    }

    return workspaceIds.map((workspaceId) => evaluateWorkspace(
        workspaceId,
        (id) => {
            if (listError !== null) throw new Error(listError)
            return index.get(id) ?? null
        },
        isDirectory,
    ))
}

