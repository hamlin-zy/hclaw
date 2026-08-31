/**
 * streamBridge turnIndex 轮次标注测试（方案 2 根治 · KV cache 断裂修复）。
 *
 * 根因背景：persistStreamEvent 此前接收 manager 传入的 turnIndex（仅在
 * user_message_injected 时递增），同一容器 assistant 消息内多次 LLM 调用的块
 * 全部 undefined → DB turn_index 全 NULL → historyConverter 恒走 think 边界
 * 切段 fallback → 单轮内多段 think 被过度拆分为 stub assistant → 重建序列
 * ≠ loop 内存态 → KV cache 断裂。
 *
 * 修复契约：一次 LLM 调用 = 一个 turnIndex。tool_result/tool_denied 必然是
 * 一次调用的收尾，其后首个 thinking/text 块开启下一轮（turnIndex +1）。
 */
import {beforeEach, describe, expect, it} from 'vitest'
import {persistStreamEvent, resetBridgeMsgState} from '@/main/persistence/streamBridge'
import type {ConversationPersistence} from '@/main/persistence/conversationPersistence'

interface Recorded {
  method: string
  args: unknown[]
}

function makeRecorder(): {p: ConversationPersistence; calls: Recorded[]} {
  const calls: Recorded[] = []
  const p = {
    recordTextChunk: (...args: unknown[]) => calls.push({method: 'recordTextChunk', args}),
    recordThinkBlock: (...args: unknown[]) => calls.push({method: 'recordThinkBlock', args}),
    recordToolCallBlock: (...args: unknown[]) => calls.push({method: 'recordToolCallBlock', args}),
    recordToolResultBlock: (...args: unknown[]) => calls.push({method: 'recordToolResultBlock', args}),
  } as unknown as ConversationPersistence
  return {p, calls}
}

const turnIndexOf = (c: Recorded) => c.args[c.args.length - 1] as number | undefined

function pending(overrides: Record<string, unknown> = {}) {
  return {id: 'm1', toolCalls: [], ...overrides} as never
}

describe('persistStreamEvent — 按 LLM 调用轮次标注 turnIndex', () => {
  beforeEach(() => {
    // streamBridge 的轮次状态是模块级（按 msgId 记账），测试间必须重置
    resetBridgeMsgState('m1')
  })

  it('同一次调用内（think→text→tool_use→tool_result）所有块共享 turnIndex 0', () => {
    const {p, calls} = makeRecorder()
    const tc = {id: 'tc-1', name: 'bash', arguments: {}, status: 'running'}

    persistStreamEvent(p, 'c1', 'm1', pending(), {type: 'thinking', content: '思考'})
    persistStreamEvent(p, 'c1', 'm1', pending(), {type: 'text', content: '正文'})
    persistStreamEvent(p, 'c1', 'm1', pending(), {type: 'tool_use', toolCall: tc})
    persistStreamEvent(p, 'c1', 'm1', pending({toolCalls: [tc]}), {type: 'tool_result', toolCallId: 'tc-1', toolName: 'bash', result: {output: 'ok', success: true}})

    expect(calls).toHaveLength(4)
    expect(calls.map(turnIndexOf)).toEqual([0, 0, 0, 0])
  })

  it('tool_result 之后的首个 thinking 开启下一轮（turnIndex +1）——根因场景', () => {
    const {p, calls} = makeRecorder()
    const tc = {id: 'tc-1', name: 'bash', arguments: {}, status: 'running'}

    persistStreamEvent(p, 'c1', 'm1', pending(), {type: 'thinking', content: '第一轮思考'})
    persistStreamEvent(p, 'c1', 'm1', pending({toolCalls: [tc]}), {type: 'tool_result', toolCallId: 'tc-1', toolName: 'bash', result: {output: 'ok', success: true}})
    // 同一轮内 think→text→think 交错（真实 DB 数据形态）：不递增
    persistStreamEvent(p, 'c1', 'm1', pending(), {type: 'thinking', content: '第二轮思考A'})
    persistStreamEvent(p, 'c1', 'm1', pending(), {type: 'text', content: '先按'})
    persistStreamEvent(p, 'c1', 'm1', pending(), {type: 'thinking', content: '第二轮思考B'})
    persistStreamEvent(p, 'c1', 'm1', pending(), {type: 'text', content: '流程做...'})

    expect(calls.map(turnIndexOf)).toEqual([0, 0, 1, 1, 1, 1])
  })

  it('无思考模型：tool_result 之后的首个 text 也开启下一轮', () => {
    const {p, calls} = makeRecorder()
    const tc = {id: 'tc-1', name: 'bash', arguments: {}, status: 'running'}

    persistStreamEvent(p, 'c1', 'm1', pending(), {type: 'text', content: '第一轮'})
    persistStreamEvent(p, 'c1', 'm1', pending({toolCalls: [tc]}), {type: 'tool_result', toolCallId: 'tc-1', toolName: 'bash', result: {output: 'ok', success: true}})
    persistStreamEvent(p, 'c1', 'm1', pending(), {type: 'text', content: '第二轮'})

    expect(calls.map(turnIndexOf)).toEqual([0, 0, 1])
  })

  it('tool_denied 同样构成轮次边界', () => {
    const {p, calls} = makeRecorder()
    const tc = {id: 'tc-1', name: 'bash', arguments: {}, status: 'running'}

    persistStreamEvent(p, 'c1', 'm1', pending({toolCalls: [tc]}), {type: 'tool_denied', toolCallId: 'tc-1', reason: 'deny'})
    persistStreamEvent(p, 'c1', 'm1', pending(), {type: 'thinking', content: '下一轮'})

    expect(calls.map(turnIndexOf)).toEqual([0, 1])
  })

  it('同轮内多个 tool_use/tool_result 不重复递增', () => {
    const {p, calls} = makeRecorder()
    const tc1 = {id: 'tc-1', name: 'bash', arguments: {}, status: 'running'}
    const tc2 = {id: 'tc-2', name: 'grep', arguments: {}, status: 'running'}

    persistStreamEvent(p, 'c1', 'm1', pending({toolCalls: [tc1]}), {type: 'tool_result', toolCallId: 'tc-1', toolName: 'bash', result: {output: 'a', success: true}})
    persistStreamEvent(p, 'c1', 'm1', pending({toolCalls: [tc2]}), {type: 'tool_result', toolCallId: 'tc-2', toolName: 'bash', result: {output: 'b', success: true}})
    persistStreamEvent(p, 'c1', 'm1', pending(), {type: 'thinking', content: '下一轮'})

    expect(calls.map(turnIndexOf)).toEqual([0, 0, 1])
  })

  it('新消息（msgId 变化）轮次从 0 重新计数', () => {
    const {p, calls} = makeRecorder()

    persistStreamEvent(p, 'c1', 'm1', pending(), {type: 'thinking', content: 'a'})
    persistStreamEvent(p, 'c1', 'm1', pending(), {type: 'thinking', content: 'b'})
    persistStreamEvent(p, 'c1', 'm2', pending(), {type: 'thinking', content: 'c'})

    expect(calls.map(turnIndexOf)).toEqual([0, 0, 0])
  })

  it('resetBridgeMsgState 清理轮次状态（消息终结）', () => {
    const {p, calls} = makeRecorder()
    const tc = {id: 'tc-1', name: 'bash', arguments: {}, status: 'running'}

    persistStreamEvent(p, 'c1', 'm1', pending({toolCalls: [tc]}), {type: 'tool_result', toolCallId: 'tc-1', toolName: 'bash', result: {output: 'ok', success: true}})
    resetBridgeMsgState('m1')
    persistStreamEvent(p, 'c1', 'm1', pending(), {type: 'thinking', content: '重启后'})

    expect(calls.map(turnIndexOf)).toEqual([0, 0])
  })
})
