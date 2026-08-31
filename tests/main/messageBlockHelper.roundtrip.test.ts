// tests/main/messageBlockHelper.roundtrip.test.ts
// roundtrip 黄金测试（设计 §5.1）：blocksToMessage(messageToBlocks(msg)) 字段逐一深度断言。
// 禁止仅 JSON 全等比较——必须显式断言关键字段，防止"两错相消"。
import {describe, it, expect} from 'vitest'
import {messageToBlocks, blocksToMessage} from '../../src/main/repositories/sqlite/messageBlockHelper'
import type {Message, ToolCall, ThinkBlock} from '../../src/shared/types/message'

const CONV = 'conv-rt'

/** roundtrip 断言：序列化→反序列化后字段逐一比对（llmStats 按 B1 规则排除——
 *  llm_usage 唯一源，消息对象上的 llmStats 不参与落库/回读）。 */
export function assertRoundtrip(msg: Message): Message {
  const {messages: [record], blocks} = messageToBlocks(msg, CONV)
  const back = blocksToMessage(record, blocks)
  expect(back.id).toBe(msg.id)
  expect(back.role).toBe(msg.role)
  expect(back.timestamp).toBe(msg.timestamp)
  expect(back.endedAt).toBe(msg.endedAt)
  expect(back.content).toBe(msg.content)
  expect(back.attachments).toEqual(msg.attachments)
  if (msg.role === 'assistant') {
    // 现状语义：blocksToMessage 总是从 think 块回填扁平 thinkBlock（后向兼容）
    const expectedThink =
      msg.thinkBlock ?? msg.contentBlocks?.find(cb => cb.type === 'think')?.thinkBlock
    expect(back.thinkBlock).toEqual(expectedThink)
    expect(back.toolCalls).toEqual(msg.toolCalls)
    // 现状语义：仅当 contentBlocks 有意义（>1 块或含非 text 块）时才回填 contentBlocks；
    // 单一 text 块消息回读后 contentBlocks 为 undefined（旧消息扁平兼容路径）
    const hasMultipleTypes = msg.contentBlocks?.some(cb => cb.type !== 'text')
    if ((msg.contentBlocks?.length ?? 0) > 1 || hasMultipleTypes) {
      expect(back.contentBlocks).toEqual(msg.contentBlocks)
    } else {
      expect(back.contentBlocks).toBeUndefined()
    }
  }
  return back
}

describe('messageToBlocks/blocksToMessage roundtrip 黄金样本', () => {
  it('assistant：纯 text 单段', () => {
    assertRoundtrip({
      id: 'a1', role: 'assistant', content: '你好', timestamp: 1000,
      contentBlocks: [{id: 'a1-text-0', type: 'text', text: '你好'}],
    } as Message)
  })

  it('assistant：think + text + tool_call + tool_result 交错（contentBlocks 新路径）', () => {
    const tc: ToolCall = {
      id: 'tc1', name: 'read_file', arguments: {path: 'a.txt'}, status: 'success',
      textOffset: 6,
      result: {success: true, output: 'file body', toolResult: 'file body'},
    }
    const think: ThinkBlock = {id: 'a2-think-0', content: '思考中', status: 'complete', timestamp: 1001}
    assertRoundtrip({
      id: 'a2', role: 'assistant', content: '前文读取结果已收到', timestamp: 1000,
      thinkBlock: think,
      toolCalls: [tc],
      contentBlocks: [
        {id: 'a2-think-0', type: 'think', thinkBlock: think, turnIndex: 0},
        {id: 'a2-text-0', type: 'text', text: '前文', turnIndex: 0},
        {id: 'a2-tc-tc1', type: 'tool_use', toolCall: tc, turnIndex: 0},
        {id: 'a2-text-1', type: 'text', text: '读取结果已收到', turnIndex: 0},
      ],
    } as Message)
  })

  it('assistant：多轮 turnIndex 交错 + end 块', () => {
    assertRoundtrip({
      id: 'a3', role: 'assistant', content: 'r1r2', timestamp: 1000, endedAt: 9000,
      contentBlocks: [
        {id: 'a3-text-0', type: 'text', text: 'r1', turnIndex: 0},
        {id: 'a3-text-1', type: 'text', text: 'r2', turnIndex: 1},
        {id: 'a3-end', type: 'end', endedAt: 9000},
      ],
    } as Message)
  })

  it('assistant：空 content + 仅 think', () => {
    assertRoundtrip({
      id: 'a4', role: 'assistant', content: '', timestamp: 1000,
      contentBlocks: [{id: 'a4-think-0', type: 'think', thinkBlock: {id: 'a4-think-0', content: 'x', status: 'complete', timestamp: 1000}, turnIndex: 0}],
    } as Message)
  })
})

describe('metadata spread 防御与历史形态（messageBlockHelper.ts 序列化白名单注释即规范）', () => {
  it('user：顶层 attachments 序列化收敛进 metadata.attachments（单一形态，读回由 buildMessagesFromRows 重建）', () => {
    const msg = {
      id: 'u1', role: 'user', content: '看图', timestamp: 2000,
      attachments: [{path: 'E:/p/a.png', name: 'a.png', type: 'image/png', size: 1024}],
    } as unknown as Message
    const {messages: [record], blocks} = messageToBlocks(msg, CONV)
    expect(record.metadata?.attachments).toEqual([{path: 'E:/p/a.png', name: 'a.png', type: 'image/png', size: 1024}])
    const back = blocksToMessage(record, blocks)
    expect(back.metadata?.attachments).toEqual([{path: 'E:/p/a.png', name: 'a.png', type: 'image/png', size: 1024}])
  })

  it('★ user：历史形态 metadata.attachments（memo/handoff/渠道旧数据）不被具名字段 undefined 覆盖', () => {
    const msg = {
      id: 'u2', role: 'user', content: '看图', timestamp: 2000,
      metadata: {attachments: [{path: 'E:/p/a.png', name: 'a.png'}]},
    } as unknown as Message
    const {messages: [record], blocks} = messageToBlocks(msg, CONV)
    expect(record.metadata?.attachments).toEqual([{path: 'E:/p/a.png', name: 'a.png'}])
    const back = blocksToMessage(record, blocks)
    expect(back.metadata?.attachments).toEqual([{path: 'E:/p/a.png', name: 'a.png'}])
  })

  it('★ 未知 metadata 扩展字段透传（capability-catalog 的 sourceKind/catalogDigest 等，白名单会静默丢字段）', () => {
    const msg = {
      id: 'u3', role: 'user', content: 'x', timestamp: 3000,
      metadata: {sourceKind: 'memo', catalogDigest: 'abc', customFutureField: {nested: 1}},
    } as unknown as Message
    const {messages: [record]} = messageToBlocks(msg, CONV)
    expect(record.metadata?.sourceKind).toBe('memo')
    expect(record.metadata?.catalogDigest).toBe('abc')
    expect((record.metadata as Record<string, unknown>).customFutureField).toEqual({nested: 1})
  })

  it('user/system：content 存入 metadata.content（buildMessagesFromRows 读回依据）', () => {
    const {messages: [record]} = messageToBlocks({id: 'u4', role: 'user', content: '正文', timestamp: 1} as Message, CONV)
    expect(record.metadata?.content).toBe('正文')
  })

  it('compact 后消息（assistant contentBlocks 含 media 块）roundtrip', () => {
    assertRoundtrip({
      id: 'a5', role: 'assistant', content: '图', timestamp: 5000,
      contentBlocks: [
        {id: 'a5-media-0', type: 'media', media: {kind: 'image', path: 'E:/x.png', caption: '图'}},
        {id: 'a5-text-0', type: 'text', text: '图'},
      ],
    } as unknown as Message)
  })
})
