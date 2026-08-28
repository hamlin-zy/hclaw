/**
 * llm_usage 表 Repository（token 用量数据源；历史 llm_stats 列回填见 readLegacyLlmStats）
 *
 * - record：单条写入（INSERT OR IGNORE 幂等）
 * - queryAggregated：全局聚合。分组按 (provider_id, provider_name, provider_type, model)，
 *   成本按行独立 provider-aware 重算（attachCostsProviderAware，注入 getMeta），
 *   历史 llm_stats 回填按含 provider_id 的组键合并，view='provider' 时按服务商合并（shared mergeByProvider，成本求和）
 * - queryTrend：按天趋势（含历史回填）
 * - queryByConversation：会话弹窗分组（WHERE conversation_id IN (...)）
 */
import {getDatabase} from './index'
import {timeRangeBounds, computeUsageCost, mergeByProvider, type PriceSource} from '@shared/llmUsage'
import {resolveCustomPrice, pricingToPriceSource, type CustomPriceEntry} from '@shared/usagePriceResolver'
import type {LlmUsageRecord, LlmStats, UsageBreakdown, TrendPoint, TimeRange, TrendGranularity} from '@shared/types'
import {createQueryLogger} from './queryLogger'

const logQuery = createQueryLogger('SQLite LlmUsageRepository')

/** 查询的时间范围参数（全局聚合/趋势共用）；customStart/customEnd 仅 range='custom' 时生效 */
export interface UsageQueryRange {
  range: TimeRange
  customStart?: string
  customEnd?: string
}

interface ModelAggRow {
  provider_type: string
  model: string
  /** 组内取非 NULL 的服务商名（providers.name，历史行可空） */
  provider_name: string | null
  /** 组内取非 NULL 的服务商 ID（providers.id，稳定维度，历史行可空） */
  provider_id: string | null
  request_count: number
  /** 组内去重会话数（COUNT(DISTINCT conversation_id)；历史行 conversation_id 可空） */
  conversation_count: number
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
      id, conversation_id, message_id, provider_type, model, provider_name, provider_id,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
      ttft_ms, decode_ms, duration_ms, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      record.id, record.conversationId, record.messageId, record.providerType, record.model,
      record.providerName ?? null,
      record.providerId ?? null,
      record.inputTokens, record.outputTokens, record.cacheReadTokens, record.cacheWriteTokens, record.reasoningTokens,
      record.ttftMs ?? null, record.decodeMs ?? null, record.durationMs, record.createdAt,
    )
    logQuery('record', start, record.id)
  }

  /** 全局聚合（成本统一 attachCosts；view='provider' 时按服务商合并） */
  queryAggregated(params: UsageQueryRange & {view: 'provider' | 'model'}, getMeta: (model: string) => PriceSource, customPrices?: CustomPriceEntry[]): UsageBreakdown[] {
    const start = Date.now()
    try {
      const db = getDatabase()
      const {startMs, endMs} = timeRangeBounds(params.range, Date.now(), toCustomRange(params))
      const rows = db.prepare(`
        SELECT provider_type, model, provider_name, provider_id,
               COUNT(*) AS request_count,
               COUNT(DISTINCT conversation_id) AS conversation_count,
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
          AND (? IS NULL OR created_at <= ?)
        GROUP BY provider_id, provider_name, provider_type, model
      `).all(startMs, startMs, endMs, endMs) as ModelAggRow[]

      const breakdowns = rows.map((r) => this.toModelBreakdown(r, getMeta, customPrices))

      // 历史回填：messages.llm_stats 列历史数据（与 readUsageRaw 双源语义一致），
      // 保证全局统计与右键弹窗数字一致（历史 llm_stats 全量 + llm_usage 全量，按消息共存）。
      const merged = this.mergeLegacyIntoBreakdowns(breakdowns, this.readLegacyLlmStats(null, {startMs, endMs}))
      merged.sort((a, b) => b.totalTokens - a.totalTokens)
      // 成本统一重算（回填行由此获得成本）：每行独立 provider-aware 取价（自定义 → getMeta 兜底）
      const withCost = this.attachCostsProviderAware(merged, getMeta, customPrices)
      logQuery('queryAggregated', start, `${withCost.length} rows`)
      return params.view === 'provider' ? mergeByProvider(withCost) : withCost
    } catch (err) {
      console.error('[SqliteLlmUsageRepository] queryAggregated failed:', err)
      return []
    }
  }

  /** 趋势（按天 / 按小时，本地时区；含历史 llm_stats 回填，与 queryAggregated 同源） */
  queryTrend(params: UsageQueryRange & {granularity?: TrendGranularity}): TrendPoint[] {
    const start = Date.now()
    try {
      const db = getDatabase()
      const {startMs, endMs} = timeRangeBounds(params.range, Date.now(), toCustomRange(params))
      const granularity = params.granularity === 'hour' ? 'hour' : 'day'
      // 分组键：按天 date(...) / 按小时 strftime('%Y-%m-%d %H:00', ...)，均本地时区
      const timeExpr = granularity === 'hour'
        ? `strftime('%Y-%m-%d %H:00', created_at/1000, 'unixepoch', 'localtime')`
        : `date(created_at/1000, 'unixepoch', 'localtime')`
      const rows = db.prepare(`
        SELECT ${timeExpr} AS day,
               SUM(input_tokens) AS input_tokens,
               SUM(output_tokens) AS output_tokens,
               SUM(cache_read_tokens) AS cache_read_tokens
        FROM llm_usage
        WHERE (? IS NULL OR created_at >= ?)
          AND (? IS NULL OR created_at <= ?)
        GROUP BY day
        ORDER BY day ASC
      `).all(startMs, startMs, endMs, endMs) as Array<{day: string; input_tokens: number; output_tokens: number; cache_read_tokens: number}>
      const trendMap = new Map<string, TrendPoint>()
      for (const r of rows) {
        trendMap.set(r.day, {day: r.day, inputTokens: r.input_tokens, outputTokens: r.output_tokens, cacheReadTokens: r.cache_read_tokens})
      }

      // 历史回填：桶键与 SQL 分组一致（本地时区），时间用消息 timestamp 近似
      this.mergeLegacyIntoTrend(trendMap, this.readLegacyLlmStats(null, {startMs, endMs}), granularity)
      const trend = [...trendMap.values()].sort((a, b) => a.day.localeCompare(b.day))
      logQuery('queryTrend', start, `${trend.length} ${granularity}s`)
      return trend
    } catch (err) {
      console.error('[SqliteLlmUsageRepository] queryTrend failed:', err)
      return []
    }
  }

  /**
   * 历史回填：messages.llm_stats 列中未被 llm_usage 覆盖的 assistant 消息。
   * 语义与 readUsageRaw / buildMessagesFromRows 双源一致（历史 llm_stats 全量 + llm_usage 全量，
   * 按消息共存合并，不做排除），保证全局统计与右键弹窗数字一致。
   * 时间过滤用消息 timestamp 近似（llm_stats 无独立调用时间戳）。
   */
  private readLegacyLlmStats(
    convIds: string[] | null,
    timeRange: {startMs: number | null; endMs: number | null},
  ): Array<{ts: number; stats: LlmStats[]}> {
    try {
      const db = getDatabase()
      // B1 双源防重：llm_usage 为唯一数据源。排除 llm_usage 中已有记录的消息，
      // 仅回填迁移前历史消息（llm_stats 列是它们的唯一源）；迁移后消息若列中残留
      // 双写/膨胀数据（历史写侧剥离不彻底所致），不再参与统计，避免重复计数。
      const conds: string[] = ['m.llm_stats IS NOT NULL', "m.role = 'assistant'", 'NOT EXISTS (SELECT 1 FROM llm_usage u WHERE u.message_id = m.id)']
      const params: unknown[] = []
      if (convIds && convIds.length > 0) {
        conds.push(`m.conversation_id IN (${convIds.map(() => '?').join(',')})`)
        params.push(...convIds)
      }
      if (timeRange.startMs != null) {
        conds.push('m.timestamp >= ?')
        params.push(timeRange.startMs)
      }
      if (timeRange.endMs != null) {
        conds.push('m.timestamp <= ?')
        params.push(timeRange.endMs)
      }
      const rows = db.prepare(
        `SELECT m.timestamp AS ts, m.llm_stats FROM messages m WHERE ${conds.join(' AND ')}`
      ).all(...params) as Array<{ts: number; llm_stats: string}>
      const out: Array<{ts: number; stats: LlmStats[]}> = []
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.llm_stats) as LlmStats[]
          if (Array.isArray(parsed) && parsed.length > 0) out.push({ts: row.ts, stats: parsed})
        } catch {
          // 单条损坏的 llm_stats 忽略，不阻塞统计
        }
      }
      return out
    } catch (err) {
      console.error('[SqliteLlmUsageRepository] readLegacyLlmStats failed:', err)
      return []
    }
  }

  /**
   * 历史 llm_stats 合并进模型分组（键 providerId\0providerName\0provider\0model；与 llm_usage 行共存相加）
   * 键必须含 providerId：SQL GROUP BY provider_id 后同名同 model 可产出 NULL-id 历史行与带 id 新行
   * 两行（其余维度全同），仅按 name/model 分键会被 Map 覆盖丢行；历史回填行无 providerId，
   * 始终匹配 NULL-id 组（''前缀），无法归属的独立成组。
   */
  private mergeLegacyIntoBreakdowns(breakdowns: UsageBreakdown[], legacy: Array<{ts: number; stats: LlmStats[]}>): UsageBreakdown[] {
    if (legacy.length === 0) return breakdowns
    const groupMap = new Map(breakdowns.map((b) => [`${b.providerId ?? ''}\u0000${b.providerName ?? ''}\u0000${b.providerType ?? 'unknown'}\u0000${b.key}`, b]))
    for (const item of legacy) {
      for (const s of item.stats) {
        const provider = s.provider || 'unknown'
        const model = s.model || 'unknown'
        const mapKey = `${s.providerId ?? ''}\u0000${s.providerName ?? ''}\u0000${provider}\u0000${model}`
        const g = groupMap.get(mapKey) ?? {
          key: model, providerType: provider, providerName: s.providerName, requestCount: 0,
          conversationCount: 0, // 历史 llm_stats 无会话维度，保持 0（未知）
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
          totalTokens: 0, costUsd: 0, decodeMs: 0, ttftMs: 0, ttftCount: 0,
        }
        // providerName 组内非 NULL 优先：历史行（无 name）不覆盖新值
        if (!g.providerName && s.providerName) g.providerName = s.providerName
        g.requestCount++
        g.inputTokens += s.inputTokens || 0
        g.outputTokens += s.outputTokens || 0
        g.cacheReadTokens += s.cacheReadTokens || 0
        g.cacheWriteTokens += s.cacheWriteTokens || 0
        g.totalTokens = g.inputTokens + g.outputTokens + g.cacheReadTokens + g.cacheWriteTokens
        g.decodeMs = (g.decodeMs ?? 0) + (s.decodeMs || 0)
        g.ttftMs = (g.ttftMs ?? 0) + (s.ttftMs || 0)
        g.ttftCount = (g.ttftCount ?? 0) + (typeof s.ttftMs === 'number' ? 1 : 0)
        groupMap.set(mapKey, g)
      }
    }
    return [...groupMap.values()]
  }

  /** 历史 llm_stats 合并进趋势桶（桶键与 SQL 分组一致：本地时区 'YYYY-MM-DD' / 'YYYY-MM-DD HH:00'） */
  private mergeLegacyIntoTrend(trendMap: Map<string, TrendPoint>, legacy: Array<{ts: number; stats: LlmStats[]}>, granularity: 'day' | 'hour'): void {
    for (const item of legacy) {
      const d = new Date(item.ts)
      const day = granularity === 'hour'
        ? `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:00`
        : `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
      const t = trendMap.get(day) ?? {day, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0}
      for (const s of item.stats) {
        t.inputTokens += s.inputTokens || 0
        t.outputTokens += s.outputTokens || 0
        t.cacheReadTokens += s.cacheReadTokens || 0
      }
      trendMap.set(day, t)
    }
  }

  /** 会话弹窗分组（模型粒度 + 成本；view='provider' 时合并） */
  queryByConversation(convIds: string[], view: 'provider' | 'model', getMeta: (model: string) => PriceSource, customPrices?: CustomPriceEntry[]): UsageBreakdown[] {
    if (convIds.length === 0) return []
    const start = Date.now()
    try {
      const db = getDatabase()
      const placeholders = convIds.map(() => '?').join(',')
      const rows = db.prepare(`
        SELECT provider_type, model, provider_name, provider_id,
               COUNT(*) AS request_count,
               COUNT(DISTINCT conversation_id) AS conversation_count,
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
        GROUP BY provider_id, provider_name, provider_type, model
      `).all(...convIds) as ModelAggRow[]

      const breakdowns = rows.map((r) => this.toModelBreakdown(r, getMeta, customPrices))
      logQuery('queryByConversation', start, `${breakdowns.length} rows`)
      return view === 'provider' ? mergeByProvider(breakdowns) : breakdowns
    } catch (err) {
      console.error('[SqliteLlmUsageRepository] queryByConversation failed:', err)
      return []
    }
  }

  /**
   * provider-aware 批量补成本（§三 C4）：每行独立取价——
   * 自定义 (providerId, model) → providerName → getMeta（OpenRouter 等兜底）。
   * 禁止把同 model 跨服务商行合并后取一次价——成本必须在行级算好后再由 mergeByProvider 求和。
   */
  private attachCostsProviderAware(rows: UsageBreakdown[], getMeta: (model: string) => PriceSource, customPrices?: CustomPriceEntry[]): UsageBreakdown[] {
    return rows.map((b) => ({
      ...b,
      costUsd: computeUsageCost(
        {
          model: b.key,
          inputTokens: b.inputTokens,
          outputTokens: b.outputTokens,
          cacheReadTokens: b.cacheReadTokens,
          cacheWriteTokens: b.cacheWriteTokens,
        },
        () => this.resolvePriceSource(b.key, b.providerId ?? null, b.providerName ?? null, getMeta, customPrices),
      ),
    }))
  }

  /** 行级取价：自定义定价命中（非 null）→ 全量价集（缺失维度补 0）；否则 getMeta 兜底（既有路径不变） */
  private resolvePriceSource(model: string, providerId: string | null, providerName: string | null, getMeta: (model: string) => PriceSource, customPrices?: CustomPriceEntry[]): PriceSource {
    if (customPrices && customPrices.length > 0) {
      const custom = resolveCustomPrice(customPrices, {model, providerId, providerName})
      if (custom) return pricingToPriceSource(custom)
    }
    return getMeta(model)
  }

  /** 模型粒度行 → UsageBreakdown（含成本；行级独立 provider-aware 取价） */
  private toModelBreakdown(r: ModelAggRow, getMeta: (model: string) => PriceSource, customPrices?: CustomPriceEntry[]): UsageBreakdown {
    return {
      key: r.model,
      providerType: r.provider_type,
      providerName: r.provider_name ?? undefined,
      providerId: r.provider_id ?? undefined,
      requestCount: r.request_count,
      conversationCount: r.conversation_count ?? 0,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheReadTokens: r.cache_read_tokens,
      cacheWriteTokens: r.cache_write_tokens,
      totalTokens: r.total_tokens,
      // 显式传 camelCase 字段：ModelAggRow 为 snake_case，不能直接把 r 交给 computeUsageCost（按名读 row.inputTokens 会读到 undefined）
      costUsd: computeUsageCost(
        {
          model: r.model,
          inputTokens: r.input_tokens,
          outputTokens: r.output_tokens,
          cacheReadTokens: r.cache_read_tokens,
          cacheWriteTokens: r.cache_write_tokens,
        },
        () => this.resolvePriceSource(r.model, r.provider_id, r.provider_name, getMeta, customPrices),
      ),
      decodeMs: r.decode_ms ?? undefined,
      ttftMs: r.ttft_ms ?? undefined,
      ttftCount: r.ttft_count,
    }
  }
}

/** 全局单例 */
export const llmUsageRepo = new SqliteLlmUsageRepository()

/** 提取自定义范围（customStart/customEnd 完整才生效，否则 undefined 回退语义） */
function toCustomRange(params: UsageQueryRange): {start: string; end: string} | undefined {
  return params.customStart && params.customEnd ? {start: params.customStart, end: params.customEnd} : undefined
}

/** 两位补零（本地时区日期/小时桶键用） */
function pad2(n: number): string {
  return String(n).padStart(2, '0')
}
