import {describe, expect, it} from 'vitest'
import type {Message} from '@shared/types'
import {computeMessageTokenStats, computeUsagePct} from '@shared/messageTokenStats'

/** 构造最小 assistant 消息（含 llmStats / toolCalls） */
function msg(id: string, llmStats?: Message['llmStats'], toolCalls?: Message['toolCalls']): Message {
  return {
    id,
    role: 'assistant',
    content: '',
    timestamp: 0,
    ...(llmStats ? {llmStats} : {}),
    ...(toolCalls ? {toolCalls} : {}),
  }
}

describe('computeMessageTokenStats', () => {
  it('累计值 + 当前值（最后一条 llmStats 覆盖）+ 计数', () => {
    const messages: Message[] = [
      msg('m1', [
        {inputTokens: 100, outputTokens: 20, provider: 'p', model: 'model-a', duration: 1000, cacheReadTokens: 50, decodeMs: 800, ttftMs: 400},
        {inputTokens: 200, outputTokens: 40, provider: 'p', model: 'model-b', duration: 2000, cacheReadTokens: 30, decodeMs: 1600, ttftMs: 600},
      ], [{id: 't1', name: 'bash', arguments: {}, status: 'pending'}]),
    ]

    const s = computeMessageTokenStats(messages)

    expect(s.requestCount).toBe(2)
    expect(s.toolCallCount).toBe(1)
    expect(s.totalInputTokens).toBe(300)
    expect(s.totalOutputTokens).toBe(60)
    expect(s.totalCacheReadTokens).toBe(80)
    expect(s.totalDecodeMs).toBe(2400)
    expect(s.totalTtftMs).toBe(1000)
    expect(s.ttftCount).toBe(2)
    // 当前值 = 最后一条 llmStats（model-b）
    expect(s.currentInputTokens).toBe(200)
    expect(s.currentOutputTokens).toBe(40)
    expect(s.currentCacheReadTokens).toBe(30)
    // 末次时序 = 最后一条 llmStats（model-b）
    expect(s.currentDecodeMs).toBe(1600)
    expect(s.currentHasTtft).toBe(true)
  })

  it('忽略非 assistant 消息', () => {
    const messages: Message[] = [
      {id: 'u1', role: 'user', content: 'hi', timestamp: 0},
      msg('m1', [{inputTokens: 10, outputTokens: 1, provider: 'p', model: 'm', duration: 1}]),
    ]
    const s = computeMessageTokenStats(messages)
    expect(s.requestCount).toBe(1)
    expect(s.totalInputTokens).toBe(10)
  })

  it('空消息列表 → 全 0', () => {
    const s = computeMessageTokenStats([])
    expect(s.requestCount).toBe(0)
    expect(s.toolCallCount).toBe(0)
    expect(s.totalInputTokens).toBe(0)
    expect(s.totalOutputTokens).toBe(0)
    expect(s.totalCacheReadTokens).toBe(0)
    expect(s.totalDecodeMs).toBe(0)
    expect(s.totalTtftMs).toBe(0)
    expect(s.ttftCount).toBe(0)
    expect(s.currentInputTokens).toBe(0)
    expect(s.currentOutputTokens).toBe(0)
    expect(s.currentCacheReadTokens).toBe(0)
    expect(s.currentDecodeMs).toBe(0)
    expect(s.currentHasTtft).toBe(false)
  })

  it('assistant 消息无 llmStats / 空 llmStats → 不崩溃', () => {
    const messages: Message[] = [
      msg('m1', undefined),
      msg('m2', []),
    ]
    const s = computeMessageTokenStats(messages)
    expect(s.requestCount).toBe(0)
  })

  it('多条消息：当前值取最后一条 assistant 的最后一条 llmStats', () => {
    const messages: Message[] = [
      msg('m1', [{inputTokens: 1, outputTokens: 1, provider: 'p', model: 'a', duration: 1}]),
      msg('m2', [{inputTokens: 2, outputTokens: 2, provider: 'p', model: 'b', duration: 1}]),
    ]
    const s = computeMessageTokenStats(messages)
    expect(s.currentInputTokens).toBe(2)
    // 旧数据无 ttftMs → 不计入首字样本
    expect(s.totalTtftMs).toBe(0)
    expect(s.ttftCount).toBe(0)
    // 末次请求无时序 → currentHasTtft false
    expect(s.currentDecodeMs).toBe(0)
    expect(s.currentHasTtft).toBe(false)
  })
})

describe('computeUsagePct', () => {
  it('window=0 → 0', () => {
    expect(computeUsagePct(100, 0)).toBe(0)
  })

  it('正常比例 → 整数百分比', () => {
    expect(computeUsagePct(12345, 200000)).toBe(6)
  })

  it('>100 → 封顶 100', () => {
    expect(computeUsagePct(999999, 100)).toBe(100)
  })
})
