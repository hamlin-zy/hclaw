/**
 * 会话消息 token 统计（纯函数，零 electron 依赖）
 *
 * 从 CacheRateTooltip 的 stats 计算逻辑提取而来，口径不变：
 * - 累计值 = 所有 assistant 消息的 llmStats 求和
 * - 当前值 = 遍历顺序中最后一条 llmStats 的对应字段
 */
import type {Message} from './types'

export interface MessageTokenStats {
  requestCount: number
  toolCallCount: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  currentInputTokens: number
  currentOutputTokens: number
  currentCacheReadTokens: number
}

export function computeMessageTokenStats(messages: Message[]): MessageTokenStats {
  let requestCount = 0
  let toolCallCount = 0
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCacheReadTokens = 0
  let currentInputTokens = 0
  let currentOutputTokens = 0
  let currentCacheReadTokens = 0

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    const statsList = Array.isArray(msg.llmStats) ? msg.llmStats : []
    requestCount += statsList.length
    for (const s of statsList) {
      totalInputTokens += s.inputTokens || 0
      totalOutputTokens += s.outputTokens || 0
      totalCacheReadTokens += s.cacheReadTokens || 0
      currentInputTokens = s.inputTokens || 0
      currentOutputTokens = s.outputTokens || 0
      currentCacheReadTokens = s.cacheReadTokens || 0
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
    currentInputTokens,
    currentOutputTokens,
    currentCacheReadTokens,
  }
}

/** 窗口使用率：window=0 → 0；>100 → 封顶 100；否则整数百分比 */
export function computeUsagePct(numerator: number, window: number): number {
  if (window <= 0) return 0
  return Math.min(100, Math.round((numerator / window) * 100))
}
