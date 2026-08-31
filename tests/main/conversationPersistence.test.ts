// 单测注入 fake repo：不需要真实 DB；隔离规则（getHclawDir→tmpdir）仅适用于
// tests/main/persistence.integration.test.ts（Task 7）。
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {ConversationPersistence} from '../../src/main/persistence/conversationPersistence'
import type {BlockDeltaPatch, Message} from '../../src/shared/types'

function fakeRepo() {
  return {
    writeBlockDelta: vi.fn((_convId: string, _msgId: string, _patch: BlockDeltaPatch) => true),
    writeMessagesDelta: vi.fn((_convId: string, _message: Message) => true),
  }
}
const patch = (content: string): Partial<BlockDeltaPatch> => ({
  upsertBlocks: [{id: 'text-m1-0', messageId: 'm1', blockType: 'text', content, data: null, sequence: 0, timestamp: 1}],
})

describe('ConversationPersistence', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {vi.useRealTimers(); vi.restoreAllMocks()})

  it('节流窗口内多次 accumulate 合并为单次 flush（同 msgId patch 合并，text 增量拼接）', async () => {
    const repo = fakeRepo()
    const p = new ConversationPersistence(repo as never)
    p.ensureMessageRow('c1', 'm1', 1000)
    p.accumulate('c1', 'm1', patch('甲'))
    p.accumulate('c1', 'm1', patch('乙'))
    expect(repo.writeBlockDelta).not.toHaveBeenCalled()
    vi.advanceTimersByTime(30000)
    expect(repo.writeBlockDelta).toHaveBeenCalledTimes(1)
    const sent = repo.writeBlockDelta.mock.calls[0][2] as BlockDeltaPatch
    expect(sent.upsertBlocks![0].content).toBe('甲乙')  // 同 id text 增量拼接
    expect(sent.messageFields?.role).toBe('assistant')
    expect(sent.messageFields?.timestamp).toBe(1000)
  })

  it('不同 msgId 各自独立 flush（7.4 O(1) 索引）', async () => {
    const repo = fakeRepo()
    const p = new ConversationPersistence(repo as never)
    p.accumulate('c1', 'm1', patch('a'))
    p.accumulate('c1', 'm2', patch('b'))
    vi.advanceTimersByTime(30000)
    expect(repo.writeBlockDelta).toHaveBeenCalledTimes(2)
  })

  it('★ 失败幂等（4.4）：writeBlockDelta 返回 false → patch 保留，重试重发同一 patch 不双写', async () => {
    const repo = fakeRepo()
    repo.writeBlockDelta.mockReturnValueOnce(false)
    const p = new ConversationPersistence(repo as never)
    p.accumulate('c1', 'm1', patch('chunk1'))
    vi.advanceTimersByTime(30000)
    expect(repo.writeBlockDelta).toHaveBeenCalledTimes(1)
    p.accumulate('c1', 'm2', patch('other'))
    vi.advanceTimersByTime(30000)
    const calls = repo.writeBlockDelta.mock.calls as Array<[string, string, BlockDeltaPatch]>
    const m1Calls = calls.filter(([, msgId]) => msgId === 'm1')
    expect(m1Calls.length).toBe(2)
    expect(m1Calls[0][2].upsertBlocks![0].content).toBe(m1Calls[1][2].upsertBlocks![0].content)
  })

  it('指数退避：1s→2s→4s，上限 30s；连续 10 次失败发 persist-degraded', async () => {
    const repo = fakeRepo()
    repo.writeBlockDelta.mockReturnValue(false)
    const p = new ConversationPersistence(repo as never)
    const degraded: number[] = []
    p.onPersistEvent(e => { if (e.type === 'persist-degraded') degraded.push(e.failureCount) })
    p.accumulate('c1', 'm1', patch('x'))
    const delays: number[] = []
    let prev = 0
    for (let i = 1; i <= 12; i++) {
      vi.advanceTimersByTime(60000)
      const n = repo.writeBlockDelta.mock.calls.length
      delays.push(n - prev); prev = n
    }
    expect(degraded.length).toBeGreaterThanOrEqual(3)
    expect(Math.max(...delays)).toBeLessThanOrEqual(2)
    repo.writeBlockDelta.mockReturnValue(true)
    vi.advanceTimersByTime(60000)
    expect(repo.writeBlockDelta.mock.calls.length).toBeGreaterThan(prev)
  })

  it('成功后失败计数清零，patch entry 被 delete（7.2a）', async () => {
    const repo = fakeRepo()
    repo.writeBlockDelta.mockReturnValueOnce(false).mockReturnValueOnce(true)
    const p = new ConversationPersistence(repo as never)
    p.accumulate('c1', 'm1', patch('x'))
    vi.advanceTimersByTime(30000)
    p.flush('c1')
    p.flush('c1')
    const m1Calls = (repo.writeBlockDelta.mock.calls as unknown as Array<[string, string]>).filter(([, m]) => m === 'm1')
    expect(m1Calls.length).toBe(2)
  })

  it('finalizeMessage：同步 flush 单条，成功才发 message-finalized（§3.6-4）', () => {
    const repo = fakeRepo()
    const p = new ConversationPersistence(repo as never)
    const finalized: string[] = []
    p.onPersistEvent(e => { if (e.type === 'message-finalized') finalized.push(e.msgId) })
    p.accumulate('c1', 'm1', patch('正文'))
    const ok = p.finalizeMessage('c1', 'm1', 9999)
    expect(ok).toBe(true)
    const sent = (repo.writeBlockDelta.mock.calls[0] as [string, string, BlockDeltaPatch])[2]
    expect(sent.finalize).toBe(true)
    expect(sent.messageFields?.endedAt).toBe(9999)
    expect(finalized).toEqual(['m1'])
    p.flush('c1')
    expect((repo.writeBlockDelta.mock.calls as unknown[]).length).toBe(1)
  })

  it('finalizeMessage 失败：不发事件、patch 保留', () => {
    const repo = fakeRepo()
    repo.writeBlockDelta.mockReturnValue(false)
    const p = new ConversationPersistence(repo as never)
    const finalized: string[] = []
    p.onPersistEvent(e => { if (e.type === 'message-finalized') finalized.push(e.msgId) })
    p.accumulate('c1', 'm1', patch('a'))   // Task 7：无 patch 时 finalize 为 no-op（主进程唯一写方，必先累积）
    expect(p.finalizeMessage('c1', 'm1', 9999)).toBe(false)
    expect(finalized).toEqual([])
  })

  it('finalizeMessage 无累积 patch：no-op 返回 true，不凭空建行（Phase 2 唯一写方语义）', () => {
    const repo = fakeRepo()
    const p = new ConversationPersistence(repo as never)
    expect(p.finalizeMessage('c1', 'm1', 9999)).toBe(true)
    expect(repo.writeBlockDelta).not.toHaveBeenCalled()
  })

  it('writeNow：单条消息走 writeMessagesDelta（memo/handoff 职责表）', () => {
    const repo = fakeRepo()
    const p = new ConversationPersistence(repo as never)
    const msg = {id: 'u1', role: 'user', content: 'hi', timestamp: 1} as Message
    expect(p.writeNow('c1', msg)).toBe(true)
    expect(repo.writeMessagesDelta).toHaveBeenCalledWith('c1', msg)
    expect(repo.writeBlockDelta).not.toHaveBeenCalled()
  })

  it('clearConversation：整组清理，flush 不再发任何写（7.2b）', async () => {
    const repo = fakeRepo()
    repo.writeBlockDelta.mockReturnValue(false)
    const p = new ConversationPersistence(repo as never)
    p.accumulate('c1', 'm1', patch('x'))
    p.clearConversation('c1')
    vi.advanceTimersByTime(120000)
    expect(repo.writeBlockDelta).not.toHaveBeenCalled()
  })

  it('clearDeltaQueue：清空增量但保留状态对象（compact 边界 4.3）', async () => {
    const repo = fakeRepo()
    const p = new ConversationPersistence(repo as never)
    p.accumulate('c1', 'm1', patch('旧增量'))
    p.clearDeltaQueue('c1')
    p.accumulate('c1', 'm2', patch('compact 后新写入'))
    vi.advanceTimersByTime(30000)
    const msgs = (repo.writeBlockDelta.mock.calls as unknown as Array<[string, string]>).map(([, m]) => m)
    expect(msgs).toEqual(['m2'])
  })

  it('flushAllSync：同步 flush 全部会话（退出边界 4.3）', () => {
    const repo = fakeRepo()
    const p = new ConversationPersistence(repo as never)
    p.accumulate('c1', 'm1', patch('a'))
    p.accumulate('c2', 'm2', patch('b'))
    p.flushAllSync()
    expect(repo.writeBlockDelta).toHaveBeenCalledTimes(2)
  })

  it('7.1 内存形态：text 增量为 chunk 拼接，flush 成功后整段丢弃', async () => {
    const repo = fakeRepo()
    const p = new ConversationPersistence(repo as never)
    const flat = Array(5000).fill('y').join('')
    for (let i = 0; i < 100; i++) p.accumulate('c1', 'm1', patch(flat))
    vi.advanceTimersByTime(30000)
    const sent = (repo.writeBlockDelta.mock.calls[0] as [string, string, BlockDeltaPatch])[2]
    expect(sent.upsertBlocks![0].content).toBe(flat.repeat(100))
  })
})

// Task 7 解除 skip：persistStreamEvent 六参签名交付时
import {persistStreamEvent, deriveTextSeq} from '../../src/main/persistence/streamBridge'
import type {PendingAssistantMsg} from '../../src/main/agent/manager.types'

function mkPending(): PendingAssistantMsg {
  return {id: 'm1', content: '', contentLength: 0, toolCalls: [], thinkContent: null, timestamp: 1, toolStates: {}, progressLog: {}, subAgentStream: {}, pendingQuestion: null, pendingPermissionConfirm: null} as unknown as PendingAssistantMsg
}

describe('streamBridge.persistStreamEvent（渲染端 record* 平移验证）', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {vi.useRealTimers(); vi.restoreAllMocks()})

  it('text 事件 → text chunk 累积；think/tool 后 textSeq 递增换段', () => {
    const repo = fakeRepo()
    const p = new ConversationPersistence(repo as never)
    const pending = mkPending()
    // text 段 0
    persistStreamEvent(p, 'c1', 'm1', pending, {type: 'text', content: 'a'} as never)
    vi.advanceTimersByTime(30000)
    // thinking 首块 → textSeq 递增
    persistStreamEvent(p, 'c1', 'm1', pending, {type: 'thinking', content: '想'} as never)
    persistStreamEvent(p, 'c1', 'm1', pending, {type: 'text', content: 'b'} as never)
    vi.advanceTimersByTime(30000)
    const calls = repo.writeBlockDelta.mock.calls as Array<[string, string, BlockDeltaPatch]>
    expect(calls[0][2].upsertBlocks![0].id).toBe('text-m1-0')
    // 第二次 flush 的 patch 合并了 think 段与 text 段（同 msgId patch 合并）
    const textB = calls[1][2].upsertBlocks!.find(b => b.id === 'text-m1-1')
    expect(textB).toBeTruthy()
    expect(textB!.content).toBe('b')
  })

  it('tool_use → tool_call 块（data 除 result 外全字段）；tool_result → tool_call 终态覆盖 + tool_result 块', () => {
    const repo = fakeRepo()
    const p = new ConversationPersistence(repo as never)
    const pending = mkPending()
    pending.toolCalls = [{id: 't1', name: 'bash', arguments: {cmd: 'ls'}}] as never
    persistStreamEvent(p, 'c1', 'm1', pending, {type: 'tool_use', toolCall: {id: 't1', name: 'bash', arguments: {cmd: 'ls'}}} as never)
    persistStreamEvent(p, 'c1', 'm1', pending, {type: 'tool_result', toolCallId: 't1', result: {success: true, output: 'ok'}} as never)
    vi.advanceTimersByTime(30000)
    const sent = (repo.writeBlockDelta.mock.calls[0] as [string, string, BlockDeltaPatch])[2]
    const blocks = sent.upsertBlocks!
    expect(blocks.filter(b => b.blockType === 'tool_call').length).toBe(1)   // 同 id 合并为终态
    expect(blocks.find(b => b.blockType === 'tool_result')!.data).toContain('"id":"t1"')
    const tcData = JSON.parse(blocks.find(b => b.blockType === 'tool_call')!.data!)
    expect(tcData.status).toBe('success')        // 终态修复语义（conversationStore.ts:267-271）
    expect(tcData.result).toBeUndefined()        // result 不入 tool_call 块 data
  })

  it('tool_denied → 终态 error（result 格式与 manager.accumulator.ts tool_denied 分支逐字节一致）', () => {
    const repo = fakeRepo()
    const p = new ConversationPersistence(repo as never)
    const pending = mkPending()
    pending.toolCalls = [{id: 't1', name: 'bash', arguments: {}}] as never
    persistStreamEvent(p, 'c1', 'm1', pending, {type: 'tool_denied', toolCallId: 't1', reason: '危险'} as never)
    vi.advanceTimersByTime(30000)
    const sent = (repo.writeBlockDelta.mock.calls[0] as [string, string, BlockDeltaPatch])[2]
    const tcData = JSON.parse(sent.upsertBlocks!.find(b => b.blockType === 'tool_call')!.data!)
    expect(tcData.status).toBe('error')
    expect(tcData.result).toBeUndefined()        // result 不入 tool_call 块 data
    // tool_result 块 data 携带 result（格式与 manager.accumulator.ts:211-228 逐字节一致：
    // error=[PERMISSION_DENIED] reason，toolResult=[ERROR] 前缀同串）
    const trData = JSON.parse(sent.upsertBlocks!.find(b => b.blockType === 'tool_result')!.data!)
    expect(trData.result.error).toBe('[PERMISSION_DENIED] 危险')
    expect(trData.result.toolResult).toBe('[ERROR] [PERMISSION_DENIED] 危险')
  })

  it('子会话守卫（R9）：isChildConv 命中时不落任何块；setChildConvChecker 可切换', async () => {
    const {setChildConvChecker} = await import('../../src/main/persistence/streamBridge')
    const repo = fakeRepo()
    const p = new ConversationPersistence(repo as never)
    const pending = mkPending()
    setChildConvChecker((convId) => convId === 'child-1')
    persistStreamEvent(p, 'child-1', 'm1', pending, {type: 'text', content: 'x'} as never)
    persistStreamEvent(p, 'main-1', 'm1', pending, {type: 'text', content: 'y'} as never)
    vi.advanceTimersByTime(30000)
    expect(repo.writeBlockDelta).toHaveBeenCalledTimes(1)
    setChildConvChecker(() => false)   // 还原默认，避免污染其他用例
  })

  it('deriveTextSeq：toolCall 数 + think 段数', () => {
    const pending = mkPending()
    pending.toolCalls = [{id: 't1', name: 'x', arguments: {}, status: 'running'}] as never
    pending.thinkContent = '已思考'
    expect(deriveTextSeq(pending)).toBe(2)
  })
})
