import {describe, expect, it} from 'vitest'
import {toLlmUsageRecord, timeRangeStartMs} from '@shared/llmUsage'

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
