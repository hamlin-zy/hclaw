/**
 * 项目必填 + 失效守卫（票 11 · workspace-guard）
 *
 * 三件事被钉住：
 *   1. **判定口径唯一**：unset / missing / unavailable / ok 四态由 `checkScheduleWorkspace`
 *      一处给出，边界（null 与空串同义、记录存在但磁盘目录不在）逐条覆盖；
 *   2. **拦截**：非 ok 一律不执行、不改任务状态，但记一次 `last_run_status='failure'`；
 *      cron 路径被拦时**仍发 ack**（否则引擎的待确认去重会把任务永久卡住）；
 *   3. **两个手动出口**（`runNow` 与 `runNowSchedule`）都返回可读错误。
 *
 * 隔离手法沿用 fireSourceAndScriptAttribution.test.ts：config 指临时目录、假 worker、
 * 假 sqlite 仓储；工作区记录与磁盘目录由本文件注入，不触碰真实数据库与真实工作区。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import * as os from 'os'
import * as path from 'path'

vi.mock('@/main/config', () => {
    const osMod = require('os')
    const pathMod = require('path')
    const testDir = pathMod.join(osMod.tmpdir(), 'hclaw-test-wsguard-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
        getHclawDataDir: () => pathMod.join(testDir, 'data'),
    }
})
vi.mock('@/main/hclawPaths', async () => await import('@/main/config'))  // 路径能力已下沉到叶子 hclawPaths：让叶子跟随本文件对 config 的桩，避免绕过 mock 落到真实 ~/.hclaw

/** worker_threads 的假实现：捕获出站消息（ack 就在这里被观察） */
vi.mock('worker_threads', () => {
    class FakeWorker {
        static instances: FakeWorker[] = []
        readonly posted: unknown[] = []
        readonly handlers: Record<string, (arg: unknown) => void> = {}
        constructor() { FakeWorker.instances.push(this) }
        on(event: string, handler: (arg: unknown) => void): void { this.handlers[event] = handler }
        postMessage(msg: unknown): void { this.posted.push(msg) }
        terminate(): void { /* no-op */ }
    }
    return {Worker: FakeWorker}
})

/** 脚本执行的桩：立即成功返回，用来证明「ok 路径照常跑」 */
vi.mock('child_process', () => ({
    exec: (_cmd: string, _opts: unknown, cb: (err: Error | null, res?: {stdout: string; stderr: string}) => void) => {
        cb(null, {stdout: 'OUT', stderr: ''})
    },
}))

const loggerStub = vi.hoisted(() => ({info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn()}))
vi.mock('@/main/agent/logger', () => ({createLogger: () => loggerStub, logger: loggerStub}))

const startAgentCoreStub = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('@/main/agent/startAgentCore', () => ({startAgentCore: startAgentCoreStub}))

const convRepoStub = vi.hoisted(() => ({
    list: vi.fn(() => [] as unknown[]),
    create: vi.fn(),
    updateMeta: vi.fn(),
    readMessages: vi.fn(() => [] as unknown[]),
    readMeta: vi.fn(() => null),
}))
vi.mock('@/main/repositories', () => ({createConversationRepository: () => convRepoStub}))

const scheduleRepoStub = vi.hoisted(() => ({
    get: vi.fn(),
    list: vi.fn(() => [] as unknown[]),
    listEnabled: vi.fn(() => [] as unknown[]),
    updateRunStatus: vi.fn(),
    resetRunningToFailure: vi.fn(() => 0),
    /**
     * 仓储的 `update`（改 enabled / paused 的那条路）。
     * 必须有这个方法，断言才成立：以前桩里**根本没有** `update`，用例写成
     * `expect(stub.update).toBeUndefined()` —— 那本来就为真，证明不了「拦截时没改任务状态」。
     */
    update: vi.fn(),
}))
vi.mock('@/main/scheduler/ScheduleRepository', () => ({scheduleRepo: scheduleRepoStub}))

/** 工作区记录表：测试直接给出 id → path 的对照，不碰真实数据库 */
const workspaceRows = vi.hoisted(() => ({
    byId: new Map<string, {id: string; path: string}>(),
    /** 成本口径的观察点（复核 S5）：整表查询次数 / 单条查询次数 */
    listCalls: {n: 0},
    getByIdCalls: {n: 0},
    /**
     * 缺陷 task-16cdf257：模拟仓储读取故障（DB 抖动 / 句柄失效）。
     * 置位后**窄出口**报 fault，而既有 `getById` / `list` 仍旧吞错返回 null / []。
     */
    fault: null as Error | null,
}))
vi.mock('@/main/repositories/sqlite/workspaceRepository', () => ({
    SqliteWorkspaceRepository: class {
        /** 既有宽出口：故障被吞成 null —— 正是守卫不能再走它的原因 */
        getById(id: string) {
            workspaceRows.getByIdCalls.n++
            if (workspaceRows.fault) return null
            return workspaceRows.byId.get(id) ?? null
        }
        /** 既有宽出口：读失败被吞成 []（读起来就是「一个工作区都没有」） */
        list() {
            workspaceRows.listCalls.n++
            if (workspaceRows.fault) return []
            return [...workspaceRows.byId.values()]
        }
        /** 窄出口：故障如实报 fault，守卫据此判 unavailable 而非 missing */
        tryGetById(id: string) {
            workspaceRows.getByIdCalls.n++
            if (workspaceRows.fault) return {kind: 'fault', error: workspaceRows.fault}
            const found = workspaceRows.byId.get(id)
            return found ? {kind: 'ok', workspace: found} : {kind: 'missing'}
        }
        /** 窄出口：整表读取故障同样如实报 fault */
        tryList() {
            workspaceRows.listCalls.n++
            if (workspaceRows.fault) return {kind: 'fault', error: workspaceRows.fault}
            return {kind: 'ok', workspaces: [...workspaceRows.byId.values()]}
        }
    },
}))


/** 广播观察点：假窗口收 `schedules-changed`（证明「列表行标红」的刷新通路真的被触发） */
const sent = vi.hoisted(() => [] as Array<{channel: string; payload: unknown}>)
const ipcHandlers = vi.hoisted(() => new Map<string, (e: unknown, ...args: unknown[]) => unknown>())
vi.mock('electron', () => ({
    ipcMain: {handle: (ch: string, fn: (e: unknown, ...args: unknown[]) => unknown) => { ipcHandlers.set(ch, fn) }},
    app: {isPackaged: false, getPath: () => ''},
    BrowserWindow: {
        getAllWindows: () => [{
            isDestroyed: () => false,
            webContents: {send: (channel: string, payload: unknown) => { sent.push({channel, payload}) }},
        }],
    },
}))

import {schedulerManager} from '@/main/scheduler'
import {initScheduleIPC} from '@/main/scheduler/scheduleIPC'
import {runNowSchedule, workspaceHealthMap} from '@/main/scheduler/scheduleOps'
import {checkScheduleWorkspace, sweepWorkspaceHealth} from '@/main/scheduler/scheduleWorkspace'
import type {ScheduleRecord} from '@shared/types/schedule'

type FakeWorkerInstance = {posted: unknown[]; handlers: Record<string, (arg: unknown) => void>}

function recordOf(overrides: Partial<ScheduleRecord>): ScheduleRecord {
    return {
        id: 'sched-x', name: '任务', description: '', cronExpression: '0 9 * * *',
        taskType: 'agent', taskTarget: 't', taskArgs: [], enabled: true, paused: false,
        pausedAt: null, lastRunAt: null, lastRunStatus: 'none', lastRunConversationId: null,
        runCount: 0, createdAt: 1, updatedAt: 1, workspaceId: null,
        ...overrides,
    }
}

/** 起一次假 worker（不调 init()，避免残留状态复位等无关流程） */
function spawnFakeWorker(): FakeWorkerInstance {
    ;(schedulerManager as unknown as {spawnCronWorker(): void}).spawnCronWorker()
    return (schedulerManager as unknown as {worker: FakeWorkerInstance}).worker
}

function acks(posted: unknown[]): unknown[] {
    return posted.filter(m => (m as {cmd?: string}).cmd === 'ack')
}

/** 直接驱动执行入口（与 worker 的 task_fire 走同一条路） */
function execute(msg: {
    scheduleId: string
    taskType?: ScheduleRecord['taskType']
    taskTarget?: string
    source?: 'cron' | 'manual'
}): Promise<{success: boolean; error?: string}> {
    const run = (schedulerManager as unknown as {
        executeSchedule(m: unknown): Promise<{success: boolean; error?: string}>
    }).executeSchedule.bind(schedulerManager)
    return run({
        scheduleId: msg.scheduleId,
        taskType: msg.taskType ?? 'agent',
        taskTarget: msg.taskTarget ?? 't',
        taskArgs: [],
        source: msg.source ?? 'cron',
    })
}

// ── 三个磁盘事实：存在的目录 / 记录指向不存在的目录 ──
const EXISTING_DIR = os.tmpdir()
const MISSING_DIR = path.join(os.tmpdir(), 'hclaw-definitely-not-here-' + Date.now())

beforeEach(() => {
    vi.clearAllMocks()
    sent.length = 0
    workspaceRows.byId.clear()
    workspaceRows.byId.set('ws-ok', {id: 'ws-ok', path: EXISTING_DIR})
    workspaceRows.byId.set('ws-nodir', {id: 'ws-nodir', path: MISSING_DIR})
    workspaceRows.listCalls.n = 0
    workspaceRows.getByIdCalls.n = 0
    workspaceRows.fault = null
    scheduleRepoStub.list.mockReturnValue([])
    scheduleRepoStub.listEnabled.mockReturnValue([])
    initScheduleIPC()
})

afterEach(() => {
    ;(schedulerManager as unknown as {worker: unknown}).worker = null
})

describe('判定函数：四态与边界（D1）', () => {
    it('null / undefined / 空串 / 全空白 都是「未设置」', () => {
        for (const v of [null, undefined, '', '   ']) {
            expect(checkScheduleWorkspace(v as string | null | undefined)).toEqual({
                state: 'unset', path: null, reason: '未设置项目',
            })
        }
    })

    it('workspaces 表查不到记录 → missing（不给路径）', () => {
        expect(checkScheduleWorkspace('ws-a0b1dd77-不存在')).toEqual({
            state: 'missing', path: null, reason: '项目已不存在',
        })
    })

    it('记录存在但磁盘上不是一个存在的目录 → unavailable（附路径）', () => {
        expect(checkScheduleWorkspace('ws-nodir')).toEqual({
            state: 'unavailable', path: MISSING_DIR, reason: `项目不可用（${MISSING_DIR}）`,
        })
    })

    it('记录存在且目录真实存在 → ok', () => {
        expect(checkScheduleWorkspace('ws-ok')).toEqual({state: 'ok', path: EXISTING_DIR, reason: null})
    })

    it('记录存在但 path 指向的是**文件**而不是目录 → unavailable（可注入边界）', () => {
        const health = checkScheduleWorkspace('ws-any', {
            findWorkspace: () => ({path: 'C:/some/file.txt'}),
            isDirectory: () => false,
        })
        expect(health.state).toBe('unavailable')
        expect(health.reason).toContain('C:/some/file.txt')
    })

    it('查记录本身抛异常 → unavailable（读失败不是「记录不存在」），文案不写「项目已不存在」', () => {
        const health = checkScheduleWorkspace('ws-x', {
            findWorkspace: () => { throw new Error('db closed') },
            isDirectory: () => true,
        })
        // 拦下的方向不变，改的是归因：故障 ⇒ unavailable
        expect(health.state).toBe('unavailable')
        expect(health.path).toBeNull()
        expect(health.reason).toContain('db closed')
        expect(health.reason).not.toContain('项目已不存在')
    })

    it('仓储读取故障（窄出口报 fault）经默认 deps 判成 unavailable，而不是 missing', () => {
        // 记录本来存在、目录也真的存在 —— 坏的是读这一次
        workspaceRows.fault = new Error('SQLITE_BUSY: database is locked')
        const health = checkScheduleWorkspace('ws-ok')

        expect(health.state).toBe('unavailable')
        expect(health.reason).toContain('SQLITE_BUSY')
        expect(health.reason).not.toContain('项目已不存在')
    })

    it('对照：库正常时四态判定一字不变（故障归因没有误伤正常路径）', () => {
        expect(checkScheduleWorkspace('ws-ok')).toEqual({state: 'ok', path: EXISTING_DIR, reason: null})
        expect(checkScheduleWorkspace('ws-nodir')).toEqual({
            state: 'unavailable', path: MISSING_DIR, reason: `项目不可用（${MISSING_DIR}）`,
        })
        // 只有「库里确实没有这条记录」才叫 missing，文案保持原样
        expect(checkScheduleWorkspace('ws-gone')).toEqual({
            state: 'missing', path: null, reason: '项目已不存在',
        })
        expect(checkScheduleWorkspace(null)).toEqual({
            state: 'unset', path: null, reason: '未设置项目',
        })
    })
})

describe('executeSchedule 拦截：三态都不执行、都记一次失败', () => {
    it.each([
        ['unset', null, '未设置项目'],
        ['missing', 'ws-a0b1dd77-不存在', '项目已不存在'],
        ['unavailable', 'ws-nodir', `项目不可用（${MISSING_DIR}）`],
    ])('%s：不跑、写 failure、cron 仍收到 ack', async (_label, workspaceId, expectedError) => {
        scheduleRepoStub.get.mockReturnValue(recordOf({id: 'sched-1', taskType: 'script', workspaceId: workspaceId as string | null}))
        const worker = spawnFakeWorker()

        const result = await execute({scheduleId: 'sched-1', taskType: 'script', source: 'cron'})

        // 返回可读原因
        expect(result).toEqual({success: false, error: expectedError})
        // 没跑
        expect(startAgentCoreStub).not.toHaveBeenCalled()
        expect(convRepoStub.create).not.toHaveBeenCalled()
        // 记了一次失败，且**没有** running / success 的写入
        expect(scheduleRepoStub.updateRunStatus.mock.calls).toEqual([['sched-1', 'failure']])
        // 不改任务状态：绝不写 enabled / paused（仓储的 update 根本没被调用）
        expect(scheduleRepoStub.update).not.toHaveBeenCalled()
        // cron 路径被拦下也必须先认领本轮触发 —— 否则引擎的待确认去重会卡住这条任务
        expect(acks(worker.posted)).toEqual([{cmd: 'ack', scheduleId: 'sched-1'}])
        // 拦截原因写进日志（可排查）
        expect(loggerStub.warn).toHaveBeenCalledWith(
            'execute.workspaceBlocked',
            expect.objectContaining({scheduleId: 'sched-1', reason: expectedError}),
        )
    })

    it('仓储故障：照旧拦下（保守方向不变），但原因指向读失败而非「项目已不存在」', async () => {
        scheduleRepoStub.get.mockReturnValue(recordOf({id: 'sched-fault', taskType: 'script', workspaceId: 'ws-ok'}))
        workspaceRows.fault = new Error('SQLITE_BUSY: database is locked')
        const worker = spawnFakeWorker()

        const result = await execute({scheduleId: 'sched-fault', taskType: 'script', source: 'cron'})

        expect(result.success).toBe(false)
        expect(result.error).not.toContain('项目已不存在')
        expect(result.error).toContain('SQLITE_BUSY')
        // 多拦不漏放：故障仍然拦住执行、仍然记一次失败、cron 仍然被 ack
        expect(startAgentCoreStub).not.toHaveBeenCalled()
        expect(scheduleRepoStub.updateRunStatus.mock.calls).toEqual([['sched-fault', 'failure']])
        expect(acks(worker.posted)).toEqual([{cmd: 'ack', scheduleId: 'sched-fault'}])
        expect(loggerStub.warn).toHaveBeenCalledWith(
            'execute.workspaceBlocked',
            expect.objectContaining({scheduleId: 'sched-fault', state: 'unavailable'}),
        )
    })

    it('被拦下的失败会广播 updated（列表行据此就地刷新，不需要整表重取）', async () => {
        scheduleRepoStub.get.mockReturnValue(recordOf({id: 'sched-1', workspaceId: null}))
        scheduleRepoStub.updateRunStatus.mockImplementation(() => undefined)
        scheduleRepoStub.get.mockImplementation((id: string) =>
            recordOf({id, workspaceId: null, lastRunStatus: 'failure'}))

        await execute({scheduleId: 'sched-1'})

        expect(sent).toEqual([{
            channel: 'schedules-changed',
            payload: {type: 'updated', record: recordOf({id: 'sched-1', workspaceId: null, lastRunStatus: 'failure'})},
        }])
    })

    it('ok 路径行为不变：照常执行并记 success', async () => {
        scheduleRepoStub.get.mockReturnValue(recordOf({id: 'sched-ok', taskType: 'agent', workspaceId: 'ws-ok'}))
        const worker = spawnFakeWorker()

        const result = await execute({scheduleId: 'sched-ok', taskType: 'agent', source: 'cron'})

        expect(result).toEqual({success: true})
        expect(startAgentCoreStub).toHaveBeenCalledTimes(1)
        expect(convRepoStub.create).toHaveBeenCalledTimes(1)
        expect(scheduleRepoStub.updateRunStatus.mock.calls).toEqual([
            ['sched-ok', 'running'],
            ['sched-ok', 'success'],
        ])
        expect(acks(worker.posted)).toEqual([{cmd: 'ack', scheduleId: 'sched-ok'}])
    })

    it('worker 的 task_fire 真实路径上同样被拦：ack 仍在、不跑', async () => {
        scheduleRepoStub.get.mockReturnValue(recordOf({id: 'sched-fire', workspaceId: null}))
        const worker = spawnFakeWorker()

        worker.handlers.message({type: 'task_fire', scheduleId: 'sched-fire', taskType: 'script', taskTarget: 'x', taskArgs: []})

        await vi.waitFor(() => {
            expect(scheduleRepoStub.updateRunStatus.mock.calls).toEqual([['sched-fire', 'failure']])
        })
        expect(acks(worker.posted)).toEqual([{cmd: 'ack', scheduleId: 'sched-fire'}])
        expect(startAgentCoreStub).not.toHaveBeenCalled()
    })

    it('任务记录已不存在时按「未设置」拦下，不会退化成在兜底目录里跑', async () => {
        scheduleRepoStub.get.mockReturnValue(null)
        const result = await execute({scheduleId: 'sched-deleted'})
        expect(result).toEqual({success: false, error: '未设置项目'})
        expect(startAgentCoreStub).not.toHaveBeenCalled()
    })
})

describe('手动入口：两个出口都返回可读错误（D2）', () => {
    it('runNow：项目不可用 → {success:false,error}，且不写运行状态', async () => {
        scheduleRepoStub.get.mockReturnValue(recordOf({id: 's-missing', workspaceId: 'ws-a0b1dd77-不存在'}))
        const worker = spawnFakeWorker()

        const result = await schedulerManager.runNow('s-missing')

        expect(result).toEqual({success: false, error: '项目已不存在'})
        expect(scheduleRepoStub.updateRunStatus).not.toHaveBeenCalled()
        expect(startAgentCoreStub).not.toHaveBeenCalled()
        // 手动路径不碰引擎的去重状态
        expect(acks(worker.posted)).toEqual([])
        expect(loggerStub.warn).toHaveBeenCalledWith(
            'runNow.workspaceBlocked',
            expect.objectContaining({id: 's-missing', state: 'missing'}),
        )
    })

    it('runNow：未设置项目 → 明确原因', async () => {
        scheduleRepoStub.get.mockReturnValue(recordOf({id: 's-unset', workspaceId: null}))
        expect(await schedulerManager.runNow('s-unset')).toEqual({success: false, error: '未设置项目'})
    })

    it('runNowSchedule：同一个原因被拍成 {ok:false,error}', async () => {
        scheduleRepoStub.get.mockReturnValue(recordOf({id: 's-unset', workspaceId: null}))
        expect(await runNowSchedule('s-unset')).toEqual({ok: false, error: '未设置项目'})
    })

    it('runNowSchedule：ok 时照旧交给管理器执行', async () => {
        scheduleRepoStub.get.mockReturnValue(recordOf({id: 's-ok', taskType: 'agent', workspaceId: 'ws-ok'}))
        scheduleRepoStub.get.mockReturnValue(recordOf({id: 's-ok', taskType: 'agent', workspaceId: 'ws-ok'}))
        expect(await runNowSchedule('s-ok')).toEqual({ok: true, data: true})
        expect(startAgentCoreStub).toHaveBeenCalledTimes(1)
    })
})

describe('只读健康度出口（D3）', () => {
    it('workspaceHealthMap：每个任务 id → 它的四态', () => {
        scheduleRepoStub.list.mockReturnValue([
            recordOf({id: 'a', workspaceId: 'ws-ok'}),
            recordOf({id: 'b', workspaceId: null}),
            recordOf({id: 'c', workspaceId: 'ws-gone'}),
            recordOf({id: 'd', workspaceId: 'ws-nodir'}),
        ])

        const res = workspaceHealthMap()

        expect(res.ok).toBe(true)
        if (!res.ok) return
        expect(res.data.a.state).toBe('ok')
        expect(res.data.b.state).toBe('unset')
        expect(res.data.c.state).toBe('missing')
        expect(res.data.d.state).toBe('unavailable')
        expect(res.data.d.path).toBe(MISSING_DIR)
    })

    it('IPC 通道 scheduler-workspace-health 已注册且返回同一份真相', () => {
        scheduleRepoStub.list.mockReturnValue([recordOf({id: 'a', workspaceId: 'ws-ok'})])

        const handler = ipcHandlers.get('scheduler-workspace-health')
        expect(typeof handler).toBe('function')
        expect(handler!(null)).toEqual({ok: true, data: {a: {state: 'ok', path: EXISTING_DIR, reason: null}}})
    })
})

describe('守卫解析出的路径必须传下去，不能再有兜底目录（复核 S6）', () => {
    it('判定 ok 后创建的调度会话，其 workspacePath 就是守卫解析出的那个路径', async () => {
        scheduleRepoStub.get.mockReturnValue(recordOf({id: 's-ok', taskType: 'agent', workspaceId: 'ws-ok'}))
        const worker = spawnFakeWorker()

        const result = await execute({scheduleId: 's-ok', taskType: 'agent', source: 'cron'})

        expect(result).toEqual({success: true})
        expect(convRepoStub.create).toHaveBeenCalledTimes(1)
        const meta = convRepoStub.create.mock.calls[0][1] as {workspacePath: string}
        // 等于守卫解析出的路径（= 工作区记录里的 path）……
        expect(meta.workspacePath).toBe(EXISTING_DIR)
        // ……而不是那个会把会话建到 `~/.hclaw` 上的兜底目录（本票要修的原始症状）。
        // 本文件把 config 的 getHclawDir 指到独立临时目录，故两者可区分。
        expect(meta.workspacePath).not.toContain('hclaw-test-wsguard-')
        // 顺带钉住「没有再解析一次」：整条执行路径上只有**守卫那一次**单条查询，
        // 没有第二次（旧实现的 createSchedulerConversation 会再查一次并带兜底分支）
        expect(workspaceRows.getByIdCalls.n).toBe(1)
        expect(acks(worker.posted)).toEqual([{cmd: 'ack', scheduleId: 's-ok'}])
    })
})

describe('健康度 sweep 的成本口径（复核 S5）', () => {
    it('一次 sweep：整表只查一次、单条 getById 一次都不查', () => {
        // 9 个任务共享少量工作区；「未设置」的任务不产生任何目录判定
        scheduleRepoStub.list.mockReturnValue([
            recordOf({id: 'a', workspaceId: 'ws-ok'}),
            recordOf({id: 'b', workspaceId: 'ws-ok'}),
            recordOf({id: 'c', workspaceId: 'ws-nodir'}),
            recordOf({id: 'd', workspaceId: 'ws-nodir'}),
            recordOf({id: 'e', workspaceId: 'ws-alias'}),   // 与 ws-ok 同一路径
            recordOf({id: 'f', workspaceId: null}),
            recordOf({id: 'g', workspaceId: 'ws-gone'}),
            recordOf({id: 'h', workspaceId: ''}),
            recordOf({id: 'i', workspaceId: '   '}),
        ])
        workspaceRows.byId.set('ws-alias', {id: 'ws-alias', path: EXISTING_DIR})

        const res = workspaceHealthMap()

        expect(res.ok).toBe(true)
        if (!res.ok) return
        expect(res.data.a.state).toBe('ok')
        expect(res.data.e.state).toBe('ok')
        expect(res.data.c.state).toBe('unavailable')
        expect(res.data.f.state).toBe('unset')
        expect(res.data.g.state).toBe('missing')
        expect(res.data.i.state).toBe('unset')

        // 一次整表查询；**零**次单条 getById（旧实现是每个任务一次）
        expect(workspaceRows.listCalls.n).toBe(1)
        expect(workspaceRows.getByIdCalls.n).toBe(0)
    })

    it('一批任务里同一工作区被反复引用时，目录判定按路径记忆化（stat 次数 = 不同路径数）', () => {
        const seen: string[] = []
        const healths = sweepWorkspaceHealth(
            ['ws-ok', 'ws-ok', 'ws-ok', 'ws-nodir', 'ws-nodir', null, ''],
            {
                listWorkspaces: () => [
                    {id: 'ws-ok', path: 'E:/same'},
                    {id: 'ws-nodir', path: 'E:/gone'},
                ],
                isDirectory: (p: string) => { seen.push(p); return p === 'E:/same' },
            },
        )

        // 7 个任务只做 2 次目录判定（不同路径数），不是 7 次
        expect(seen).toEqual(['E:/same', 'E:/gone'])
        expect(healths.map(h => h.state)).toEqual(['ok', 'ok', 'ok', 'unavailable', 'unavailable', 'unset', 'unset'])
    })

    it('整表读取失败：不静默按「全部可用」放行，判成 unavailable 并说明读失败（不是 missing）', () => {
        const healths = sweepWorkspaceHealth(['ws-any'], {
            listWorkspaces: () => { throw new Error('db closed') },
            isDirectory: () => true,
        })

        expect(healths[0].state).toBe('unavailable')
        expect(healths[0].path).toBeNull()
        expect(healths[0].reason).toContain('db closed')
        expect(healths[0].reason).not.toContain('项目已不存在')
    })

    it('库读故障时健康度出口不再把满列表集体标成 missing（票面症状：同时标红）', () => {
        scheduleRepoStub.list.mockReturnValue([
            recordOf({id: 'a', workspaceId: 'ws-ok'}),
            recordOf({id: 'b', workspaceId: 'ws-nodir'}),
        ])
        workspaceRows.fault = new Error('db closed')

        const res = workspaceHealthMap()

        expect(res.ok).toBe(true)
        if (!res.ok) return
        // 两条都不是「记录不存在」，而是「这次读不到库」
        expect(res.data.a.state).toBe('unavailable')
        expect(res.data.b.state).toBe('unavailable')
        expect(res.data.a.reason).not.toContain('项目已不存在')
        expect(res.data.b.reason).not.toContain('项目已不存在')
    })
})
