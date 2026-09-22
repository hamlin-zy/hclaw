/**
 * 记忆沉淀前置探针 —— 「有没有待沉淀的新会话」的本地判定。
 *
 * 动机（token 经济性）：`sys-memory-accumulation` 原本每轮都新建独立会话、
 * 让 LLM 自己查库后退出。无待办时这一整轮是空转（约 16k input + 数轮循环）。
 * 把同一个判定前置到主进程的本地 SQL：无待办 → 调用方直接短路，不建会话、
 * 不进 LLM、零 token。
 *
 * ⚠️ **本判定口径与 `src/main/agent/defaults/systemSchedules.ts` 里
 * MEMORY_ACCUMULATION_PROMPT 的「步骤 1：查询新会话（带冷却期）」同源**
 * （时间窗 + IFNULL(channel) 排除 + 30 分钟冷却期三件事必须一致）。
 * 改一处必须同步另一处：口径分叉会导致「探针说没活、LLM 查完发现有活」
 * 或反过来的静默漏沉淀。
 *
 * fail-open：任何异常（状态文件读不出、数据库抖动）一律返回 true（放行），
 * 退回无探针时的行为 —— 探针坏掉不该把记忆沉淀整体静默停掉。
 *
 * 依赖约束：本模块只在主进程使用（不在 cron worker 的静态依赖闭包内），
 * 可自由依赖 DB / fs / hclawPaths。
 */
import fs from 'fs'
import {join} from 'path'
import {getMemDir} from '../agent/memory/memoryLoader'
import {getHclawDir} from '../hclawPaths'
import {getDatabase} from '../repositories/sqlite'

/** 冷却期：最近 30 分钟内仍有更新的会话可能正在运行，半成品摘要不是终稿 */
export const MEMORY_COOLDOWN_MS = 30 * 60 * 1000

/**
 * 读 mem/.state.json 原文，解析 lastAnalyzedAt；文件缺失/JSON 损坏/字段非有限数 → 返回 0。
 *
 * 0 表示「分析全部历史」（与 prompt 里「文件不存在则 lastAnalyzedAt 设为 0」同源）。
 */
export function readLastAnalyzedAt(raw: string | null): number {
  if (!raw) return 0
  try {
    const parsed = JSON.parse(raw) as {lastAnalyzedAt?: unknown}
    const value = parsed?.lastAnalyzedAt
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
  } catch {
    return 0
  }
}

/** 依赖注入点，便于单测 */
export interface MemoryProbeDeps {
  readStateFile: (filePath: string) => string | null   // 默认 fs.readFileSync(filePath,'utf8')，任何异常返回 null
  countPending: (lastAnalyzedAt: number, cooldownCutoff: number) => number
}

/** 默认实现：读状态文件；任何异常（不存在 / 无权限）返回 null */
function defaultReadStateFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
}

/**
 * 默认实现：数「窗口内且非定时任务自身产生」的会话。
 *
 * 参数顺序 lastAnalyzedAt → cooldownCutoff，与 SQL 里的两个 `?` 一一对应。
 * IFNULL 必须有：meta 无 channel 键时 json_extract 返回 NULL，`NULL != 'schedule'`
 * 结果为 NULL（非真），会把这类行全部漏掉 —— 而绝大多数会话正属于这一类。
 */
function defaultCountPending(lastAnalyzedAt: number, cooldownCutoff: number): number {
  const row = getDatabase().prepare(
    `SELECT COUNT(*) AS n FROM conversations
WHERE updated_at > ?
  AND updated_at < ?
  AND IFNULL(json_extract(meta, '$.channel'), '') != 'schedule'`,
  ).get(lastAnalyzedAt, cooldownCutoff) as {n?: unknown} | undefined
  const n = row?.n
  return typeof n === 'number' && Number.isFinite(n) ? n : 0
}

const defaultDeps: MemoryProbeDeps = {
  readStateFile: defaultReadStateFile,
  countPending: defaultCountPending,
}

/**
 * true = 有待办（放行）；false = 无待办（跳过）。任何异常一律返回 true（fail-open）。
 */
export function hasPendingConversations(now: number, deps?: Partial<MemoryProbeDeps>): boolean {
  try {
    const readStateFile = deps?.readStateFile ?? defaultDeps.readStateFile
    const countPending = deps?.countPending ?? defaultDeps.countPending

    const stateFile = join(getMemDir(getHclawDir()), '.state.json')
    const rawLast = readLastAnalyzedAt(readStateFile(stateFile))
    // 未来时间戳（state 被写坏）会让窗口恒空 → 探针永久判「无待办」→ 任务静默停摆且永不进 LLM 自愈。
    // 钳到 0 = 全量重扫：多花一次运行的钱，换自愈（LLM 步骤 8 会写回正确值）。方向与 fail-open 一致。
    const lastAnalyzedAt = rawLast > now ? 0 : rawLast
    const cooldownCutoff = now - MEMORY_COOLDOWN_MS

    return countPending(lastAnalyzedAt, cooldownCutoff) > 0
  } catch {
    // fail-open：探针故障不放行判断权，退回无探针时的行为（照常执行一轮）
    return true
  }
}
