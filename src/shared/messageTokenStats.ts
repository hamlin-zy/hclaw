/**
 * 会话消息 token 统计（纯函数，零 electron 依赖）
 *
 * 从 CacheRateTooltip 的 stats 计算逻辑提取而来，口径不变：
 * - 累计值 = 所有 assistant 消息的 llmStats 求和
 * - 当前值 = 遍历顺序中最后一条 llmStats 的对应字段
 * - lastTimedStats = 最后一条携带 ttftMs 的 llmStats（末次吞吐口径，见字段注释）
 *
 * computeMessageTokenStatsByModel：按「服务商 + 模型」分组（徽章卡片模型切换视图的数据源），
 * 每组口径与全局一致，另记录该模型末次使用时间供排序。
 */
import type {LlmStats, Message} from './types'

export interface MessageTokenStats {
  requestCount: number
  toolCallCount: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  /** 累计解码时长（毫秒），平均吞吐 = Σoutput ÷ ΣdecodeMs */
  totalDecodeMs: number
  /** 累计首字延迟（毫秒），平均首字 = totalTtftMs ÷ ttftCount */
  totalTtftMs: number
  /** 携带首字延迟的 LLM 调用数（旧数据无 ttftMs 不计入） */
  ttftCount: number
  currentInputTokens: number
  currentOutputTokens: number
  currentCacheReadTokens: number
  /** 末次请求解码时长（毫秒），末次吞吐 = 末次 output ÷ 末次 decodeMs */
  currentDecodeMs: number
  /** 末次请求是否携带首字延迟（旧数据无 ttftMs 时末次吞吐/首字显示 —） */
  currentHasTtft: boolean
  /** 末次吞吐口径：最后一条携带文本解码时序（ttftMs）的 llmStats。
   *  纯工具调用轮次（仅 tool_use，无 text/thinking/reasoning 输出）在 execute.ts 中
   *  firstTokenTime 从未设置 → ttftMs/decodeMs 缺失，若其覆盖末次时序（currentHasTtft）
   *  会导致 InputArea 下方 t/s 徽章按"无时序数据"隐藏；回退到上一个有文本解码的请求。
   *  无任何带时序的请求时为 null。 */
  lastTimedStats: {outputTokens: number; decodeMs: number} | null
}

/** 单模型统计聚合累加器（computeMessageTokenStats / computeMessageTokenStatsByModel 共用） */
interface TokenStatsAccumulator {
  requestCount: number
  toolCallCount: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalDecodeMs: number
  totalTtftMs: number
  ttftCount: number
  currentInputTokens: number
  currentOutputTokens: number
  currentCacheReadTokens: number
  currentDecodeMs: number
  currentHasTtft: boolean
  lastTimedStats: {outputTokens: number; decodeMs: number} | null
  /** 该组所属消息 timestamp 的最大值（末次使用时间，供模型列表排序） */
  lastUsedAt: number
}

function createAccumulator(): TokenStatsAccumulator {
  return {
    requestCount: 0,
    toolCallCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalDecodeMs: 0,
    totalTtftMs: 0,
    ttftCount: 0,
    currentInputTokens: 0,
    currentOutputTokens: 0,
    currentCacheReadTokens: 0,
    currentDecodeMs: 0,
    currentHasTtft: false,
    lastTimedStats: null,
    lastUsedAt: 0,
  }
}

/** 累加一条 llmStats：累计求和；当前值覆盖为最后一条；末次吞吐口径 = 最后一条携带 ttftMs 的 llmStats */
function accumulateLlmStats(acc: TokenStatsAccumulator, s: LlmStats): void {
  acc.requestCount += 1
  acc.totalInputTokens += s.inputTokens || 0
  acc.totalOutputTokens += s.outputTokens || 0
  acc.totalCacheReadTokens += s.cacheReadTokens || 0
  acc.totalDecodeMs += s.decodeMs || 0
  if (typeof s.ttftMs === 'number') {
    acc.totalTtftMs += s.ttftMs
    acc.ttftCount += 1
    // 末次吞吐口径 = 最后一条携带 ttftMs 的 llmStats（纯工具轮次无文本解码，
    // ttftMs 缺失，不覆盖，避免 t/s 徽章消失）
    acc.lastTimedStats = {outputTokens: s.outputTokens || 0, decodeMs: s.decodeMs || 0}
  }
  // 末次值 = 最后一条 llmStats 覆盖（输入/缓存/时序字段原始语义不变）
  acc.currentInputTokens = s.inputTokens || 0
  acc.currentOutputTokens = s.outputTokens || 0
  acc.currentCacheReadTokens = s.cacheReadTokens || 0
  acc.currentDecodeMs = s.decodeMs || 0
  acc.currentHasTtft = typeof s.ttftMs === 'number'
}

function toStats(acc: TokenStatsAccumulator): MessageTokenStats {
  return {
    requestCount: acc.requestCount,
    toolCallCount: acc.toolCallCount,
    totalInputTokens: acc.totalInputTokens,
    totalOutputTokens: acc.totalOutputTokens,
    totalCacheReadTokens: acc.totalCacheReadTokens,
    totalDecodeMs: acc.totalDecodeMs,
    totalTtftMs: acc.totalTtftMs,
    ttftCount: acc.ttftCount,
    currentInputTokens: acc.currentInputTokens,
    currentOutputTokens: acc.currentOutputTokens,
    currentCacheReadTokens: acc.currentCacheReadTokens,
    currentDecodeMs: acc.currentDecodeMs,
    currentHasTtft: acc.currentHasTtft,
    lastTimedStats: acc.lastTimedStats,
  }
}

export function computeMessageTokenStats(messages: Message[]): MessageTokenStats {
  const acc = createAccumulator()
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    const statsList: LlmStats[] = Array.isArray(msg.llmStats) ? msg.llmStats : []
    for (const s of statsList) {
      accumulateLlmStats(acc, s)
    }
    if (msg.toolCalls?.length) {
      acc.toolCallCount += msg.toolCalls.length
    }
  }
  return toStats(acc)
}

/** 模型统计条目（computeMessageTokenStatsByModel 输出） */
export interface ModelTokenStatsEntry {
  /** 分组键 = 服务商名（缺失回退类型名）+ 模型名，不同服务商同名模型靠此区分 */
  key: string
  /** 服务商显示名（providerName 缺失时回退 provider 类型名） */
  providerName: string
  /** 模型名（llmStats.model，与 providers.models[].name 同口径） */
  model: string
  /** 该模型末次使用时间（所属消息 timestamp 的最大值，供列表排序） */
  lastUsedAt: number
  stats: MessageTokenStats
}

/** 模型统计分组键：providerName 缺失回退 provider 类型名；空模型名保留空串 */
export function llmStatsModelKey(s: Pick<LlmStats, 'provider' | 'providerName' | 'model'>): string {
  return `${s.providerName || s.provider}\u0000${s.model || ''}`
}

/**
 * 按「服务商 + 模型」分组统计（与 computeMessageTokenStats 同口径，仅限定到单模型）：
 * - 每组累计/当前/末次时序口径与全局一致
 * - 工具调用数归入该消息最后一条 llmStats 所属模型组（消息级归属，与轮次语义一致）
 * - 末次使用时间 = 该组所属消息 timestamp 的最大值
 * - 返回按末次使用时间倒序
 */
export function computeMessageTokenStatsByModel(messages: Message[]): ModelTokenStatsEntry[] {
  const accs = new Map<string, TokenStatsAccumulator>()
  const meta = new Map<string, {providerName: string; model: string}>()

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    const statsList: LlmStats[] = Array.isArray(msg.llmStats) ? msg.llmStats : []
    if (statsList.length === 0) continue

    for (const s of statsList) {
      const key = llmStatsModelKey(s)
      let acc = accs.get(key)
      if (!acc) {
        acc = createAccumulator()
        accs.set(key, acc)
        meta.set(key, {providerName: s.providerName || s.provider, model: s.model || ''})
      }
      accumulateLlmStats(acc, s)
      if (msg.timestamp > acc.lastUsedAt) acc.lastUsedAt = msg.timestamp
    }

    // 工具调用归属：归入该消息最后一次 LLM 调用的模型组
    if (msg.toolCalls?.length) {
      const last = statsList[statsList.length - 1]
      const acc = accs.get(llmStatsModelKey(last))
      if (acc) acc.toolCallCount += msg.toolCalls.length
    }
  }

  const entries: ModelTokenStatsEntry[] = []
  for (const [key, acc] of accs) {
    const m = meta.get(key)!
    entries.push({
      key,
      providerName: m.providerName,
      model: m.model,
      lastUsedAt: acc.lastUsedAt,
      stats: toStats(acc),
    })
  }
  entries.sort((a, b) => b.lastUsedAt - a.lastUsedAt)
  return entries
}

/** 窗口使用率：window=0 → 0；>100 → 封顶 100；否则整数百分比 */
export function computeUsagePct(numerator: number, window: number): number {
  if (window <= 0) return 0
  return Math.min(100, Math.round((numerator / window) * 100))
}
