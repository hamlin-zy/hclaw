/**
 * ★ 内存优化 C1 护栏：落库 ACK → 收缩 pending.toolCalls[].result
 *
 * 目标：验证「message-flushed ACK 后终态 result 收缩为摘要」既释放内存，
 * 又不破坏「loop 内存态 = 存储 = 重建」逐字节契约。
 *
 * 环境搭建说明（对齐 manager.mergePersist.wiring.test.ts）：
 * - AgentManager 的 subscribePersistAck / shrinkDurableToolResults / handleStreamEvent
 *   均为 TS-private（运行时可访问），经 (manager as any) 驱动，避免真实 spawn Worker。
 * - 落库走 conversationPersistence 单例 + 真实 SQLite（config 重定向到 tmpdir 隔离）。
 * - ACK 由 persistence.flush 成功路径发出，与生产链路一致。
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'

// ── 隔离：config 重定向到独立临时目录 ──
vi.mock('@/main/config', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.mock 工厂被提升
    const os = require('os')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-c1-shrink-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
    }
})

// ── electron 空壳 ──
vi.mock('electron', () => ({
    BrowserWindow: class { static getAllWindows() { return [] } },
    app: {getPath: () => '/tmp', isReady: () => true},
    dialog: {showErrorBox: vi.fn()},
    ipcMain: {handle: vi.fn(), on: vi.fn()},
}))

import {AgentManager} from '@/main/agent/manager.impl'
import {normalizeToolResult} from '@/main/agent/manager.accumulator'
import type {PendingAssistantMsg} from '@/main/agent/manager.types'
import {getConversationPersistence} from '@/main/persistence/conversationPersistence'
import {persistStreamEvent} from '@/main/persistence/streamBridge'
import {closeDatabase, getDatabase} from '@/main/repositories/sqlite'

const CONV = 'conv-1'

let manager: AgentManager
let db: ReturnType<typeof getDatabase>
let persistence: ReturnType<typeof getConversationPersistence>

function seedSchema(): void {
    db.exec(`CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, workspace_path TEXT NOT NULL DEFAULT '', meta TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`)
    db.exec(`CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
        timestamp INTEGER NOT NULL, ended_at INTEGER, metadata TEXT, llm_stats TEXT,
        is_partial INTEGER NOT NULL DEFAULT 0
    )`)
    db.exec(`CREATE TABLE IF NOT EXISTS message_blocks (
        id TEXT PRIMARY KEY, message_id TEXT NOT NULL, block_type TEXT NOT NULL,
        content TEXT, data TEXT, sequence INTEGER NOT NULL, timestamp INTEGER NOT NULL, ended_at INTEGER, turn_index INTEGER
    )`)
}

/** 重置 persistence 单例的进程内状态（定时器/监听器），防跨用例串扰 */
function resetPersistenceState(): void {
    const st: Map<string, {timer: ReturnType<typeof setTimeout> | null}> = (persistence as any).states
    for (const s of st.values()) if (s.timer) clearTimeout(s.timer)
    st.clear()
    ;(persistence as any).listeners.clear()
}

/** 经真实 handleStreamEvent 累积事件（与生产同路径） */
async function feed(event: unknown): Promise<void> {
    await (manager as any).handleStreamEvent(CONV, null, event)
}

function getPending(): PendingAssistantMsg {
    return (manager as any).pendingAssistantMsg.get(CONV)
}

function getToolCall(id: string) {
    return getPending().toolCalls.find(t => t.id === id)!
}

function readToolResultBlockData(msgId: string, toolId: string): string | undefined {
    const row = db.prepare(
        "SELECT data FROM message_blocks WHERE message_id = ? AND block_type = 'tool_result' AND id = ?"
    ).get(msgId, `${msgId}-tr-${toolId}`) as {data: string | null} | undefined
    return row?.data ?? undefined
}

beforeEach(() => {
    manager = new AgentManager()
    db = getDatabase()
    db.exec('DROP TABLE IF EXISTS message_blocks')
    db.exec('DROP TABLE IF EXISTS messages')
    db.exec('DROP TABLE IF EXISTS conversations')
    seedSchema()
    db.prepare('INSERT INTO conversations (id, workspace_path, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(CONV, '', '{}', 1, 1)

    persistence = getConversationPersistence()
    resetPersistenceState()
})

afterEach(() => {
    resetPersistenceState()
    closeDatabase()
    vi.restoreAllMocks()
})

describe('C1-G1：ACK 后终态 toolCall result 收缩为摘要，元字段存活', () => {
    it('agent 工具成功：ACK 后 output/toolResult/_meta 正文消失，id/status/taskId 保留', async () => {
        ;(manager as any).subscribePersistAck(CONV)
        await feed({type: 'text', content: '正文'})
        await feed({type: 'tool_use', toolCall: {id: 't1', name: 'agent', arguments: {prompt: 'x'}}})
        await feed({
            type: 'tool_result', toolCallId: 't1',
            result: {success: true, output: 'A'.repeat(2000), _meta: {childConvId: 'conv-child'}},
        })
        const msgId = getPending().id

        // ACK 前：全文持有
        expect(getToolCall('t1').result?.output).toBe('A'.repeat(2000))
        expect(getToolCall('t1').resultDurable).toBeFalsy()

        persistence.flush(CONV)   // 落库成功 → 发 message-flushed → 收缩

        const tc = getToolCall('t1')
        expect(tc.resultDurable).toBe(true)
        expect(tc.result?.output).toBeUndefined()
        expect((tc.result as any)?.toolResult).toBeUndefined()
        expect((tc.result as any)?._meta).toBeUndefined()
        expect(tc.result).toEqual({success: true, error: undefined})
        // 元字段存活
        expect(tc.id).toBe('t1')
        expect(tc.status).toBe('success')
        expect(tc.taskId).toBe('conv-child')
        expect(tc.name).toBe('agent')
        expect(msgId).toBeTruthy()
    })
})

describe('C1-G2：ACK 之后才到达的 tool_result 不被收缩（以 ACK 时刻终态集合为准）', () => {
    it('t1 在 ACK 时已终态被收缩；ACK 后完成的 t2 保留全文，下一次 ACK 才收缩', async () => {
        ;(manager as any).subscribePersistAck(CONV)
        await feed({type: 'tool_use', toolCall: {id: 't1', name: 'bash', arguments: {}}})
        await feed({type: 'tool_result', toolCallId: 't1', result: {success: true, output: 'one'}})
        persistence.flush(CONV)   // ACK#1 → 收缩 t1

        expect(getToolCall('t1').resultDurable).toBe(true)
        expect(getToolCall('t1').result?.output).toBeUndefined()

        // ACK 之后新完成的 t2：不得被收缩
        await feed({type: 'tool_use', toolCall: {id: 't2', name: 'bash', arguments: {}}})
        await feed({type: 'tool_result', toolCallId: 't2', result: {success: true, output: 'two-full-text'}})

        expect(getToolCall('t2').resultDurable).toBeFalsy()
        expect(getToolCall('t2').result?.output).toBe('two-full-text')

        persistence.flush(CONV)   // ACK#2 → t2 收缩
        expect(getToolCall('t2').resultDurable).toBe(true)
        expect(getToolCall('t2').result?.output).toBeUndefined()
    })
})

describe('C1-G3：写失败 ⇒ 无 ACK ⇒ 全文保留；重试成功后才收缩', () => {
    it('首次 flush 失败不收缩，重试成功发 ACK 才收缩', async () => {
        ;(manager as any).subscribePersistAck(CONV)
        await feed({type: 'tool_use', toolCall: {id: 't1', name: 'bash', arguments: {}}})
        await feed({type: 'tool_result', toolCallId: 't1', result: {success: true, output: 'payload'}})

        const repo = (persistence as any).repo
        const spy = vi.spyOn(repo, 'writeBlockDelta').mockReturnValueOnce(false)
        persistence.flush(CONV)   // 失败 → 无 ACK
        expect(spy).toHaveBeenCalled()
        expect(getToolCall('t1').resultDurable).toBeFalsy()
        expect(getToolCall('t1').result?.output).toBe('payload')   // 全文保留

        spy.mockRestore()
        persistence.flush(CONV)   // patch 保留 → 重试成功 → ACK
        expect(getToolCall('t1').resultDurable).toBe(true)
        expect(getToolCall('t1').result?.output).toBeUndefined()
    })
})

describe('C1-G4：收缩后收尾，DB tool_result 块逐字节不变', () => {
    it('done 收尾后 DB tool_result = normalizeToolResult(loop 结果)，摘要绝不上库', async () => {
        ;(manager as any).subscribePersistAck(CONV)
        const loopResult = {success: true, output: 'FULL-OUTPUT-CONTENT'}
        const evResult = normalizeToolResult(loopResult)
        await feed({type: 'text', content: '正文'})
        await feed({type: 'tool_use', toolCall: {id: 't1', name: 'bash', arguments: {}}})
        await feed({type: 'tool_result', toolCallId: 't1', result: evResult})
        const msgId = getPending().id

        persistence.flush(CONV)   // 落库 + ACK → 收缩
        expect(getToolCall('t1').resultDurable).toBe(true)

        const before = readToolResultBlockData(msgId, 't1')
        expect(before).toBe(JSON.stringify({id: 't1', result: evResult}))
        expect(before).toBe(JSON.stringify({id: 't1', result: normalizeToolResult(loopResult)}))
        expect(before).toContain('FULL-OUTPUT-CONTENT')

        // 走 done 收尾（finalize + mergeAndPersist）
        await (manager as any).handleDoneEvent(CONV, {type: 'done', reason: 'completed'})

        const after = readToolResultBlockData(msgId, 't1')
        expect(after).toBe(before)                       // 逐字节不变
        expect(after).not.toContain('"resultDurable"')   // 纯内存标记绝不入 DB
    })
})

describe('C1-G5：tool_result 事件不带 result 的防御 —— 摘要不得写库', () => {
    it('tc.resultDurable 为真时，无 result 的回退被阻断（不写 tool_result 块）', async () => {
        // 直接验证桥接层：pending 已收缩（resultDurable + 摘要），事件不带 result
        const fakeRepo = {
            writeBlockDelta: vi.fn(() => true),
            writeMessagesDelta: vi.fn(() => true),
        }
        const {ConversationPersistence} = await import('@/main/persistence/conversationPersistence')
        const p = new ConversationPersistence(fakeRepo as never)
        const pending = {
            id: 'm1', content: '', contentLength: 0, thinkContent: null, timestamp: 1,
            toolCalls: [{
                id: 't1', name: 'bash', arguments: {}, status: 'success' as const,
                result: {success: true} as any,   // 摘要
                resultDurable: true,
            }],
        } as unknown as PendingAssistantMsg

        persistStreamEvent(p, CONV, 'm1', pending, {type: 'tool_result', toolCallId: 't1'} as never)
        p.flush(CONV)
        // 回退被阻断 → 未累积任何 patch → 无写库
        expect(fakeRepo.writeBlockDelta).not.toHaveBeenCalled()
    })

    it('对照：未收缩（resultDurable 未置位）时同样的无 result 事件回退写库', async () => {
        const fakeRepo = {
            writeBlockDelta: vi.fn(() => true),
            writeMessagesDelta: vi.fn(() => true),
        }
        const {ConversationPersistence} = await import('@/main/persistence/conversationPersistence')
        const p = new ConversationPersistence(fakeRepo as never)
        const pending = {
            id: 'm1', content: '', contentLength: 0, thinkContent: null, timestamp: 1,
            toolCalls: [{
                id: 't1', name: 'bash', arguments: {}, status: 'success' as const,
                result: {success: true, output: 'full', toolResult: 'full'},
            }],
        } as unknown as PendingAssistantMsg

        persistStreamEvent(p, CONV, 'm1', pending, {type: 'tool_result', toolCallId: 't1'} as never)
        p.flush(CONV)
        expect(fakeRepo.writeBlockDelta).toHaveBeenCalledTimes(1)
    })
})

describe('C1-G6：已收缩条目再次收到全文 tool_result ⇒ 清除标记，下一次 ACK 再次收缩', () => {
    it('重复投递全文后：标记被清除 → 全文重回内存，ACK#2 再次收缩且 DB 保留全文', async () => {
        ;(manager as any).subscribePersistAck(CONV)
        await feed({type: 'text', content: '正文'})
        await feed({type: 'tool_use', toolCall: {id: 't1', name: 'bash', arguments: {}}})
        await feed({type: 'tool_result', toolCallId: 't1', result: {success: true, output: 'FIRST-FULL-TEXT'}})
        const msgId = getPending().id

        persistence.flush(CONV)   // ACK#1 → 收缩
        expect(getToolCall('t1').resultDurable).toBe(true)
        expect(getToolCall('t1').result?.output).toBeUndefined()

        // 重复/迟到投递：同一 toolCallId 再次携带全文（防御场景，对抗用例 Y2）
        await feed({type: 'tool_result', toolCallId: 't1', result: {success: true, output: 'SECOND-FULL-TEXT'}})

        // 标记被清除 ⇒ 全文重回内存（不再是「永不释放」的粘滞态）
        expect(getToolCall('t1').resultDurable).toBeFalsy()
        expect(getToolCall('t1').result?.output).toBe('SECOND-FULL-TEXT')

        persistence.flush(CONV)   // ACK#2 → 再次收缩
        expect(getToolCall('t1').resultDurable).toBe(true)
        expect(getToolCall('t1').result?.output).toBeUndefined()
        expect(getToolCall('t1').result).toEqual({success: true, error: undefined})

        // DB 持有重复投递的全文；收缩产物绝不入 DB
        const data = readToolResultBlockData(msgId, 't1')
        expect(data).toContain('SECOND-FULL-TEXT')
        expect(data).not.toContain('"resultDurable"')
    })

    it('对照：无 result 的防御性 tool_result 不清除标记（防空结果覆盖 DB 全文）', async () => {
        ;(manager as any).subscribePersistAck(CONV)
        await feed({type: 'tool_use', toolCall: {id: 't1', name: 'bash', arguments: {}}})
        await feed({type: 'tool_result', toolCallId: 't1', result: {success: true, output: 'DURABLE-FULL'}})
        const msgId = getPending().id

        persistence.flush(CONV)   // ACK → 收缩
        expect(getToolCall('t1').resultDurable).toBe(true)

        await feed({type: 'tool_result', toolCallId: 't1'})   // 事件不带 result
        expect(getToolCall('t1').resultDurable).toBe(true)    // 标记保留：绝不触发空结果回退

        persistence.flush(CONV)
        expect(readToolResultBlockData(msgId, 't1')).toContain('DURABLE-FULL')
    })
})
