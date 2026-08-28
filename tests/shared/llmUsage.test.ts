import {describe, expect, it} from 'vitest'
import {toLlmUsageRecord, timeRangeStartMs, timeRangeBounds, parseLocalDateStartMs, parseLocalDateEndMs, computeKpis, tokensPerSecond, mergeByProvider, attachCosts, computeUsageCost} from '@shared/llmUsage'
import {extractToolCallCount, extractToolCalls, extractTextContent} from '@shared/utils/llmUsageParser'

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

  it('toLlmUsageRecord 透传 providerId', () => {
    const rec = toLlmUsageRecord(
      {providerType: 'openai', providerId: 'p1', providerName: 'Alpha', model: 'gpt-4o',
       inputTokens: 1, outputTokens: 1, duration: 10},
      {conversationId: 'c', messageId: 'm', seq: 0},
    )
    expect(rec.providerId).toBe('p1')
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
    {key: 'claude-opus-4', providerType: 'anthropic', providerName: 'Deepseek-ant', requestCount: 1, inputTokens: 50, outputTokens: 10, cacheReadTokens: 100, cacheWriteTokens: 0, totalTokens: 160, costUsd: 0.02, decodeMs: 2000, ttftMs: undefined, ttftCount: 0},
    // 历史数据无 providerName → 回退 providerType 独立成组，不得并入 Deepseek-ant
    {key: 'legacy-model', providerType: 'anthropic', providerName: undefined, requestCount: 1, inputTokens: 30, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 35, costUsd: 0.01},
    {key: 'gpt-4o', providerType: 'openai', providerName: 'OpenAI', requestCount: 3, inputTokens: 500, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 600, costUsd: 0.03},
  ]

  it('同服务商合并：token/成本/时序累加，providerName 非 NULL 优先，totalTokens 降序', () => {
    const merged = mergeByProvider(rows)
    // 服务商 = providers.name（非 NULL 优先）：Deepseek-ant（2 模型合并）、OpenAI、历史行回退 anthropic → 3 组
    expect(merged).toHaveLength(3)
    // totalTokens 降序：OpenAI 600 > Deepseek-ant 580 > anthropic(历史) 35
    expect(merged[0].key).toBe('OpenAI')
    expect(merged[0].requestCount).toBe(3)
    const deepseek = merged[1]
    expect(deepseek.key).toBe('Deepseek-ant')
    expect(deepseek.requestCount).toBe(3)
    expect(deepseek.inputTokens).toBe(150)
    expect(deepseek.outputTokens).toBe(30)
    expect(deepseek.cacheReadTokens).toBe(400)
    expect(deepseek.totalTokens).toBe(580)
    expect(deepseek.costUsd).toBeCloseTo(0.03, 10)
    expect(deepseek.decodeMs).toBe(7000)
    expect(deepseek.ttftMs).toBe(800)
    expect(deepseek.ttftCount).toBe(1)
    expect(deepseek.providerName).toBe('Deepseek-ant')
    const legacy = merged[2]
    expect(legacy.key).toBe('anthropic')
    expect(legacy.requestCount).toBe(1)
    expect(legacy.totalTokens).toBe(35)
  })

  it('空数组 → 空数组', () => {
    expect(mergeByProvider([])).toEqual([])
  })

  // 回归测试：同 provider_type 下多个服务商（providers.name 不同）必须分开统计，
  // 仅 API 风格相同（如 anthropic 类型下的 Deepseek-ant/dsh/xiaomimimo）不得合并为一组。
  // 复现现场：2026-08-25 今天数据 4 个服务商 → 按服务商视图只显示 2 个（anthropic/openai 各一组）。
  it('同 providerType 不同 providerName → 按服务商分开（不合并）', () => {
    const rows = [
      // 今天 DB 实际数据：provider_type=anthropic 的 3 个服务商
      {key: 'deepseek-v4-flash-vision-exp', providerType: 'anthropic', providerName: 'Deepseek-ant', requestCount: 2, inputTokens: 100, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 0, totalTokens: 420, costUsd: 0.01, decodeMs: 5000, ttftMs: 800, ttftCount: 1},
      {key: 'deepseek-v4-flash', providerType: 'anthropic', providerName: 'dsh', requestCount: 1, inputTokens: 50, outputTokens: 10, cacheReadTokens: 100, cacheWriteTokens: 0, totalTokens: 160, costUsd: 0.02, decodeMs: 2000, ttftMs: undefined, ttftCount: 0},
      {key: 'mimo-v2.5', providerType: 'anthropic', providerName: 'xiaomimimo', requestCount: 3, inputTokens: 200, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 240, costUsd: 0.03},
      // openai 风格的服务商
      {key: 'stealth/ox-alpha', providerType: 'openai', providerName: 'OpenRouter', requestCount: 4, inputTokens: 300, outputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 360, costUsd: 0.04},
    ]
    const merged = mergeByProvider(rows)
    // 4 个服务商（providerName 均不同）→ 必须 4 组，而非按 providerType 合并成 2 组
    expect(merged).toHaveLength(4)
    expect(merged.map(b => b.key).sort()).toEqual(['Deepseek-ant', 'OpenRouter', 'dsh', 'xiaomimimo'])
    // 每组的计量只含本服务商数据
    const deepseekAnt = merged.find(b => b.key === 'Deepseek-ant')!
    expect(deepseekAnt.requestCount).toBe(2)
    expect(deepseekAnt.totalTokens).toBe(420)
    const xiaomi = merged.find(b => b.key === 'xiaomimimo')!
    expect(xiaomi.requestCount).toBe(3)
    expect(xiaomi.totalTokens).toBe(240)
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

describe('extractToolCallCount / extractToolCalls（工具调用解析）', () => {
  it('chat 流式：按 index 合并增量 tool_calls', () => {
    const raw = [
      'data: ' + JSON.stringify({choices: [{delta: {tool_calls: [{index: 0, function: {name: 'get_weather'}}]}}]}),
      'data: ' + JSON.stringify({choices: [{delta: {tool_calls: [{index: 0, function: {arguments: '{"city"'}}]}}]}),
      'data: ' + JSON.stringify({choices: [{delta: {tool_calls: [{index: 1, function: {name: 'read_file', arguments: '{"p":1}'}}]}}]}),
      'data: ' + JSON.stringify({choices: [{delta: {tool_calls: [{index: 0, function: {arguments: ': "BJ"}'}}]}}]}),
      'data: [DONE]',
    ].join('\n')
    const calls = extractToolCalls('chat', raw)!
    expect(calls).toHaveLength(2)
    expect(calls[0].name).toBe('get_weather')
    expect(JSON.parse(calls[0].args)).toEqual({city: 'BJ'})
    expect(extractToolCallCount('chat', raw)).toBe(2)
  })

  it('anthropic：content_block_start(tool_use) + input_json_delta 拼参数', () => {
    const raw = [
      'data: ' + JSON.stringify({type: 'content_block_start', index: 1, content_block: {type: 'tool_use', name: 'search'}}),
      'data: ' + JSON.stringify({type: 'content_block_delta', index: 1, delta: {type: 'input_json_delta', partial_json: '{"q":'}}),
      'data: ' + JSON.stringify({type: 'content_block_delta', index: 1, delta: {type: 'input_json_delta', partial_json: '"llm"}'}}),
      'data: ' + JSON.stringify({type: 'content_block_stop', index: 1}),
      // 非 tool_use 块不计入
      'data: ' + JSON.stringify({type: 'content_block_start', index: 2, content_block: {type: 'text'}}),
    ].join('\n')
    const calls = extractToolCalls('anthropic', raw)!
    expect(calls).toHaveLength(1)
    expect(JSON.parse(calls[0].args)).toEqual({q: 'llm'})
    expect(extractToolCallCount('anthropic', raw)).toBe(1)
  })

  it('google：数 functionCall 出现次数（含流式数组）', () => {
    const chunk = (fc: unknown) => ({candidates: [{content: {parts: [{functionCall: fc}]}}]})
    const raw = JSON.stringify([chunk({name: 'a', args: {x: 1}}), chunk({name: 'b'})])
    const calls = extractToolCalls('google', raw)!
    expect(calls.map(c => c.name)).toEqual(['a', 'b'])
    expect(extractToolCallCount('google', raw)).toBe(2)
  })

  it('responses：response.output 中 type 含 function_call 的项，按 id 去重', () => {
    const item = {id: 'fc_1', type: 'function_call', name: 'calc', arguments: '{"n":2}'}
    const raw = [
      'data: ' + JSON.stringify({type: 'response.output_item.done', item}),
      'data: ' + JSON.stringify({type: 'response.completed', response: {output: [item]}}),
    ].join('\n')
    const calls = extractToolCalls('responses', raw)!
    expect(calls).toHaveLength(1)
    expect(extractToolCallCount('responses', raw)).toBe(1)
  })

  it('解析失败/无工具调用 → null，绝不抛错', () => {
    expect(extractToolCalls('chat', 'not json at all')).toBeNull()
    expect(extractToolCallCount('responses', '')).toBeNull()
    expect(extractToolCallCount('unknown-style', '{}')).toBeNull()
  })
})

describe('extractTextContent（正文连贯文本提取）', () => {
  it('chat 流式：顺序拼接 delta.content', () => {
    const raw = [
      'data: ' + JSON.stringify({choices: [{delta: {role: 'assistant'}}]}),
      'data: ' + JSON.stringify({choices: [{delta: {content: '你好'}}]}),
      'data: ' + JSON.stringify({choices: [{delta: {content: '，世界'}}]}),
      'data: [DONE]',
    ].join('\n')
    expect(extractTextContent('chat', raw)).toBe('你好，世界')
  })

  it('chat 非流式：message.content 兜底', () => {
    const raw = JSON.stringify({choices: [{message: {content: 'hello'}}]})
    expect(extractTextContent('chat', raw)).toBe('hello')
  })

  it('anthropic：text 块 + text_delta 拼接；混合 tool_use 块只取 text', () => {
    const raw = [
      'data: ' + JSON.stringify({type: 'content_block_start', index: 0, content_block: {type: 'text', text: ''}}),
      'data: ' + JSON.stringify({type: 'content_block_delta', index: 0, delta: {type: 'text_delta', text: '段一'}}),
      'data: ' + JSON.stringify({type: 'content_block_start', index: 1, content_block: {type: 'tool_use', name: 'f'}}),
      'data: ' + JSON.stringify({type: 'content_block_delta', index: 1, delta: {type: 'input_json_delta', partial_json: '{}'}}),
      'data: ' + JSON.stringify({type: 'content_block_start', index: 2, content_block: {type: 'text', text: '段二'}}),
    ].join('\n')
    expect(extractTextContent('anthropic', raw)).toBe('段一段二')
  })

  it('responses：output 中 message 的 output_text 拼接（流式 delta 增量）', () => {
    const raw = [
      'data: ' + JSON.stringify({type: 'response.output_text.delta', delta: 'ab'}),
      'data: ' + JSON.stringify({type: 'response.output_text.delta', delta: 'cd'}),
    ].join('\n')
    expect(extractTextContent('responses', raw)).toBe('abcd')
    const raw2 = JSON.stringify({response: {output: [
      {type: 'message', content: [{type: 'output_text', text: 'x'}, {type: 'output_text', text: 'y'}]},
      {type: 'function_call', name: 'f'},
    ]}})
    expect(extractTextContent('responses', raw2)).toBe('xy')
  })

  it('google：candidates[0].content.parts 的 text 拼接', () => {
    const raw = JSON.stringify({candidates: [{content: {parts: [{text: 'a'}, {text: 'b'}]}}]})
    expect(extractTextContent('google', raw)).toBe('ab')
  })

  it('空/坏输入 → null，绝不抛错', () => {
    expect(extractTextContent('chat', '')).toBeNull()
    expect(extractTextContent('chat', 'not json at all')).toBeNull()
    expect(extractTextContent('unknown-style', 'data: {}')).toBeNull()
    expect(extractTextContent('anthropic', 'data: ' + JSON.stringify({type: 'content_block_delta'}))).toBeNull()
  })
})

describe('cacheWritePrice', () => {
  const row = {model: 'm', inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 2000}
  it('缺省 cacheWritePrice → 成本计 0（向后兼容）', () => {
    const cost = computeUsageCost(row as any, () => ({inputPrice: 1e-6, outputPrice: 2e-6, cacheReadPrice: 0}))
    expect(cost).toBeCloseTo(1000 * 1e-6 + 1000 * 2e-6, 12)
  })
  it('显式 cacheWritePrice 计入成本', () => {
    const cost = computeUsageCost(row as any, () => ({inputPrice: 1e-6, outputPrice: 2e-6, cacheReadPrice: 0, cacheWritePrice: 5e-6} as any))
    expect(cost).toBeCloseTo(1000 * 1e-6 + 1000 * 2e-6 + 2000 * 5e-6, 12)
  })
})
