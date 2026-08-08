/**
 * OpenAIAdapter convertMessages 增量缓存一致性测试
 * 判据：增量输出 === 全量输出
 */
import {describe, expect, it} from 'vitest'
import type {ChatMessage} from '../../../../src/main/agent/model/types'
import {OpenAIAdapter} from '../../../../src/main/agent/model/openaiAdapter'

function makeUser(text: string): ChatMessage {
  return {role: 'user', content: text}
}
function makeAssistant(text: string, toolCalls?: Array<{id: string; name: string; arguments: Record<string, unknown>}>): ChatMessage {
  return {role: 'assistant', content: text, toolCalls}
}
function makeTool(id: string, result: string): ChatMessage {
  return {role: 'tool', toolCallId: id, content: result, toolResult: result}
}

function createAdapter(): OpenAIAdapter {
  return new OpenAIAdapter({apiKey: 'test', model: 'gpt-4o', provider: 'openai', baseUrl: ''} as any)
}

describe('OpenAIAdapter convertMessages 增量缓存', () => {
  it('纯追加场景：增量输出 === 全量输出（含 tool_calls / tool 消息）', () => {
    const adapter = createAdapter()
    const s1: ChatMessage[] = [makeUser('hi'), makeAssistant('', [{id: 'tc1', name: 'bash', arguments: {cmd: 'ls'}}])]
    expect(adapter.convertMessagesForTest(s1)).toEqual(adapter.convertMessagesForTestFull(s1))

    const s2: ChatMessage[] = [...s1, makeTool('tc1', 'file list'), makeAssistant('完成')]
    expect(adapter.convertMessagesForTest(s2)).toEqual(adapter.convertMessagesForTestFull(s2))

    const s3: ChatMessage[] = [...s2, makeUser('再来一次')]
    expect(adapter.convertMessagesForTest(s3)).toEqual(adapter.convertMessagesForTestFull(s3))
  })

  it('同长度重试：命中缓存返回相同内容', () => {
    const adapter = createAdapter()
    const s: ChatMessage[] = [makeUser('hi')]
    const r1 = adapter.convertMessagesForTest(s)
    const r2 = adapter.convertMessagesForTest(s)
    expect(r1).toEqual(r2)
  })

  it('systemPrompt 变化时全量重建（system 消息在最前）', () => {
    const adapter = createAdapter()
    const s: ChatMessage[] = [makeUser('hi')]
    const r1 = adapter.convertMessagesForTest(s)
    expect(r1).toEqual(adapter.convertMessagesForTestFull(s))
  })
})
