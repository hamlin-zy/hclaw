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

  it('根因场景：某次调用只返回 tool_calls（零 thinking/text）→ 该 tool_call 开启新轮', () => {
    // glm 等模型会出现纯 tool_call 响应：若无此修复，该调用块沿用上一轮
    // turnIndex，重建时并入上一组 assistant → 跨 turn 重建序列分叉 → 缓存断裂
    const {p, calls} = makeRecorder()
    const tc1 = {id: 'tc-1', name: 'bash', arguments: {}, status: 'running'}
    const tc2 = {id: 'tc-2', name: 'bash', arguments: {}, status: 'running'}

    persistStreamEvent(p, 'c1', 'm1', pending(), {type: 'text', content: '第一轮有文本'})
    persistStreamEvent(p, 'c1', 'm1', pending({toolCalls: [tc1]}), {type: 'tool_use', toolCall: tc1})
    persistStreamEvent(p, 'c1', 'm1', pending({toolCalls: [tc1]}), {type: 'tool_result', toolCallId: 'tc-1', toolName: 'bash', result: {output: 'a', success: true}})
    // 第二次调用：无 thinking/text，直接 tool_use → 必须是 turnIndex 1
    persistStreamEvent(p, 'c1', 'm1', pending({toolCalls: [tc2]}), {type: 'tool_use', toolCall: tc2})
    persistStreamEvent(p, 'c1', 'm1', pending({toolCalls: [tc2]}), {type: 'tool_result', toolCallId: 'tc-2', toolName: 'bash', result: {output: 'b', success: true}})
    persistStreamEvent(p, 'c1', 'm1', pending(), {type: 'text', content: '第三轮'})

    expect(calls.map(turnIndexOf)).toEqual([0, 0, 0, 1, 1, 2])
  })

  it('同一次调用内的并行 tool_use 不因新契约重复递增', () => {
    const {p, calls} = makeRecorder()
    const tc1 = {id: 'tc-1', name: 'bash', arguments: {}, status: 'running'}
    const tc2 = {id: 'tc-2', name: 'grep', arguments: {}, status: 'running'}

    persistStreamEvent(p, 'c1', 'm1', pending({toolCalls: [tc1]}), {type: 'tool_result', toolCallId: 'tc-1', toolName: 'bash', result: {output: 'a', success: true}})
    persistStreamEvent(p, 'c1', 'm1', pending(), {type: 'tool_use', toolCall: tc1})
    persistStreamEvent(p, 'c1', 'm1', pending(), {type: 'tool_use', toolCall: tc2})

    expect(calls.map(turnIndexOf)).toEqual([0, 1, 1])
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

  it('双通道重复投递：tool_start 第二次到达（tool_completed 之后）不得抬升 turnIndex', () => {
    // 根因背景（conv-b79d3cdd）：toolExecutor.execute 同时 events.push(tool_start)
    // （随 execEvents 延迟 yield）与 onEvent 即时推送；executeToolCalls 在所有工具
    // 结束后才 yield execEvents → 第二份 tool_start 落在 tool_completed（closeTurn
    // 置标记）之后 → turnForContent 消费标记 → tool_call/tool_result 块 turn_index
    // 虚高 1 → 重建时 text/think 与 tool_use 拆成两条 assistant → 跨 turn 前缀分叉
    // → 新 user 轮首请求 cache_read=0。
    const {p, calls} = makeRecorder()
    const tc = {id: 'tc-1', name: 'bash', arguments: {}, status: 'running'}
    const withTc = pending({toolCalls: [tc]})

    persistStreamEvent(p, 'c1', 'm1', pending(), {type: 'thinking', content: '思考'})
    persistStreamEvent(p, 'c1', 'm1', pending(), {type: 'text', content: '正文'})
    // 即时通道：tool_use → tool_start → tool_completed
    persistStreamEvent(p, 'c1', 'm1', pending(), {type: 'tool_use', toolCall: tc})
    persistStreamEvent(p, 'c1', 'm1', withTc, {type: 'tool_start', toolCall: tc})
    persistStreamEvent(p, 'c1', 'm1', withTc, {type: 'tool_completed', toolCallId: 'tc-1', result: {output: 'ok', success: true}})
    // 延迟通道：execEvents 里的 tool_start（重复）→ tool_result
    persistStreamEvent(p, 'c1', 'm1', withTc, {type: 'tool_start', toolCall: tc})
    persistStreamEvent(p, 'c1', 'm1', withTc, {type: 'tool_result', toolCallId: 'tc-1', toolName: 'bash', result: {output: 'ok', success: true}})
    // 下一轮内容块必须恰好 +1
    persistStreamEvent(p, 'c1', 'm1', pending(), {type: 'thinking', content: '第二轮'})

    const toolCallWrites = calls.filter(c => c.method === 'recordToolCallBlock')
    // 同一 toolCall 只落一次（重复 tool_start 不再重写 turnIndex）
    expect(toolCallWrites).toHaveLength(1)
    // 最终落库轮次：think/text/tool_call/tool_result 全 0，下一轮 think = 1
    expect(calls.map(turnIndexOf)).toEqual([0, 0, 0, 0, 0, 1])
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

describe('persistStreamEvent — think 块落库内容为段内增量（重建膨胀根因修复）', () => {
  beforeEach(() => {
    resetBridgeMsgState('m1')
  })

  it('多轮 think 落库内容 = 各轮增量之和，而非 pending.thinkParts 全量累积快照', () => {
    // 根因背景：此前 content 取 pending.thinkParts.join('')（整条消息累积快照），
    // 每轮 think 块都包含之前所有轮的 thinking → historyConverter 按 turn 分组
    // 拼接后每轮 reasoningContent 膨胀 → 重启重建请求 input 暴涨（74.6k→151k tokens）
    const {p, calls} = makeRecorder()
    const tc = {id: 'tc-1', name: 'bash', arguments: {}, status: 'running'}
    // manager pending.thinkParts 随流式持续累积（含之前所有轮）
    const pend = (n: number) => pending({thinkParts: Array.from({length: n}, (_, i) => `思考${i + 1}段`)})

    persistStreamEvent(p, 'c1', 'm1', pend(1), {type: 'thinking', content: '思'})
    persistStreamEvent(p, 'c1', 'm1', pend(1), {type: 'thinking', content: '考1段'})
    persistStreamEvent(p, 'c1', 'm1', pending({toolCalls: [tc]}), {type: 'tool_result', toolCallId: 'tc-1', toolName: 'bash', result: {output: 'ok', success: true}})
    persistStreamEvent(p, 'c1', 'm1', pend(2), {type: 'thinking', content: '思'})
    persistStreamEvent(p, 'c1', 'm1', pend(2), {type: 'thinking', content: '考2段'})

    const thinkCalls = calls.filter(c => c.method === 'recordThinkBlock')
    // 第 1 轮所有写入内容只含第 1 轮增量；第 2 轮只含第 2 轮增量（绝不含第 1 轮）
    expect(thinkCalls.slice(0, 2).map(c => c.args[3])).toEqual(['思', '思考1段'])
    expect(thinkCalls.slice(2).map(c => c.args[3])).toEqual(['思', '思考2段'])
  })

  it('同段内多次增量落库为段内累积（同 id 覆盖语义下的最终内容 = 该段全文）', () => {
    const {p, calls} = makeRecorder()

    persistStreamEvent(p, 'c1', 'm1', pending(), {type: 'thinking', content: 'A'})
    persistStreamEvent(p, 'c1', 'm1', pending(), {type: 'thinking', content: 'B'})
    persistStreamEvent(p, 'c1', 'm1', pending(), {type: 'thinking', content: 'C'})

    const thinkCalls = calls.filter(c => c.method === 'recordThinkBlock')
    expect(thinkCalls.map(c => c.args[3])).toEqual(['A', 'AB', 'ABC'])
    // 同段同 id（覆盖语义）
    const ids = new Set(thinkCalls.map(c => c.args[2]))
    expect(ids.size).toBe(1)
  })

  it('think→text→think 交错开启新段，段内容不跨段携带', () => {
    const {p, calls} = makeRecorder()

    persistStreamEvent(p, 'c1', 'm1', pending(), {type: 'thinking', content: '段1'})
    persistStreamEvent(p, 'c1', 'm1', pending(), {type: 'text', content: '正文'})
    persistStreamEvent(p, 'c1', 'm1', pending(), {type: 'thinking', content: '段2'})

    const thinkCalls = calls.filter(c => c.method === 'recordThinkBlock')
    expect(thinkCalls.map(c => c.args[3])).toEqual(['段1', '段2'])
    expect(new Set(thinkCalls.map(c => c.args[2])).size).toBe(2)
  })
})
