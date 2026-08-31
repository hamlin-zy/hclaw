// 集成测试：ConversationPersistence × SqliteConversationRepository（真实 SQLite）。
// 隔离：vi.mock config → getHclawDir() 重定向 mkdtempSync(tmpdir)，绝不触碰真实
// ~/.hclaw/data/hclaw.db（Global Constraint 5）；mock 形态与 usageWrite.test.ts 一致。
import {describe, it, expect, vi, afterAll} from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hclaw-persist-test-'))
vi.doMock('@/main/config', () => ({
  getHclawDir: () => tmpRoot,
  HCLAW_DIR: tmpRoot,
  getHclawDataDir: () => path.join(tmpRoot, 'data'),
  isSafePath: (p: string) => p.startsWith(tmpRoot),
}))
vi.doMock('../../src/main/config', () => ({
  getHclawDir: () => tmpRoot,
  HCLAW_DIR: tmpRoot,
  getHclawDataDir: () => path.join(tmpRoot, 'data'),
  isSafePath: (p: string) => p.startsWith(tmpRoot),
}))

const {ConversationPersistence, getConversationPersistence} = await import('../../src/main/persistence/conversationPersistence')
import {persistStreamEvent} from '../../src/main/persistence/streamBridge'
const {createConversationRepository} = await import('../../src/main/repositories')
const {getDatabase, initDatabaseSync} = await import('../../src/main/repositories/sqlite')

initDatabaseSync()

describe('ConversationPersistence × SqliteConversationRepository 集成', () => {
  it('流式累积 → flush → 读回内容完整（append 语义）', () => {
    const convId = 'it-conv-1'
    const db = getDatabase()
    // 外键：messages.conversation_id → conversations(id)
    db.prepare(`INSERT OR IGNORE INTO conversations (id, workspace_path, meta, created_at, updated_at) VALUES (?, '', '{}', 0, 0)`).run(convId)

    const repo = createConversationRepository() as {readMessages: (c: string) => Array<{id: string; content: string; endedAt?: number}>}
    // 直接绑定真实 repo（getConversationPersistence 单例的惰性 require 在 vitest
    // ESM 环境不可用；此处等价于生产 getConversationPersistence() 的构造形态）
    const p = new ConversationPersistence(createConversationRepository() as never)
    p.ensureMessageRow(convId, 'm1', 1000)
    p.accumulate(convId, 'm1', {upsertBlocks: [
      {id: 'text-m1-0', messageId: 'm1', blockType: 'text', content: '第一段', data: null, sequence: 0, timestamp: 1001},
    ]} as never)
    p.flush(convId)
    p.accumulate(convId, 'm1', {upsertBlocks: [
      {id: 'text-m1-0', messageId: 'm1', blockType: 'text', content: '第二段', data: null, sequence: 0, timestamp: 1002},
    ]} as never)
    p.finalizeMessage(convId, 'm1', 2000)
    const msgs = repo.readMessages(convId)
    const m = msgs.find(x => x.id === 'm1')
    expect(m).toBeTruthy()
    expect(m!.content).toBe('第一段第二段')   // append：同 id text 块 COALESCE || 拼接
    expect(m!.endedAt).toBe(2000)            // finalize：end 块 + ended_at

    // 库文件确实落在 tmpRoot（隔离验证）
    const dbFile = path.join(tmpRoot, 'data', 'hclaw.db')
    expect(fs.existsSync(dbFile)).toBe(true)
  })
})

describe('生命周期边界（§4.3）', () => {
  it('§5.3-2 compact 互斥：clearDeltaQueue 后旧增量不覆盖 compact 结果', () => {
    const convId = 'it-compact-1'
    const repo = createConversationRepository() as never as Record<string, (...a: unknown[]) => unknown>
    repo.create(convId, {title: 't'} as never)
    const p = getConversationPersistence()
    p.ensureMessageRow(convId, 'old-m', 1000)
    p.accumulate(convId, 'old-m', {upsertBlocks: [
      {id: 'text-old-m-0', messageId: 'old-m', blockType: 'text', content: '旧增量', data: null, sequence: 0, timestamp: 1001},
    ]} as never)
    // compact：全量写 writeMessages（写入路径职责表），写前清队列
    p.clearDeltaQueue(convId)
    repo.writeMessages(convId, [
      {id: 'old-m', role: 'assistant', content: 'compact 后正文', timestamp: 1000, endedAt: 1100} as never,
    ])
    p.flush(convId)   // 若未清队列，此处会把"旧增量" append 进 compact 结果 → 测试失败
    const msgs = repo.readMessages(convId) as Array<{id: string; content: string}>
    expect(msgs.find(m => m.id === 'old-m')!.content).toBe('compact 后正文')
  })

  it('§5.3-8 会话删除竞态：clearConversation 后 flush 不复活已删消息', () => {
    const convId = 'it-del-1'
    const repo = createConversationRepository() as never as Record<string, (...a: unknown[]) => unknown>
    repo.create(convId, {title: 't'} as never)
    const p = getConversationPersistence()
    p.accumulate(convId, 'm1', {upsertBlocks: [
      {id: 'text-m1-0', messageId: 'm1', blockType: 'text', content: 'x', data: null, sequence: 0, timestamp: 1},
    ]} as never)
    p.clearConversation(convId)
    repo.delete(convId)
    p.flush(convId)   // 队列已随 clearConversation 清空，无写入
    expect(repo.readMessages(convId)).toEqual([])
  })
})

describe('崩溃恢复与并发边界', () => {
  it('§5.3-3/9 finalizeAbnormal：未 finalize 消息补 end 块 + abnormalTermination 标记（幂等）', () => {
    const convId = 'it-crash-1'
    const repo = createConversationRepository() as never as {
      create: (c: string, m: never) => void
      finalizeAbnormal: (c: string, m: string, t: number) => boolean
      readMessages: (c: string) => Array<Record<string, unknown>>
    }
    repo.create(convId, {title: 't'} as never)
    const p = new ConversationPersistence(repo as never)
    p.ensureMessageRow(convId, 'm-crash-1', 1000)
    p.accumulate(convId, 'm-crash-1', {upsertBlocks: [
      {id: 'text-m-crash-1-0', messageId: 'm-crash-1', blockType: 'text', content: '写到一半', data: null, sequence: 0, timestamp: 1001},
    ]} as never)
    p.flush(convId)
    expect(repo.finalizeAbnormal(convId, 'm-crash-1', 5000)).toBe(true)
    const msgs = repo.readMessages(convId)
    const m = msgs.find(x => x.id === 'm-crash-1') as unknown as {endedAt: number; metadata?: {abnormalTermination?: boolean}; content: string}
    expect(m.endedAt).toBe(5000)
    // 读侧 buildMessagesFromRows 将 metadata 平铺到顶层（...metadata spread）
    expect((m as unknown as {abnormalTermination?: boolean}).abnormalTermination).toBe(true)
    expect(m.content).toBe('写到一半')
    // 幂等：再次调用不再新增 end 块、不覆盖 ended_at
    expect(repo.finalizeAbnormal(convId, 'm-crash-1', 6000)).toBe(true)
    const again = repo.readMessages(convId).find(x => x.id === 'm-crash-1') as unknown as {endedAt: number}
    expect(again.endedAt).toBe(5000)
  })

  it('§5.3-5 writeNow 与流式 flush 交错：渠道消息到达时 loop 运行中，两路径写入均完整（3.2 并发语义）', () => {
    const convId = 'it-interleave-1'
    const repo = createConversationRepository() as never as {
      create: (c: string, m: never) => void
      writeMessages: (c: string, m: never) => void
      readMessages: (c: string) => Array<Record<string, unknown>>
    }
    repo.create(convId, {title: 't'} as never)
    const p = new ConversationPersistence(repo as never)
    // 流式进行中（assistant 未 finalize）
    p.ensureMessageRow(convId, 'asst-1', 1000)
    p.accumulate(convId, 'asst-1', {upsertBlocks: [
      {id: 'text-asst-1-0', messageId: 'asst-1', blockType: 'text', content: '回复中', data: null, sequence: 0, timestamp: 1001},
    ]} as never)
    // 渠道 user 消息插队（writeNow，msgId 不同，3.2：主进程单线程 + 事务内完成）
    p.writeNow(convId, {id: 'user-1', role: 'user', content: '插队消息', timestamp: 1002} as never)
    p.finalizeMessage(convId, 'asst-1', 2000)
    const msgs = repo.readMessages(convId)
    expect(msgs.find(m => m.id === 'user-1')).toBeTruthy()
    expect(msgs.find(m => m.id === 'asst-1')!.content).toBe('回复中')
  })
})

// ── createSession.test.ts 持久化断言迁入（Task 12 Step 5）────────────────
// 原 memo createSession 测试以 mock repo 断言"将写入什么"；此处以真实 repo
// 逐条验证 user 消息构建产物经 writeMessages → readMessages 全量存活。
describe('user 消息持久化断言（迁自 tests/main/memo/createSession.test.ts）', () => {
  it('commandId / 顶层 attachments / content 经 writeMessages → readMessages 存活', async () => {
    const {buildUserMessage} = await import('../../src/main/agent/messageBuilder')
    const convId = 'it-conv-memo-user'
    const db = getDatabase()
    db.prepare(`INSERT OR IGNORE INTO conversations (id, workspace_path, meta, created_at, updated_at) VALUES (?, '', '{}', 0, 0)`).run(convId)

    const userMsg = await buildUserMessage({
      convId,
      text: '/brainstorming\nfix the bug',
      attachments: [{path: 'C:\\fake\\memo\\image.png', name: 'image.png'}],
      metadata: {commandId: 'cmd-123'},
    })

    const repo = createConversationRepository()
    expect(repo.writeMessages(convId, [userMsg])).toBe(true)

    const loaded = repo.readMessages(convId)
    expect(loaded).toHaveLength(1)
    const m = loaded[0] as unknown as Record<string, unknown>
    expect(m.content).toBe('/brainstorming\nfix the bug')
    // readMessages 将 metadata 展平到消息顶层（conversationRepository.buildMessagesFromRows）
    expect(m.commandId).toBe('cmd-123')
    // 附件单形态（R6）：顶层 attachments 存活；metadata 不再二次承载附件业务
    expect(m.attachments as unknown[]).toHaveLength(1)
  })
})

// ── 渠道消息链路（§3.3：build → writeNow，Task 13 Step 1）────────────────
// persistMessage 新实现 = buildUserMessage + writeNow；Electron 依赖使直接调用
// 不可行，端到端以 builder + persistence 组合等价模拟（与 plan Task 13 Step 1 一致）。
describe('渠道消息链路（§3.3：build → writeNow）', () => {
  it('persistMessage 改造后：消息经 messageToBlocks 落库，附件顶层形态可读回', async () => {
    const {buildUserMessage} = await import('../../src/main/agent/messageBuilder')
    const convId = 'it-channel-1'
    const db = getDatabase()
    db.prepare(`INSERT OR IGNORE INTO conversations (id, workspace_path, meta, created_at, updated_at) VALUES (?, '', '{}', 0, 0)`).run(convId)

    const repo = createConversationRepository()
    const p = new ConversationPersistence(repo as never)
    const msg = await buildUserMessage({
      convId,
      text: '渠道消息',
      attachments: [{path: 'E:/c.png', name: 'c.png'}],
    })
    expect(p.writeNow(convId, msg)).toBe(true)

    const msgs = repo.readMessages(convId) as unknown as Array<Record<string, unknown>>
    const back = msgs.find(m => m.id === msg.id)
    expect(back).toBeTruthy()
    expect(back!.content).toBe('渠道消息')
    // R6 附件单形态：顶层 attachments 存活（messageToBlocks 序列化时派生 metadata.attachments，
    // 读侧 buildMessagesFromRows 展平回顶层）
    expect(back!.attachments).toEqual(msg.attachments)
  })
})

describe('§5.3-7 UI 流式事件粒度回归（7.5 双通道）', () => {
  it('text 增量 chunk 级推送不受落库节流影响（桥接只写持久化层，不触碰 UI 事件发射点）', () => {
    vi.useFakeTimers()
    try {
      const repo = {writeBlockDelta: vi.fn(() => true), writeMessagesDelta: vi.fn(() => true)}
      const p = new ConversationPersistence(repo as never)
      const pending = mkPending()
      for (const c of ['a', 'b', 'c']) {
        persistStreamEvent(p, 'c1', 'm1', pending, {type: 'text', content: c} as never, 0)
      }
      vi.advanceTimersByTime(10000)  // 未到 30s 节流窗口
      expect(repo.writeBlockDelta).not.toHaveBeenCalled()  // 落库被节流
      // UI 事件不受影响：manager.impl 的 agent-stream 发射点在本改造中零改动（结构性 grep 人工核对）
    } finally {
      vi.useRealTimers()
    }
  })
})

function mkPending(): import('../../src/main/agent/manager.types').PendingAssistantMsg {
  return {id: 'm1', content: '', contentLength: 0, toolCalls: [], thinkContent: null, timestamp: 1, toolStates: {}, progressLog: {}, subAgentStream: {}, pendingQuestion: null, pendingPermissionConfirm: null} as import('../../src/main/agent/manager.types').PendingAssistantMsg
}

afterAll(() => {
  try {
    fs.rmSync(tmpRoot, {recursive: true, force: true, maxRetries: 3})
  } catch {
    // Windows 下 better-sqlite3 句柄未释放时 rm 可能 EPERM；临时目录由 OS 清理，无害
  }
})
