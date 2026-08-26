/**
 * AnthropicAdapter convertMessagesIncremental 增量一致性测试
 * 判据：增量输出 === 全量输出（apiMessages 与 systemText 逐条一致）
 */
import {describe, expect, it} from 'vitest'
import type {ChatMessage} from '../../../../src/main/agent/model/types'
import {convertMessages, convertMessagesIncremental} from '../../../../src/main/agent/model/anthropicAdapter'

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
