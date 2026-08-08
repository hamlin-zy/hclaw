/**
 * GoogleAdapter convertMessagesIncremental 受限增量一致性测试
 * 判据：增量输出 === 全量输出（history / lastUserMsg / systemText）
 */
import {describe, expect, it} from 'vitest'
import type {ChatMessage} from '../../../../src/main/agent/model/types'
import {convertMessages, convertMessagesIncremental} from '../../../../src/main/agent/model/googleAdapter'

function makeUser(text: string): ChatMessage {
  return {id: 'u1', role: 'user', content: text}
}
function makeAssistant(text: string): ChatMessage {
  return {id: 'a1', role: 'assistant', content: text}
}
function makeTool(id: string, result: string): ChatMessage {
  return {id: 't1', role: 'tool', toolCallId: id, content: result, toolResult: result}
}

describe('convertMessagesIncremental — 受限增量一致性', () => {
  it('新增段无 user：增量输出 === 全量输出', () => {
    const base: ChatMessage[] = [makeUser('hi')]
    const inc1 = convertMessagesIncremental(base, null)
    const full1 = convertMessages(base)
    expect(inc1.history).toEqual(full1.history)
    expect(inc1.lastUserMsg).toEqual(full1.lastUserMsg)
    expect(inc1.systemText).toBe(full1.systemText)

    const s2: ChatMessage[] = [...base, makeAssistant('结果')]
    const inc2 = convertMessagesIncremental(s2, inc1.cache)
    const full2 = convertMessages(s2)
    expect(inc2.history).toEqual(full2.history)
    expect(inc2.lastUserMsg).toEqual(full2.lastUserMsg)

    const s3: ChatMessage[] = [...s2, makeTool('tc1', 'tool out')]
    const inc3 = convertMessagesIncremental(s3, inc2.cache)
    const full3 = convertMessages(s3)
    expect(inc3.history).toEqual(full3.history)
    expect(inc3.lastUserMsg).toEqual(full3.lastUserMsg)
  })

  it('新增段含 user：强制全量，输出正确', () => {
    const base: ChatMessage[] = [makeUser('hi')]
    const inc1 = convertMessagesIncremental(base, null)
    const s2: ChatMessage[] = [...base, makeAssistant('结果'), makeUser('继续')]
    const inc2 = convertMessagesIncremental(s2, inc1.cache)
    const full2 = convertMessages(s2)
    expect(inc2.history).toEqual(full2.history)
    expect(inc2.lastUserMsg).toEqual(full2.lastUserMsg)
  })

  it('同长度重试：命中缓存', () => {
    const s: ChatMessage[] = [makeUser('hi')]
    const inc1 = convertMessagesIncremental(s, null)
    const inc2 = convertMessagesIncremental(s, inc1.cache)
    expect(inc2.history).toBe(inc1.history)
  })
})
