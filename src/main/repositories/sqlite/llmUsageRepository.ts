/**
 * llm_usage 表 Repository（token 用量唯一数据源）
 *
 * - record：单条写入（INSERT OR IGNORE 幂等）
 * - queryAggregated：全局聚合。成本在模型粒度用注入的 getMeta 计算后，
 *   view='provider' 时按服务商合并（成本求和），保证成本按模型单价准确
 * - queryTrend：按天趋势
 * - queryByConversation：会话弹窗分组（WHERE conversation_id IN (...)）
 */
import {getDatabase} from './index'
import {timeRangeStartMs, computeUsageCost, type PriceSource} from '@shared/llmUsage'
import type {LlmUsageRecord, UsageBreakdown, TrendPoint, TimeRange} from '@shared/types'
import {createQueryLogger} from './queryLogger'

const logQuery = createQueryLogger('SQLite LlmUsageRepository')

interface ModelAggRow {
  provider_type: string
  model: string
  /** 组内取非 NULL 的服务商名（providers.name，历史行可空） */
  provider_name: string | null
  request_count: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  total_tokens: number
  /** 组内累计纯解码时长（全 NULL 时为 null） */
  decode_ms: number | null
  /** 组内累计首字延迟（全 NULL 时为 null） */
  ttft_ms: number | null
  /** 组内携带首字延迟的调用数（COUNT 忽略 NULL） */
  ttft_count: number
}

export class SqliteLlmUsageRepository {
  /** 单条写入（幂等：同 id 静默跳过）；外键/约束错误向上抛出（调用方/测试可感知） */
  record(record: LlmUsageRecord): void {
    const start = Date.now()
    const db = getDatabase()
    db.prepare(`INSERT OR IGNORE INTO llm_usage (
      id, conversation_id, message_id, provider_type, model, provider_name,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
      ttft_ms, decode_ms, duration_ms, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      record.id, record.conversationId, record.messageId, record.providerType, record.model,
      record.providerName ?? null,
      record.inputTokens, record.outputTokens, record.cacheReadTokens, record.cacheWriteTokens, record.reasoningTokens,
      record.ttftMs ?? null, record.decodeMs ?? null, record.durationMs, record.createdAt,
    )
    logQuery('record', start, record.id)
  }

  /** 全局聚合（成本在模型粒度计算，view='provider' 时按服务商合并） */
  queryAggregated(params: {range: TimeRange; view: 'provider' | 'model'}, getMeta: (model: string) => PriceSource): UsageBreakdown[] {
    const start = Date.now()
    try {
      const db = getDatabase()
      const rangeStart = timeRangeStartMs(params.range)
      const rows = db.prepare(`
        SELECT provider_type, model,
               MAX(provider_name) AS provider_name,
               COUNT(*) AS request_count,
               SUM(input_tokens) AS input_tokens,
               SUM(output_tokens) AS output_tokens,
               SUM(cache_read_tokens) AS cache_read_tokens,
               SUM(cache_write_tokens) AS cache_write_tokens,
               SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS total_tokens,
               SUM(decode_ms) AS decode_ms,
               SUM(ttft_ms) AS ttft_ms,
               COUNT(ttft_ms) AS ttft_count
        FROM llm_usage
        WHERE (? IS NULL OR created_at >= ?)
        GROUP BY provider_type, model
      `).all(rangeStart, rangeStart) as ModelAggRow[]

      const breakdowns = rows.map((r) => this.toModelBreakdown(r, getMeta))
      breakdowns.sort((a, b) => b.totalTokens - a.totalTokens)
      logQuery('queryAggregated', start, `${breakdowns.length} rows`)
      return params.view === 'provider' ? this.mergeByProvider(breakdowns) : breakdowns
    } catch (err) {
      console.error('[SqliteLlmUsageRepository] queryAggregated failed:', err)
      return []
    }
  }

  /** 按天趋势 */
  queryTrend(params: {range: TimeRange}): TrendPoint[] {
    const start = Date.now()
    try {
      const db = getDatabase()
      const rangeStart = timeRangeStartMs(params.range)
      const rows = db.prepare(`
        SELECT date(created_at/1000, 'unixepoch', 'localtime') AS day,
               SUM(input_tokens) AS input_tokens,
               SUM(output_tokens) AS output_tokens,
               SUM(cache_read_tokens) AS cache_read_tokens
        FROM llm_usage
        WHERE (? IS NULL OR created_at >= ?)
        GROUP BY day
        ORDER BY day ASC
      `).all(rangeStart, rangeStart) as Array<{day: string; input_tokens: number; output_tokens: number; cache_read_tokens: number}>
      const trend = rows.map((r) => ({
        day: r.day,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        cacheReadTokens: r.cache_read_tokens,
      }))
      logQuery('queryTrend', start, `${trend.length} days`)
      return trend
    } catch (err) {
      console.error('[SqliteLlmUsageRepository] queryTrend failed:', err)
      return []
    }
  }

  /** 会话弹窗分组（模型粒度 + 成本；view='provider' 时合并） */
  queryByConversation(convIds: string[], view: 'provider' | 'model', getMeta: (model: string) => PriceSource): UsageBreakdown[] {
    if (convIds.length === 0) return []
    const start = Date.now()
    try {
      const db = getDatabase()
      const placeholders = convIds.map(() => '?').join(',')
      const rows = db.prepare(`
        SELECT provider_type, model,
               MAX(provider_name) AS provider_name,
               COUNT(*) AS request_count,
               SUM(input_tokens) AS input_tokens,
               SUM(output_tokens) AS output_tokens,
               SUM(cache_read_tokens) AS cache_read_tokens,
               SUM(cache_write_tokens) AS cache_write_tokens,
               SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS total_tokens,
               SUM(decode_ms) AS decode_ms,
               SUM(ttft_ms) AS ttft_ms,
               COUNT(ttft_ms) AS ttft_count
        FROM llm_usage
        WHERE conversation_id IN (${placeholders})
        GROUP BY provider_type, model
      `).all(...convIds) as ModelAggRow[]

      const breakdowns = rows.map((r) => this.toModelBreakdown(r, getMeta))
      logQuery('queryByConversation', start, `${breakdowns.length} rows`)
      return view === 'provider' ? this.mergeByProvider(breakdowns) : breakdowns
    } catch (err) {
      console.error('[SqliteLlmUsageRepository] queryByConversation failed:', err)
      return []
    }
  }

  /** 模型粒度行 → UsageBreakdown（含成本） */
  private toModelBreakdown(r: ModelAggRow, getMeta: (model: string) => PriceSource): UsageBreakdown {
    return {
      key: r.model,
      providerType: r.provider_type,
      providerName: r.provider_name ?? undefined,
      requestCount: r.request_count,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheReadTokens: r.cache_read_tokens,
      cacheWriteTokens: r.cache_write_tokens,
      totalTokens: r.total_tokens,
      // 显式传 camelCase 字段：ModelAggRow 为 snake_case，不能直接把 r 交给 computeUsageCost（按名读 row.inputTokens 会读到 undefined）
      costUsd: computeUsageCost(
        {model: r.model, inputTokens: r.input_tokens, outputTokens: r.output_tokens, cacheReadTokens: r.cache_read_tokens},
        getMeta,
      ),
      decodeMs: r.decode_ms ?? undefined,
      ttftMs: r.ttft_ms ?? undefined,
      ttftCount: r.ttft_count,
    }
  }

  /** 按服务商合并（成本求和，totalTokens 降序） */
  private mergeByProvider(rows: UsageBreakdown[]): UsageBreakdown[] {
    const map = new Map<string, UsageBreakdown>()
    for (const r of rows) {
      const key = r.providerType ?? 'unknown'
      const existing = map.get(key)
      if (existing) {
        existing.requestCount += r.requestCount
        existing.inputTokens += r.inputTokens
        existing.outputTokens += r.outputTokens
        existing.cacheReadTokens += r.cacheReadTokens
        existing.cacheWriteTokens += r.cacheWriteTokens
        existing.totalTokens += r.totalTokens
        existing.costUsd += r.costUsd
        // 时序字段按组累加（全组无时序数据时保持 undefined）
        existing.decodeMs = (existing.decodeMs ?? 0) + (r.decodeMs ?? 0) || undefined
        existing.ttftMs = (existing.ttftMs ?? 0) + (r.ttftMs ?? 0) || undefined
        existing.ttftCount = (existing.ttftCount ?? 0) + (r.ttftCount ?? 0)
        // providerName 合并时取第一个非 NULL（同 provider 不同 model 可能有 NULL/有值）
        if (!existing.providerName && r.providerName) existing.providerName = r.providerName
      } else {
        map.set(key, {...r, key, providerType: undefined})
      }
    }
    return [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens)
  }
}

/** 全局单例 */
export const llmUsageRepo = new SqliteLlmUsageRepository()
