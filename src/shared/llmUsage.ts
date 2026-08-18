/**
 * LLM 用量纯函数（零 electron 依赖，三端可复用）
 *
 * - toLlmUsageRecord：llm_call_done 事件 → llm_usage 表行（幂等 ID = usage_<messageId>_<seq>）
 * - timeRangeStartMs：时间范围 → 过滤起点（'all' → null）
 */
import type {LlmUsageRecord, TimeRange} from './types'

/** llm_call_done 事件的用量字段（结构化子集，避免 shared → main 依赖） */
export interface LlmUsageEventSource {
  providerType: string
  /** providers 表服务商名（providers.name），历史数据可空 */
  providerName?: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  ttftMs?: number
  decodeMs?: number
  duration: number
}

export function toLlmUsageRecord(
  event: LlmUsageEventSource,
  ctx: {conversationId: string; messageId: string; seq: number; createdAt?: number},
): LlmUsageRecord {
  return {
    id: `usage_${ctx.messageId}_${ctx.seq}`,
    conversationId: ctx.conversationId,
    messageId: ctx.messageId,
    providerType: event.providerType,
    providerName: event.providerName,
    model: event.model,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cacheReadTokens: event.cacheReadTokens ?? 0,
    cacheWriteTokens: event.cacheWriteTokens ?? 0,
    reasoningTokens: event.reasoningTokens ?? 0,
    ttftMs: event.ttftMs,
    decodeMs: event.decodeMs,
    durationMs: event.duration,
    createdAt: ctx.createdAt ?? Date.now(),
  }
}

/** 时间范围起点（毫秒）；'all' → null（不过滤） */
export function timeRangeStartMs(range: TimeRange, now: number = Date.now()): number | null {
  if (range === 'all') return null
  if (range === 'today') {
    const d = new Date(now)
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  }
  const ms: Record<'7d' | '30d', number> = {
    '7d': 7 * 24 * 3600 * 1000,
    '30d': 30 * 24 * 3600 * 1000,
  }
  return now - ms[range as '7d' | '30d']
}

/** 价格源（美元/token；0 = 未知/未匹配） */
export interface PriceSource {
  inputPrice: number
  outputPrice: number
  cacheReadPrice: number
}

/** 成本 = 实时价格 × token（美元）；未定价（价格 0）→ 0 */
export function computeUsageCost(
  row: {model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number},
  getMeta: (model: string) => PriceSource,
): number {
  const p = getMeta(row.model)
  return row.inputTokens * p.inputPrice
       + row.outputTokens * p.outputPrice
       + row.cacheReadTokens * p.cacheReadPrice
}
