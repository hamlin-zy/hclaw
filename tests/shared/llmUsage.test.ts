import {describe, expect, it} from 'vitest'
import {toLlmUsageRecord, timeRangeStartMs, timeRangeBounds, parseLocalDateStartMs, parseLocalDateEndMs, computeKpis, tokensPerSecond, mergeByProvider, attachCosts} from '@shared/llmUsage'

describe('toLlmUsageRecord', () => {
  it('字段映射正确（精确 providerType、seq、全部 token 列）', () => {
    const rec = toLlmUsageRecord({
      providerType: 'anthropic',
      providerName: 'Deepseek-ant',
      model: 'claude-sonnet-4',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 300,
      cacheWriteTokens: 0,
      reasoningTokens: 5,
      ttftMs: 800,
      decodeMs: 5000,
      duration: 12345,
    }, {conversationId: 'conv-1', messageId: 'm-1', seq: 2, createdAt: 1000})

    expect(rec.id).toBe('usage_m-1_2')
    expect(rec.conversationId).toBe('conv-1')
    expect(rec.messageId).toBe('m-1')
    expect(rec.providerType).toBe('anthropic')
    expect(rec.providerName).toBe('Deepseek-ant')
    expect(rec.model).toBe('claude-sonnet-4')
    expect(rec.inputTokens).toBe(100)
    expect(rec.outputTokens).toBe(20)
    expect(rec.cacheReadTokens).toBe(300)
    expect(rec.cacheWriteTokens).toBe(0)
    expect(rec.reasoningTokens).toBe(5)
    expect(rec.ttftMs).toBe(800)
    expect(rec.decodeMs).toBe(5000)
    expect(rec.durationMs).toBe(12345)
    expect(rec.createdAt).toBe(1000)
  })

  it('可选字段缺失 → 默认 0；createdAt 默认 Date.now()', () => {
    const rec = toLlmUsageRecord({
      providerType: 'openai',
      model: 'gpt-4o',
      inputTokens: 1,
      outputTokens: 1,
      duration: 100,
    }, {conversationId: 'c', messageId: 'm', seq: 0})

    expect(rec.cacheReadTokens).toBe(0)
    expect(rec.cacheWriteTokens).toBe(0)
    expect(rec.reasoningTokens).toBe(0)
    expect(rec.ttftMs).toBeUndefined()
    expect(rec.decodeMs).toBeUndefined()
    expect(rec.providerName).toBeUndefined()
    expect(rec.createdAt).toBeGreaterThan(0)
  })
})

describe('timeRangeStartMs', () => {
  it("'all' → null（不过滤）", () => {
    expect(timeRangeStartMs('all', 1000)).toBeNull()
  })

  it("'today' → 当天 0 点", () => {
    const now = new Date(2026, 7, 16, 14, 30).getTime() // 2026-08-16 14:30
    expect(timeRangeStartMs('today', now)).toBe(new Date(2026, 7, 16).getTime())
  })

  it("'7d' → now - 7 天", () => {
    expect(timeRangeStartMs('7d', 1_000_000)).toBe(1_000_000 - 7 * 24 * 3600 * 1000)
  })

  it("'30d' → now - 30 天", () => {
    expect(timeRangeStartMs('30d', 1_000_000)).toBe(1_000_000 - 30 * 24 * 3600 * 1000)
  })
})

describe('timeRangeBounds', () => {
  it("'all' → 双 null（不过滤）", () => {
    expect(timeRangeBounds('all', 1000)).toEqual({startMs: null, endMs: null})
  })

  it("'today' → 当天 0 点起，endMs null（至 now）", () => {
    const now = new Date(2026, 7, 16, 14, 30).getTime()
    expect(timeRangeBounds('today', now)).toEqual({startMs: new Date(2026, 7, 16).getTime(), endMs: null})
  })

  it("'7d' → now - 7 天，endMs null", () => {
    expect(timeRangeBounds('7d', 1_000_000)).toEqual({startMs: 1_000_000 - 7 * 24 * 3600 * 1000, endMs: null})
  })

  it("'custom' → 开始日 0 点 ~ 结束日 23:59:59.999（闭区间）", () => {
    const bounds = timeRangeBounds('custom', Date.now(), {start: '2026-08-10', end: '2026-08-12'})
    expect(bounds).toEqual({
      startMs: parseLocalDateStartMs('2026-08-10'),
      endMs: parseLocalDateEndMs('2026-08-12'),
    })
    // 结束日当天 23:59:59.999 以内的记录必须命中（闭区间终点）
    expect(parseLocalDateStartMs('2026-08-10')).toBeLessThan(parseLocalDateEndMs('2026-08-12'))
  })

  it("'custom' 同日 → startMs < endMs，且跨度为一天内", () => {
    const bounds = timeRangeBounds('custom', Date.now(), {start: '2026-08-10', end: '2026-08-10'})
    expect(bounds.startMs).toBe(parseLocalDateStartMs('2026-08-10'))
    expect(bounds.endMs).toBe(parseLocalDateEndMs('2026-08-10'))
    expect(bounds.endMs! - bounds.startMs!).toBe(24 * 3600 * 1000 - 1)
  })

  it("'custom' 缺少起止 → 回退 'today' 语义", () => {
    const now = new Date(2026, 7, 16, 9, 0).getTime()
    expect(timeRangeBounds('custom', now)).toEqual({startMs: new Date(2026, 7, 16).getTime(), endMs: null})
    expect(timeRangeBounds('custom', now, {start: '2026-08-10', end: ''})).toEqual({startMs: new Date(2026, 7, 16).getTime(), endMs: null})
  })

  it('timeRangeStartMs 与 timeRangeBounds 口径一致（兼容旧签名）', () => {
    const now = new Date(2026, 7, 16, 14, 30).getTime()
    expect(timeRangeStartMs('today', now)).toBe(timeRangeBounds('today', now).startMs)
    expect(timeRangeStartMs('all', now)).toBeNull()
  })
})


describe('computeKpis（统一 KPI 口径）', () => {
  it('缓存命中率 / 平均吞吐 / 平均首字', () => {
    const k = computeKpis({inputTokens: 100, outputTokens: 350000, cacheReadTokens: 300, totalDecodeMs: 3500000, totalTtftMs: 2400, ttftCount: 2})
    expect(k.cacheHitRate).toBe(75)          // 300 / (100+300) = 75%
    expect(k.avgDecodeRate).toBe(100)        // 350000 / 3500s
    expect(k.avgTtftSeconds).toBe(1.2)       // 2400ms / 2 / 1000
  })

  it('分母 ≤ 0 → cacheHitRate null；无解码样本 → avgDecodeRate null；无首字样本 → avgTtftSeconds null', () => {
    const k = computeKpis({inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalDecodeMs: 0, totalTtftMs: 0, ttftCount: 0})
    expect(k.cacheHitRate).toBeNull()
    expect(k.avgDecodeRate).toBeNull()
    expect(k.avgTtftSeconds).toBeNull()
  })
})

describe('tokensPerSecond（与消息 tooltip 同口径，含 MIN_DECODE_MS 防爆表）', () => {
  it('正常速率', () => {
    expect(tokensPerSecond(200, 2000)).toBe(100)
  })
  it('非法输入 → null', () => {
    expect(tokensPerSecond(0, 2000)).toBeNull()
    expect(tokensPerSecond(200, 0)).toBeNull()
    expect(tokensPerSecond(NaN, 2000)).toBeNull()
  })
})

describe('mergeByProvider（按服务商合并）', () => {
  const rows = [
    {key: 'claude-sonnet-4', providerType: 'anthropic', providerName: 'Deepseek-ant', requestCount: 2, inputTokens: 100, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 0, totalTokens: 420, costUsd: 0.01, decodeMs: 5000, ttftMs: 800, ttftCount: 1},
    {key: 'claude-opus-4', providerType: 'anthropic', providerName: undefined, requestCount: 1, inputTokens: 50, outputTokens: 10, cacheReadTokens: 100, cacheWriteTokens: 0, totalTokens: 160, costUsd: 0.02, decodeMs: 2000, ttftMs: undefined, ttftCount: 0},
    {key: 'gpt-4o', providerType: 'openai', providerName: 'OpenAI', requestCount: 3, inputTokens: 500, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 600, costUsd: 0.03},
  ]

  it('同服务商合并：token/成本/时序累加，providerName 非 NULL 优先，totalTokens 降序', () => {
    const merged = mergeByProvider(rows)
    expect(merged).toHaveLength(2)
    // totalTokens 降序：openai 600 > anthropic 580
    expect(merged[0].key).toBe('openai')
    expect(merged[0].requestCount).toBe(3)
    const anthropic = merged[1]
    expect(anthropic.key).toBe('anthropic')
    expect(anthropic.requestCount).toBe(3)
    expect(anthropic.inputTokens).toBe(150)
    expect(anthropic.outputTokens).toBe(30)
    expect(anthropic.cacheReadTokens).toBe(400)
    expect(anthropic.totalTokens).toBe(580)
    expect(anthropic.costUsd).toBeCloseTo(0.03, 10)
    expect(anthropic.decodeMs).toBe(7000)
    expect(anthropic.ttftMs).toBe(800)
    expect(anthropic.ttftCount).toBe(1)
    expect(anthropic.providerName).toBe('Deepseek-ant')
  })

  it('空数组 → 空数组', () => {
    expect(mergeByProvider([])).toEqual([])
  })
})

describe('attachCosts（批量补成本）', () => {
  const getMeta = (model: string): {inputPrice: number; outputPrice: number; cacheReadPrice: number} =>
    model === 'm1' ? {inputPrice: 3e-6, outputPrice: 15e-6, cacheReadPrice: 0.3e-6} : {inputPrice: 0, outputPrice: 0, cacheReadPrice: 0}

  it('按 key(model) 查价重算 costUsd；未定价 → 0', () => {
    const rows = [
      {key: 'm1', providerType: 'p', requestCount: 1, inputTokens: 1000, outputTokens: 100, cacheReadTokens: 5000, cacheWriteTokens: 0, totalTokens: 6100, costUsd: 999},
      {key: 'm2', providerType: 'p', requestCount: 1, inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 20, costUsd: 999},
    ]
    const out = attachCosts(rows, getMeta)
    expect(out[0].costUsd).toBeCloseTo(1000*3e-6 + 100*15e-6 + 5000*0.3e-6, 10)
    expect(out[1].costUsd).toBe(0)
    expect(out[0].inputTokens).toBe(1000)  // 其余字段原样保留
  })
})
