/**
 * LLM 用量纯函数（零 electron 依赖，三端可复用）
 *
 * - toLlmUsageRecord：llm_call_done 事件 → llm_usage 表行（幂等 ID = usage_<messageId>_<seq>）
 * - timeRangeBounds：时间范围 → 过滤边界（startMs/endMs，null = 不限）
 * - tokensPerSecond / computeKpis：速率与 KPI 口径（弹窗 / 独立窗口共用，防漂移）
 * - mergeByProvider / attachCosts：分组合并与成本（主进程 / 渲染层共用）
 */
import type {LlmUsageRecord, TimeRange, UsageBreakdown} from './types'
import {MIN_DECODE_MS} from './types'

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
  return timeRangeBounds(range, now).startMs
}

/** 时间范围过滤边界（毫秒）；null = 不限 */
export interface TimeRangeBounds {
  startMs: number | null
  endMs: number | null
}

/** 解析 'YYYY-MM-DD' 为本地时区当日 0 点（毫秒） */
export function parseLocalDateStartMs(date: string): number {
  return new Date(`${date}T00:00:00`).getTime()
}

/** 解析 'YYYY-MM-DD' 为本地时区当日 23:59:59.999（闭区间终点，毫秒） */
export function parseLocalDateEndMs(date: string): number {
  return new Date(`${date}T23:59:59.999`).getTime()
}

/** 本地时区当日 0 点（毫秒） */
function todayStartMs(now: number): number {
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/**
 * 时间范围 → 过滤边界（毫秒）
 * - 'all' → 双 null（不过滤）
 * - 'today' → 当日 0 点起，至 now（endMs null）
 * - '7d'/'30d' → now 向前滚动
 * - 'custom' → 需 custom 起止（YYYY-MM-DD，天级精度，闭区间）；缺失时回退 'today' 语义
 */
export function timeRangeBounds(range: TimeRange, now: number = Date.now(), custom?: {start: string; end: string}): TimeRangeBounds {
  if (range === 'all') return {startMs: null, endMs: null}
  if (range === 'custom') {
    if (custom?.start && custom?.end) {
      return {startMs: parseLocalDateStartMs(custom.start), endMs: parseLocalDateEndMs(custom.end)}
    }
    // 自定义范围缺失 → 回退 'today' 语义（防御：渲染层保证 custom 参数完整）
    return {startMs: todayStartMs(now), endMs: null}
  }
  if (range === 'today') return {startMs: todayStartMs(now), endMs: null}
  // 剩余分支仅为 '7d' / '30d'
  const ms = range === '7d' ? 7 * 24 * 3600 * 1000 : 30 * 24 * 3600 * 1000
  return {startMs: now - ms, endMs: null}
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

// ─── 速率与 KPI 口径（弹窗 / 独立窗口共用，防漂移） ───────────────

/** 速率：outputTokens ÷ (durationMs/1000)；非法输入返回 null。 */
export function tokensPerSecond(outputTokens: number, durationMs: number): number | null {
  if (typeof outputTokens !== 'number' || !Number.isFinite(outputTokens) || outputTokens <= 0) return null
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) return null
  // 防爆表：时长过短视为首 token 边界虚短的异常数据（历史坏数据/网关抖动），
  // 按 MIN_DECODE_MS 保守下限计算，避免 190000 t/s 级异常值。
  const effective = Math.max(MIN_DECODE_MS, durationMs)
  return outputTokens / (effective / 1000)
}

/** 聚合 KPI 原始累加值（computeKpis 输入） */
export interface UsageKpiInput {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  /** 累计解码时长（毫秒） */
  totalDecodeMs: number
  /** 累计首字延迟（毫秒） */
  totalTtftMs: number
  /** 携带首字延迟的调用数 */
  ttftCount: number
}

/** 聚合 KPI（口径与消息 tooltip 一致：平均吞吐 = Σ输出 ÷ Σ解码时长；平均首字 = Σ首字 ÷ 样本数） */
export interface UsageKpis {
  /** 缓存命中率（0-100 整数）；分母（输入 + 缓存命中）≤ 0 → null */
  cacheHitRate: number | null
  /** 平均吞吐 t/s；无有效样本 → null */
  avgDecodeRate: number | null
  /** 平均首字（秒）；无样本 → null */
  avgTtftSeconds: number | null
}

/** 聚合 KPI 统一口径：缓存命中率 / 平均吞吐 / 平均首字（弹窗与独立窗口共用） */
export function computeKpis(raw: UsageKpiInput): UsageKpis {
  const denominator = raw.inputTokens + raw.cacheReadTokens
  const cacheHitRate = denominator > 0 ? Math.round(raw.cacheReadTokens / denominator * 100) : null
  return {
    cacheHitRate,
    avgDecodeRate: tokensPerSecond(raw.outputTokens, raw.totalDecodeMs),
    avgTtftSeconds: raw.ttftCount > 0 ? raw.totalTtftMs / raw.ttftCount / 1000 : null,
  }
}

// ─── 分组合并与成本（主进程 / 渲染层共用，防重复实现） ─────────────

/**
 * 同名模型跨服务商检测：返回出现次数 > 1 的模型名集合。
 * 分组键含 providerName 后，同名模型在不同服务商下会拆成多行，
 * UI 据此显示「同名」徽章并高亮 via 服务商信息（价格/延迟可能不同）。
 */
export function duplicatedModelKeys(rows: UsageBreakdown[]): Set<string> {
  const count = new Map<string, number>()
  for (const r of rows) count.set(r.key, (count.get(r.key) ?? 0) + 1)
  const dup = new Set<string>()
  for (const [key, n] of count) if (n > 1) dup.add(key)
  return dup
}

/** 按服务商合并（成本求和、totalTokens 降序、providerName 非 NULL 优先、时序字段累加） */
export function mergeByProvider(rows: UsageBreakdown[]): UsageBreakdown[] {
  const map = new Map<string, UsageBreakdown>()
  for (const r of rows) {
    // 合并键 = 真实服务商名（providers.name）优先，缺失（历史数据）回退 providerType。
    // providerType（anthropic/openai/...）只是 API 兼容风格，同一风格可挂多个服务商
    // （如 anthropic 下的 Deepseek-ant/dsh/xiaomimimo），绝不能作为合并键，否则会被并为一组。
    const key = r.providerName ?? r.providerType ?? 'unknown'
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

/** 批量补成本：按 key(model) 查价重算 costUsd（与 computeUsageCost 同口径；未定价 → 0） */
export function attachCosts(rows: UsageBreakdown[], getMeta: (model: string) => PriceSource): UsageBreakdown[] {
  return rows.map((b) => ({
    ...b,
    costUsd: computeUsageCost(
      {model: b.key, inputTokens: b.inputTokens, outputTokens: b.outputTokens, cacheReadTokens: b.cacheReadTokens},
      getMeta,
    ),
  }))
}
