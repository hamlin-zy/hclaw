import {describe, expect, it} from 'vitest'
import type {Message} from '@shared/types'
import {
  computeMessageTokenStats,
  computeMessageTokenStatsByModel,
  llmStatsModelKey,
  computeUsagePct,
} from '@shared/messageTokenStats'

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

/** 构造带时间戳的 assistant 消息（byModel 用例用） */
function msgAt(id: string, timestamp: number, llmStats?: Message['llmStats'], toolCalls?: Message['toolCalls']): Message {
  return {...msg(id, llmStats, toolCalls), timestamp}
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
    expect(s.lastTimedStats).toBeNull()
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

  it('末次为纯工具轮次（无 ttftMs）时，末次吞吐口径回退到最后一个带文本解码的请求', () => {
    // 复现：文本回答轮次（带完整时序）→ 纯工具调用轮次（仅 tool_use，无文本解码，
    // execute.ts 中 firstTokenTime 未设置 → ttftMs/decodeMs 缺失）
    const messages: Message[] = [
      msg('m1', [
        {inputTokens: 100, outputTokens: 20, provider: 'p', model: 'm', duration: 1000, cacheReadTokens: 50, decodeMs: 800, ttftMs: 400},
      ]),
      msg('m2', [
        {inputTokens: 200, outputTokens: 12, provider: 'p', model: 'm', duration: 100, cacheReadTokens: 30},
      ], [{id: 't1', name: 'bash', arguments: {}, status: 'pending'}]),
    ]
    const s = computeMessageTokenStats(messages)
    // current* 保持"最后一条 llmStats"原始语义（工具轮次真实消耗 + 无时序标记）
    expect(s.currentInputTokens).toBe(200)
    expect(s.currentCacheReadTokens).toBe(30)
    expect(s.currentOutputTokens).toBe(12)
    expect(s.currentDecodeMs).toBe(0)
    expect(s.currentHasTtft).toBe(false)
    // 末次吞吐口径回退到最后一个有文本解码的轮次（t/s 徽章不因纯工具轮次消失）
    expect(s.lastTimedStats).toEqual({outputTokens: 20, decodeMs: 800})
  })

  it('全部为纯工具轮次（无任何 ttftMs）→ lastTimedStats 为 null', () => {
    const messages: Message[] = [
      msg('m1', [
        {inputTokens: 100, outputTokens: 8, provider: 'p', model: 'm', duration: 100},
      ], [{id: 't1', name: 'bash', arguments: {}, status: 'pending'}]),
    ]
    const s = computeMessageTokenStats(messages)
    expect(s.lastTimedStats).toBeNull()
    expect(s.currentHasTtft).toBe(false)
  })
})

describe('computeMessageTokenStatsByModel', () => {
  it('多模型混合消息分组正确：每组累计/当前/请求数独立', () => {
    const messages: Message[] = [
      msgAt('m1', 100, [
        {inputTokens: 100, outputTokens: 20, provider: 'p1', providerName: 'Provider A', model: 'model-a', duration: 1000, cacheReadTokens: 50, decodeMs: 800, ttftMs: 400},
      ]),
      msgAt('m2', 200, [
        {inputTokens: 200, outputTokens: 40, provider: 'p2', providerName: 'Provider B', model: 'model-b', duration: 2000, cacheReadTokens: 30, decodeMs: 1600, ttftMs: 600},
      ]),
      msgAt('m3', 300, [
        {inputTokens: 10, outputTokens: 2, provider: 'p1', providerName: 'Provider A', model: 'model-a', duration: 100, cacheReadTokens: 5},
      ], [{id: 't1', name: 'bash', arguments: {}, status: 'pending'}]),
    ]

    const byModel = computeMessageTokenStatsByModel(messages)

    expect(byModel).toHaveLength(2)
    const a = byModel.find(g => g.providerName === 'Provider A' && g.model === 'model-a')!
    const b = byModel.find(g => g.providerName === 'Provider B' && g.model === 'model-b')!

    // model-a：两条消息累计；当前值 = 最后一条（m3，无时序）
    expect(a.stats.requestCount).toBe(2)
    expect(a.stats.totalInputTokens).toBe(110)
    expect(a.stats.totalOutputTokens).toBe(22)
    expect(a.stats.totalCacheReadTokens).toBe(55)
    expect(a.stats.currentInputTokens).toBe(10)
    expect(a.stats.currentHasTtft).toBe(false)
    // 末次吞吐口径回退到最后一个带文本解码的请求（m1）
    expect(a.stats.lastTimedStats).toEqual({outputTokens: 20, decodeMs: 800})
    // 工具调用归入该消息最后一条 llmStats 所属组（m3 → model-a）
    expect(a.stats.toolCallCount).toBe(1)

    // model-b：单条消息
    expect(b.stats.requestCount).toBe(1)
    expect(b.stats.totalInputTokens).toBe(200)
    expect(b.stats.totalOutputTokens).toBe(40)
    expect(b.stats.toolCallCount).toBe(0)
    // 末次使用时间 = 所属消息 timestamp
    expect(a.lastUsedAt).toBe(300)
    expect(b.lastUsedAt).toBe(200)
  })

  it('各模型累计/当前/末次时序口径与全局一致（多轮同模型）', () => {
    const messages: Message[] = [
      msgAt('m1', 100, [
        {inputTokens: 100, outputTokens: 20, provider: 'p', model: 'model-a', duration: 1000, cacheReadTokens: 50, decodeMs: 800, ttftMs: 400},
      ]),
      msgAt('m2', 200, [
        {inputTokens: 200, outputTokens: 40, provider: 'p', model: 'model-a', duration: 2000, cacheReadTokens: 30, decodeMs: 1600, ttftMs: 600},
      ]),
      // 纯工具轮次：无文本解码（ttftMs/decodeMs 缺失）
      msgAt('m3', 300, [
        {inputTokens: 50, outputTokens: 5, provider: 'p', model: 'model-a', duration: 500, cacheReadTokens: 10},
      ], [{id: 't1', name: 'bash', arguments: {}, status: 'pending'}]),
    ]

    const byModel = computeMessageTokenStatsByModel(messages)
    expect(byModel).toHaveLength(1)
    const s = byModel[0].stats

    expect(s.requestCount).toBe(3)
    expect(s.totalInputTokens).toBe(350)
    expect(s.totalOutputTokens).toBe(65)
    expect(s.totalCacheReadTokens).toBe(90)
    expect(s.totalDecodeMs).toBe(2400)
    expect(s.totalTtftMs).toBe(1000)
    expect(s.ttftCount).toBe(2)
    // 当前值 = 最后一条 llmStats（无时序的工具轮次）
    expect(s.currentInputTokens).toBe(50)
    expect(s.currentOutputTokens).toBe(5)
    expect(s.currentHasTtft).toBe(false)
    // 末次吞吐口径回退到最后一个带文本解码的请求
    expect(s.lastTimedStats).toEqual({outputTokens: 40, decodeMs: 1600})
    // 工具调用计入
    expect(s.toolCallCount).toBe(1)
    expect(byModel[0].lastUsedAt).toBe(300)
  })

  it('同名模型不同服务商靠分组键区分', () => {
    const messages: Message[] = [
      msgAt('m1', 100, [
        {inputTokens: 10, outputTokens: 1, provider: 'custom', providerName: 'Provider A', model: 'gpt-5', duration: 100},
      ]),
      msgAt('m2', 200, [
        {inputTokens: 20, outputTokens: 2, provider: 'openai', providerName: 'Provider B', model: 'gpt-5', duration: 100},
      ]),
    ]

    const byModel = computeMessageTokenStatsByModel(messages)
    expect(byModel).toHaveLength(2)
    // 分组键含 provider → 两组互不合并
    expect(byModel.some(g => g.key === 'Provider A\u0000gpt-5')).toBe(true)
    expect(byModel.some(g => g.key === 'Provider B\u0000gpt-5')).toBe(true)
    const a = byModel.find(g => g.providerName === 'Provider A')!
    const b = byModel.find(g => g.providerName === 'Provider B')!
    expect(a.stats.requestCount).toBe(1)
    expect(a.stats.totalInputTokens).toBe(10)
    expect(b.stats.requestCount).toBe(1)
    expect(b.stats.totalInputTokens).toBe(20)
  })

  it('providerName 缺失回退 provider 类型名（分组键与显示名一致）', () => {
    const messages: Message[] = [
      msgAt('m1', 100, [
        {inputTokens: 1, outputTokens: 1, provider: 'custom', model: 'deepseek-v3', duration: 100},
      ]),
      msgAt('m2', 200, [
        {inputTokens: 2, outputTokens: 1, provider: 'custom', providerName: 'DeepSeek', model: 'deepseek-v3', duration: 100},
      ]),
    ]

    const byModel = computeMessageTokenStatsByModel(messages)
    expect(byModel).toHaveLength(2)
    const legacy = byModel.find(g => g.providerName === 'custom')!
    const named = byModel.find(g => g.providerName === 'DeepSeek')!
    expect(legacy.model).toBe('deepseek-v3')
    expect(llmStatsModelKey({provider: 'custom', model: 'deepseek-v3'})).toBe('custom\u0000deepseek-v3')
    expect(named.key).toBe('DeepSeek\u0000deepseek-v3')
    expect(legacy.stats.totalInputTokens).toBe(1)
    expect(named.stats.totalInputTokens).toBe(2)
  })

  it('按末次使用时间倒序（同消息多 llmStats 也取最大 timestamp）', () => {
    const messages: Message[] = [
      msgAt('m1', 300, [
        {inputTokens: 1, outputTokens: 1, provider: 'p', model: 'model-a', duration: 1},
      ]),
      msgAt('m2', 100, [
        {inputTokens: 1, outputTokens: 1, provider: 'p', model: 'model-b', duration: 1},
      ]),
      msgAt('m3', 200, [
        {inputTokens: 1, outputTokens: 1, provider: 'p', model: 'model-c', duration: 1},
      ]),
    ]

    const byModel = computeMessageTokenStatsByModel(messages)
    expect(byModel.map(g => g.model)).toEqual(['model-a', 'model-c', 'model-b'])
    expect(byModel.map(g => g.lastUsedAt)).toEqual([300, 200, 100])
  })

  it('工具调用归入该消息最后一条 llmStats 所属模型组', () => {
    const messages: Message[] = [
      msgAt('m1', 100, [
        {inputTokens: 10, outputTokens: 1, provider: 'p', model: 'model-a', duration: 100},
        {inputTokens: 20, outputTokens: 2, provider: 'p', model: 'model-b', duration: 100},
      ], [
        {id: 't1', name: 'bash', arguments: {}, status: 'pending'},
        {id: 't2', name: 'glob', arguments: {}, status: 'pending'},
      ]),
    ]

    const byModel = computeMessageTokenStatsByModel(messages)
    const a = byModel.find(g => g.model === 'model-a')!
    const b = byModel.find(g => g.model === 'model-b')!
    expect(a.stats.toolCallCount).toBe(0)
    expect(b.stats.toolCallCount).toBe(2)
    // 各自请求数仍按各自 llmStats 计
    expect(a.stats.requestCount).toBe(1)
    expect(b.stats.requestCount).toBe(1)
  })

  it('空消息 / 无非 assistant 消息 → 空数组', () => {
    expect(computeMessageTokenStatsByModel([])).toEqual([])
    const nonAssistant: Message[] = [
      {id: 'u1', role: 'user', content: 'hi', timestamp: 100},
      {id: 's1', role: 'system', content: 'sys', timestamp: 200},
    ]
    expect(computeMessageTokenStatsByModel(nonAssistant)).toEqual([])
  })

  it('assistant 消息无 llmStats / 空 llmStats → 不产生分组', () => {
    const messages: Message[] = [
      msgAt('m1', 100, undefined),
      msgAt('m2', 200, []),
      msgAt('m3', 300, [
        {inputTokens: 5, outputTokens: 1, provider: 'p', model: 'm', duration: 1},
      ]),
    ]
    const byModel = computeMessageTokenStatsByModel(messages)
    expect(byModel).toHaveLength(1)
    expect(byModel[0].stats.requestCount).toBe(1)
    expect(byModel[0].stats.totalInputTokens).toBe(5)
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
