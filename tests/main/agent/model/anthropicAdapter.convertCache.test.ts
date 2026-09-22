/**
 * AnthropicAdapter convertMessagesIncremental 增量一致性测试
 * 判据：增量输出 === 全量输出（apiMessages 与 systemText 逐条一致）
 */
import {describe, expect, it} from 'vitest'
import type {ChatMessage, ChatParams, ToolDefinition} from '../../../../src/main/agent/model/types'
import {AnthropicAdapter, convertMessages, convertMessagesIncremental} from '../../../../src/main/agent/model/anthropicAdapter'

function makeUserMsg(text: string): ChatMessage {
  return {role: 'user', content: text}
}
function makeAssistantMsg(text: string, toolCalls?: Array<{id: string; name: string; arguments: Record<string, unknown>}>): ChatMessage {
  return {role: 'assistant', content: text, toolCalls}
}
function makeToolMsg(toolCallId: string, result: string): ChatMessage {
  return {role: 'tool', toolCallId, content: result, toolResult: result}

}

function makeSystemMsg(text: string): ChatMessage {
  return {role: 'system', content: text}
}

describe('convertMessagesIncremental — 增量与全量输出一致', () => {
  it('纯追加场景：逐条新增后增量输出 === 全量输出', () => {
    const s1: ChatMessage[] = [
      makeUserMsg('hi'),
      makeAssistantMsg('', [{id: 'tc1', name: 'bash', arguments: {}}]),
      makeToolMsg('tc1', 'done'),
    ]
    const inc1 = convertMessagesIncremental(s1, false, false, null)
    const full1 = convertMessages(s1, false, false)
    expect(inc1.apiMessages).toEqual(full1.apiMessages)
    expect(inc1.cache).not.toBeNull()

    const s2: ChatMessage[] = [...s1, makeUserMsg('继续'), makeAssistantMsg('结果如下')]
    const inc2 = convertMessagesIncremental(s2, false, false, inc1.cache)
    const full2 = convertMessages(s2, false, false)
    expect(inc2.apiMessages).toEqual(full2.apiMessages)
  })

  it('跨边界 tool 消息合并：新增段以 tool 开头时与全量一致', () => {
    const base: ChatMessage[] = [makeUserMsg('运行命令'), makeAssistantMsg('', [{id: 'tc1', name: 'bash', arguments: {}}])]
    const inc1 = convertMessagesIncremental(base, false, false, null)
    const s2: ChatMessage[] = [...base, makeToolMsg('tc1', 'ok')]
    const inc2 = convertMessagesIncremental(s2, false, false, inc1.cache)
    const full2 = convertMessages(s2, false, false)
    expect(inc2.apiMessages).toEqual(full2.apiMessages)
  })

  it('同长度重试：命中缓存', () => {
    const s: ChatMessage[] = [makeUserMsg('hi')]
    const inc1 = convertMessagesIncremental(s, false, false, null)
    const inc2 = convertMessagesIncremental(s, false, false, inc1.cache)
    expect(inc2.apiMessages).toBe(inc1.apiMessages)
    expect(inc2.cache).toBe(inc1.cache)
  })

  it('thinking 场景回退全量', () => {
    const s: ChatMessage[] = [makeUserMsg('hi'), makeAssistantMsg('think')]
    const inc = convertMessagesIncremental(s, true, false, null)
    const full = convertMessages(s, true, false)
    expect(inc.apiMessages).toEqual(full.apiMessages)
  })
})

describe('convertMessagesIncremental — 注入 system 消息原位保留一致性', () => {
  it('新增段以 injectMessage（system）结尾：增量输出 === 全量输出', () => {
    const s1: ChatMessage[] = [
      makeUserMsg('hi'),
      makeAssistantMsg('', [{id: 'tc1', name: 'skill', arguments: {}}]),
      makeToolMsg('tc1', 'preview'),
    ]
    const inc1 = convertMessagesIncremental(s1, false, false, null)
    const s2: ChatMessage[] = [...s1, makeSystemMsg('完整指导')]
    const inc2 = convertMessagesIncremental(s2, false, false, inc1.cache)
    const full2 = convertMessages(s2, false, false)
    expect(inc2.apiMessages).toEqual(full2.apiMessages)
    // 注入文本原位出现在末尾 user 消息中
    const last = full2.apiMessages[full2.apiMessages.length - 1]
    expect(last.role).toBe('user')
    expect(JSON.stringify(last.content)).toContain('完整指导')
  })
})

// ─── P0-2：tools 生成端顺序稳定（键序 + 数组序）─────────────────
/**
 * 前缀缓存要求请求体字节稳定：tools 位于前缀最前，其 JSON 键序与数组顺序
 * 任一变化都会让供应商侧前缀命中归零。
 *
 * 现有 toolsSentRecord.test.ts 只测「比较函数对顺序敏感」（发现变化），
 * 本组补的是**生成端顺序稳定**（不产生无谓变化）——生成端被改坏时此前无人发现。
 *
 * 接缝：convertTools 为 anthropicAdapter 模块私有函数，经 adapter.chat() 捕获
 * requestParams.tools 观察其输出（与真实发往供应商的字节同源）。
 */
function makeCapturingClient() {
  const calls: Array<Record<string, unknown>> = []
  const client: any = {
    baseURL: '', // 空 → isThirdPartyAPI 回退按模型名判定（claude-* → 非第三方）
    messages: {
      stream: (params: Record<string, unknown>) => {
        calls.push(params)
        return {abort() {}, [Symbol.asyncIterator]: async function* () {}}
      },
    },
  }
  return {client, calls}
}

function toolDef(name: string, description = `${name} desc`): ToolDefinition {
  return {
    name,
    description,
    inputSchema: {type: 'object', properties: {x: {type: 'string'}}, required: ['x']},
  }
}

async function captureSentTools(tools: ToolDefinition[], features?: Record<string, unknown>) {
  const {client, calls} = makeCapturingClient()
  const adapter = new AnthropicAdapter(
    {model: 'claude-sonnet-4-20250514', apiKey: 'sk-test', features} as any,
    client,
  )
  for await (const _chunk of adapter.chat({
    messages: [{role: 'user', content: 'hi'}],
    systemPrompt: 'sys',
    tools,
  } as ChatParams)) { /* 仅驱动到 stream 创建，捕获请求参数 */ }
  return calls[0]?.tools as Array<Record<string, unknown>> | undefined
}

describe('convertTools 生成端顺序稳定（P0-2）', () => {
  it('JSON 键序固定为 name, description, input_schema（字节序不得漂移）', async () => {
    const sent = (await captureSentTools([toolDef('alpha')]))!
    expect(sent).toHaveLength(1)
    expect(Object.keys(sent[0])).toEqual(['name', 'description', 'input_schema'])
    // 判别力自检：同样内容但键序打乱 → JSON 字节不同。
    // 说明上面的键序断言确实能捕获「生成端改序」造成的缓存断裂（非恒真断言）。
    const shuffled = JSON.stringify({
      description: sent[0].description,
      name: sent[0].name,
      input_schema: sent[0].input_schema,
    })
    expect(JSON.stringify(sent[0])).not.toBe(shuffled)
  })

  it('数组保序：输出顺序 === 输入顺序（不排序、不去重、不重排）', async () => {
    const input = ['zebra_tool', 'alpha_tool', 'mid_tool'].map(n => toolDef(n))
    const sent = (await captureSentTools(input))!
    expect(sent.map(t => t.name)).toEqual(['zebra_tool', 'alpha_tool', 'mid_tool'])
    // 判别力自检：与字典序不同 → 若生成端改为排序，本断言立即变红
    expect(sent.map(t => t.name)).not.toEqual(['alpha_tool', 'mid_tool', 'zebra_tool'])
  })

  it('同输入两次调用 → tools JSON 逐字节相等（无随机/时间因素）', async () => {
    const input = [toolDef('b'), toolDef('a')]
    const first = await captureSentTools(input)
    const second = await captureSentTools(input)
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })

  it('useContentBlocks：cache_control 仅挂末块且追加在键序末尾（键序仍固定）', async () => {
    const sent = (await captureSentTools(
      [toolDef('a'), toolDef('b'), toolDef('c')],
      {systemContentBlocks: true},
    ))!
    expect(sent).toHaveLength(3)
    expect(sent[0].cache_control).toBeUndefined()
    expect(sent[1].cache_control).toBeUndefined()
    expect(sent[2].cache_control).toEqual({type: 'ephemeral'})
    expect(Object.keys(sent[2])).toEqual(['name', 'description', 'input_schema', 'cache_control'])
  })

  it('useContentBlocks 缺省：末块不挂 cache_control（键序不含该键）', async () => {
    const sent = (await captureSentTools([toolDef('a'), toolDef('b')]))!
    for (const t of sent) {
      expect(Object.keys(t)).toEqual(['name', 'description', 'input_schema'])
    }
  })
})
