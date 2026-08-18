/**
 * 会话消息 token 统计（纯函数，零 electron 依赖）
 *
 * 从 CacheRateTooltip 的 stats 计算逻辑提取而来，口径不变：
 * - 累计值 = 所有 assistant 消息的 llmStats 求和
 * - 当前值 = 遍历顺序中最后一条 llmStats 的对应字段
 * - lastTimedStats = 最后一条携带 ttftMs 的 llmStats（末次吞吐口径，见字段注释）
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

export function computeMessageTokenStats(messages: Message[]): MessageTokenStats {
  let requestCount = 0
  let toolCallCount = 0
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCacheReadTokens = 0
  let totalDecodeMs = 0
  let totalTtftMs = 0
  let ttftCount = 0
  let currentInputTokens = 0
  let currentOutputTokens = 0
  let currentCacheReadTokens = 0
  let currentDecodeMs = 0
  let currentHasTtft = false
  let lastTimedStats: {outputTokens: number; decodeMs: number} | null = null

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    const statsList: LlmStats[] = Array.isArray(msg.llmStats) ? msg.llmStats : []
    requestCount += statsList.length
    for (const s of statsList) {
      totalInputTokens += s.inputTokens || 0
      totalOutputTokens += s.outputTokens || 0
      totalCacheReadTokens += s.cacheReadTokens || 0
      totalDecodeMs += s.decodeMs || 0
      if (typeof s.ttftMs === 'number') {
        totalTtftMs += s.ttftMs
        ttftCount += 1
        // 末次吞吐口径 = 最后一条携带 ttftMs 的 llmStats（纯工具轮次无文本解码，
        // ttftMs 缺失，不覆盖，避免 t/s 徽章消失）
        lastTimedStats = {outputTokens: s.outputTokens || 0, decodeMs: s.decodeMs || 0}
      }
      // 末次值 = 最后一条 llmStats 覆盖（输入/缓存/时序字段原始语义不变）
      currentInputTokens = s.inputTokens || 0
      currentOutputTokens = s.outputTokens || 0
      currentCacheReadTokens = s.cacheReadTokens || 0
      currentDecodeMs = s.decodeMs || 0
      currentHasTtft = typeof s.ttftMs === 'number'
    }
    if (msg.toolCalls?.length) {
      toolCallCount += msg.toolCalls.length
    }
  }

  return {
    requestCount,
    toolCallCount,
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadTokens,
    totalDecodeMs,
    totalTtftMs,
    ttftCount,
    currentInputTokens,
    currentOutputTokens,
    currentCacheReadTokens,
    currentDecodeMs,
    currentHasTtft,
    lastTimedStats,
  }
}

/** 窗口使用率：window=0 → 0；>100 → 封顶 100；否则整数百分比 */
export function computeUsagePct(numerator: number, window: number): number {
  if (window <= 0) return 0
  return Math.min(100, Math.round((numerator / window) * 100))
}
