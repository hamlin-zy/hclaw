/**
 * 块 id 派生稳定化测试（turnIndex 轮次派生 · TDD 红灯用例）。
 *
 * 契约（冻结）：
 *   text 块 id  = `text-${msgId}-t${turn}`
 *   think 块 id = `think-${msgId}-t${turn}`
 *   turn 取自 turnForContent(msgId)：一次 LLM 调用 = 一个轮次，tool_result/tool_denied
 *   收尾后首个内容块开启下一轮。
 *
 * 根因（现场实证消息 a66c45e5）：text 块 id 后缀 = think 段号 + pending.toolCalls.length、
 * think 段号随 text 事件漂移 → 同一段连续思考被 text 切成 think-…-12 / think-…-13，
 * 同一段正文被切成 text-…-31 / text-…-32 → 重启后 think 尾部碎片插进正文中间。
 *
 * 修复后不变量：一次 LLM 调用内 think 恒为一个块、text 恒为一个块（内容由同 id
 * 覆盖/追加语义累积），块先后由同轮内首次 INSERT 顺序决定。
 */
import {beforeEach, describe, expect, it} from 'vitest'
import {persistStreamEvent, resetBridgeMsgState} from '@/main/persistence/streamBridge'
import type {ConversationPersistence} from '@/main/persistence/conversationPersistence'

interface Recorded {
  method: string
  args: unknown[]
}

interface MaterializedBlock {
  id: string
  blockType: string
  content: string
  turnIndex?: number
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

/**
 * 按 conversationRepository.writeBlockDelta 的 UPSERT 语义物化块：
 * text 块同 id 追加（DB 层 `content || ?`），think 块同 id 覆盖。
 * 桥接层传出的 text 块 id 由 conversationPersistence 拼接为 `text-${msgId}-${blockSuffix}`。
 */
function materialize(calls: Recorded[]): MaterializedBlock[] {
  const order: string[] = []
  const map = new Map<string, MaterializedBlock>()
  for (const c of calls) {
    let id: string
    let blockType: string
    let content: string
    let turnIndex: number | undefined
    if (c.method === 'recordTextChunk') {
      const [, msgId, blockSuffix, chunk, turn] = c.args as [string, string, string, string, number | undefined]
      id = `text-${msgId}-${blockSuffix}`
      blockType = 'text'
      content = chunk
      turnIndex = turn
    } else if (c.method === 'recordThinkBlock') {
      const [, , blockId, thinkContent, , turn] = c.args as [string, string, string, string, string, number | undefined]
      id = blockId
      blockType = 'think'
      content = thinkContent
      turnIndex = turn
    } else {
      continue
    }
    const prev = map.get(id)
    if (!prev) order.push(id)
    const merged = blockType === 'text' && prev
      ? prev.content + content          // 追加语义
      : content                         // 覆盖语义
    map.set(id, {id, blockType, content: merged, turnIndex})
  }
  return order.map(id => map.get(id)!)
}

const textOf = (b: MaterializedBlock[], type: string) => b.filter(x => x.blockType === type)

function pending(overrides: Record<string, unknown> = {}) {
  return {id: 'm1', toolCalls: [], ...overrides} as never
}

describe('persistStreamEvent — 块 id 按 turnIndex 派生（一次调用 think/text 各一块）', () => {
  beforeEach(() => {
    resetBridgeMsgState('m1')
  })

  it('根因场景：同轮 think("…好")→text("## 结论先行\\n\\n| ")→think("，写。")→text("关注面…") 落库为 1 think + 1 text', () => {
    const {p, calls} = makeRecorder()

    persistStreamEvent(p, 'c1', 'm1', pending(), {type: 'thinking', content: '…好'})
    persistStreamEvent(p, 'c1', 'm1', pending(), {type: 'text', content: '## 结论先行\n\n| '})
    persistStreamEvent(p, 'c1', 'm1', pending(), {type: 'thinking', content: '，写。'})
    persistStreamEvent(p, 'c1', 'm1', pending(), {type: 'text', content: '关注面 | …'})

    const blocks = materialize(calls)
    const thinks = textOf(blocks, 'think')
    const texts = textOf(blocks, 'text')

    expect(thinks).toHaveLength(1)
    expect(thinks[0].id).toBe('think-m1-t0')
    expect(thinks[0].content).toBe('…好，写。')     // 两段思考拼接（think 尾部碎片归位）

    expect(texts).toHaveLength(1)
    expect(texts[0].id).toBe('text-m1-t0')
    expect(texts[0].content).toBe('## 结论先行\n\n| 关注面 | …')   // 正文不再被切成两段
    expect(thinks[0].turnIndex).toBe(0)
    expect(texts[0].turnIndex).toBe(0)
  })

  it('text 块 id 后缀不随 think 段数 / pending.toolCalls 数漂移（现场根因直接回归）', () => {
    const {p, calls} = makeRecorder()
    const tc = {id: 'tc-1', name: 'bash', arguments: {}, status: 'running'}

    // 同一轮内：先 think，再 text，且 pending 已携带 1 个 toolCall
    persistStreamEvent(p, 'c1', 'm1', pending({toolCalls: [tc]}), {type: 'thinking', content: '想'})
    persistStreamEvent(p, 'c1', 'm1', pending({toolCalls: [tc]}), {type: 'text', content: '正文A'})
    persistStreamEvent(p, 'c1', 'm1', pending({toolCalls: [tc]}), {type: 'text', content: '正文B'})

    const suffixes = calls.filter(c => c.method === 'recordTextChunk').map(c => c.args[2])
    expect(suffixes).toEqual(['t0', 't0'])          // 恒为轮次后缀，与 toolCalls.length 无关
    expect(materialize(calls).filter(b => b.blockType === 'text')).toHaveLength(1)
  })

  it('轮次边界（tool_result 后）开启新块：think-m1-t1 / text-m1-t1，且内容不跨轮携带', () => {
    const {p, calls} = makeRecorder()
    const tc = {id: 'tc-1', name: 'bash', arguments: {}, status: 'running'}

    persistStreamEvent(p, 'c1', 'm1', pending(), {type: 'thinking', content: '第一轮思考'})
    persistStreamEvent(p, 'c1', 'm1', pending(), {type: 'text', content: '第一轮正文'})
    persistStreamEvent(p, 'c1', 'm1', pending({toolCalls: [tc]}), {type: 'tool_result', toolCallId: 'tc-1', toolName: 'bash', result: {output: 'ok', success: true}})
    persistStreamEvent(p, 'c1', 'm1', pending(), {type: 'thinking', content: '第二轮思考'})
    persistStreamEvent(p, 'c1', 'm1', pending(), {type: 'text', content: '第二轮正文'})

    const blocks = materialize(calls)
    const thinks = textOf(blocks, 'think')
    const texts = textOf(blocks, 'text')

    expect(thinks.map(b => b.id)).toEqual(['think-m1-t0', 'think-m1-t1'])
    expect(thinks.map(b => b.content)).toEqual(['第一轮思考', '第二轮思考'])   // 不吃上一轮累积
    expect(texts.map(b => b.id)).toEqual(['text-m1-t0', 'text-m1-t1'])
    expect(texts.map(b => b.turnIndex)).toEqual([0, 1])
  })

  it('同轮内 think→tool_use→think（工具交错）仍为同一 think 块且内容拼接', () => {
    const {p, calls} = makeRecorder()
    const tc = {id: 'tc-1', name: 'bash', arguments: {}, status: 'running'}

    persistStreamEvent(p, 'c1', 'm1', pending(), {type: 'thinking', content: '前半'})
    persistStreamEvent(p, 'c1', 'm1', pending({toolCalls: [tc]}), {type: 'tool_use', toolCall: tc})
    persistStreamEvent(p, 'c1', 'm1', pending({toolCalls: [tc]}), {type: 'thinking', content: '后半'})

    const thinks = materialize(calls).filter(b => b.blockType === 'think')
    expect(thinks).toHaveLength(1)
    expect(thinks[0].id).toBe('think-m1-t0')
    expect(thinks[0].content).toBe('前半后半')
  })

  it('resetBridgeMsgState 清理轮次与累积状态：重置后从 t0 重新开始且不携带旧内容', () => {
    const {p, calls} = makeRecorder()

    persistStreamEvent(p, 'c1', 'm1', pending(), {type: 'thinking', content: '旧轮思考'})
    resetBridgeMsgState('m1')
    persistStreamEvent(p, 'c1', 'm1', pending(), {type: 'thinking', content: '新消息思考'})

    // think 块为同 id 覆盖语义：重置后同 msgId 仍归 t0（轮次清零），内容不携带旧轮累积
    const thinkCalls = calls.filter(c => c.method === 'recordThinkBlock')
    expect(thinkCalls.map(c => c.args[2])).toEqual(['think-m1-t0', 'think-m1-t0'])
    expect(thinkCalls.map(c => c.args[3])).toEqual(['旧轮思考', '新消息思考'])
  })

  it('不同 msgId 的轮次互不干扰（各自 t0 起）', () => {
    const {p, calls} = makeRecorder()
    const tc = {id: 'tc-1', name: 'bash', arguments: {}, status: 'running'}

    persistStreamEvent(p, 'c1', 'm1', pending({toolCalls: [tc]}), {type: 'tool_result', toolCallId: 'tc-1', toolName: 'bash', result: {output: 'ok', success: true}})
    persistStreamEvent(p, 'c1', 'm2', pending(), {type: 'thinking', content: 'm2 首轮'})

    const thinks = materialize(calls).filter(b => b.blockType === 'think')
    expect(thinks.map(b => b.id)).toEqual(['think-m2-t0'])
  })
})
