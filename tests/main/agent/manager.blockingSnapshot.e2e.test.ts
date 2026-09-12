/**
 * ★ 阻塞态主进程快照端到端观测点（本次事故的测试盲区）
 *
 * 背景：tools 变动门改为「无限等待用户决策」后，刷新必须能重现弹窗。渲染端半链
 * 已修复，但主进程半链曾断裂——worker 的三条阻塞消息（permission-confirm /
 * ask-user-question / tools-change-confirm）此前只 forwardToRenderer 就 return，
 * 从不经过 accumulateEvent → getStreamSnapshot 的阻塞态字段恒为 null。
 *
 * 本用例走真实 AgentManager.createMessageHandler（生产路径）投递消息，再断言
 * getStreamSnapshot 反映阻塞态。该观测点无法被 manager.accumulator 单测替代：
 * 后者只覆盖纯函数，捕不到「生产者缺失 → case 变成死代码」这一类缺陷。
 *
 * ★ 投递载荷断言（P3）：捕获真实 webContents.send('agent-stream', payload)，
 * 逐字段比对三类事件的精确键集。旧写法（spyOn forwardToRenderer + objectContaining）
 * 只能证明「被调用」，放行任意新增字段——改道引入 messageId 差异即漏网。
 *
 * ★ 刷新不误终态化（P1）：getStreamSnapshot 是刷新恢复唯一入口，其中
 * recoverUnfinalized 扫描必须排除仍活跃 loop 的消息行，同时保留崩溃残留收尾能力。
 *
 * 环境搭建对齐 manager.resultShrink.test.ts：electron 空壳（含假窗口捕获 IPC）
 * + config 重定向 tmpdir 隔离；createMessageHandler 为 TS-private（运行时可访问），
 * 经显式接口驱动，不 spawn 真实 Worker。
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'

// ── 隔离：config 重定向到独立临时目录 ──
vi.mock('@/main/config', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.mock 工厂被提升
    const os = require('os')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-blocking-snapshot-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
    }
})

// ── electron 空壳：假窗口捕获 webContents.send，用于断言真实投递载荷 ──
const {sentSends, fakeWindow} = vi.hoisted(() => {
    interface CapturedSend { channel: string; payload: unknown }
    const sentSends: CapturedSend[] = []
    const fakeWindow = {
        isDestroyed: () => false,
        webContents: {
            send: (channel: string, payload: unknown) => { sentSends.push({channel, payload}) },
        },
    }
    return {sentSends, fakeWindow}
})

vi.mock('electron', () => ({
    BrowserWindow: class {
        static getAllWindows() { return [fakeWindow] }
        isDestroyed() { return false }
    },
    app: {getPath: () => '/tmp', isReady: () => true},
    dialog: {showErrorBox: vi.fn()},
    ipcMain: {handle: vi.fn(), on: vi.fn()},
}))

import {AgentManager} from '@/main/agent/manager.impl'
import {WORKER_MESSAGE_TYPES} from '@/main/agent/constants'
import {getConversationPersistence} from '@/main/persistence/conversationPersistence'
import {getDatabase} from '@/main/repositories/sqlite'

let manager: AgentManager
let db: ReturnType<typeof getDatabase>

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

beforeEach(() => {
    manager = new AgentManager()
    db = getDatabase()
    db.exec('DROP TABLE IF EXISTS message_blocks')
    db.exec('DROP TABLE IF EXISTS messages')
    db.exec('DROP TABLE IF EXISTS conversations')
    seedSchema()
    sentSends.length = 0
})

afterEach(() => {
    vi.restoreAllMocks()
})

/**
 * TS-private 方法的运行时视图（仅测试用）。刻意不用 `any`：
 * 显式约定 createMessageHandler / handleStreamEvent / forwardToRenderer 的签名，
 * 改动生产签名时本用例会编译失败而非静默漂移。
 */
interface ManagerInternals {
    createMessageHandler(
        conversationId: string,
        worker: {postMessage: (...args: unknown[]) => void},
    ): (msg: Record<string, unknown>) => Promise<void>
    handleStreamEvent(conversationId: string, worker: unknown, event: unknown): Promise<void>
    forwardToRenderer(conversationId: string, event: {type: string}): void
}

function internals(): ManagerInternals {
    return manager as unknown as ManagerInternals
}

/** 经真实 createMessageHandler（生产路径）投递一条 worker 消息 */
function postToHandler(convId: string, msg: Record<string, unknown>): Promise<void> {
    const handler = internals().createMessageHandler(convId, {postMessage: vi.fn()})
    return handler({conversationId: convId, ...msg})
}

/** agent-stream 真实投递载荷（按会话过滤） */
function streamPayloadsFor(convId: string): Array<{conversationId: string; event: Record<string, unknown>}> {
    return sentSends
        .filter(s => s.channel === 'agent-stream')
        .map(s => s.payload as {conversationId: string; event: Record<string, unknown>})
        .filter(p => p.conversationId === convId)
}

/** 断言某会话投递的某类事件「精确字段集」与载荷结构（多余/缺失字段都失败） */
function expectExactEventPayload(
    convId: string,
    type: string,
    expectedEventKeys: string[],
): void {
    const payloads = streamPayloadsFor(convId)
    expect(payloads).toHaveLength(1)
    const payload = payloads[0]
    // 外层载荷恒为 {conversationId, event}，锁死结构（防止包装层漂移）
    expect(Object.keys(payload).sort()).toEqual(['conversationId', 'event'])
    expect(payload.event.type).toBe(type)
    expect(Object.keys(payload.event).sort()).toEqual([...expectedEventKeys].sort())
}

describe('★ 阻塞态主进程快照端到端（真实 createMessageHandler → getStreamSnapshot）', () => {
    it('tools-change-confirm → pendingToolsChangeConfirm 非空（刷新重现弹窗的权威事实源）', async () => {
        const CONV = 'conv-tools-e2e'

        await postToHandler(CONV, {
            type: WORKER_MESSAGE_TYPES.TOOLS_CHANGE_CONFIRM,
            requestId: 'req-tools-1',
            added: ['write_file'],
            removed: ['read_file'],
        })

        const snap = await manager.getStreamSnapshot(CONV)
        expect(snap).not.toBeNull()
        expect(snap!.pendingToolsChangeConfirm).toMatchObject({
            requestId: 'req-tools-1',
            added: ['write_file'],
            removed: ['read_file'],
        })
        // 精确载荷：改道（forwardToRenderer → handleStreamEvent）不得改变发往渲染端的字段集。
        // messageId 为 handleStreamEvent 统一的 id 对齐注入，渲染端据此复用主进程 pending id。
        expectExactEventPayload(CONV, 'tools_change_confirm',
            ['type', 'requestId', 'added', 'removed', 'messageId'])
    })

    it('ask-user-question → pendingQuestion 非空（无限等待下刷新恢复必填项）', async () => {
        const CONV = 'conv-ask-e2e'

        await postToHandler(CONV, {
            type: WORKER_MESSAGE_TYPES.ASK_USER_QUESTION,
            requestId: 'req-ask-1',
            question: '选哪个方案?',
            options: ['A', 'B'],
            multiSelect: false,
        })

        const snap = await manager.getStreamSnapshot(CONV)
        expect(snap).not.toBeNull()
        expect(snap!.pendingQuestion).toMatchObject({
            question: '选哪个方案?',
            options: ['A', 'B'],
            requestId: 'req-ask-1',
        })
        expectExactEventPayload(CONV, 'ask_user',
            ['type', 'question', 'options', 'multiSelect', 'requestId', 'messageId'])
    })

    it('permission-confirm → pendingPermissionConfirm 非空（同类阻塞链一并接通）', async () => {
        const CONV = 'conv-perm-e2e'

        await postToHandler(CONV, {
            type: WORKER_MESSAGE_TYPES.PERMISSION_CONFIRM,
            requestId: 'req-perm-1',
            message: '允许执行 rm -rf build?',
        })

        const snap = await manager.getStreamSnapshot(CONV)
        expect(snap).not.toBeNull()
        expect(snap!.pendingPermissionConfirm).toMatchObject({
            question: '允许执行 rm -rf build?',
            requestId: 'req-perm-1',
        })
        expectExactEventPayload(CONV, 'permission_confirm',
            ['type', 'question', 'requestId', 'messageId'])
    })

    it('阻塞态在 done 后从快照清空（不复活陈旧弹窗）', async () => {
        const CONV = 'conv-done-e2e'

        await postToHandler(CONV, {
            type: WORKER_MESSAGE_TYPES.TOOLS_CHANGE_CONFIRM,
            requestId: 'req-tools-2',
            added: ['write_file'],
            removed: [],
        })
        expect((await manager.getStreamSnapshot(CONV))!.pendingToolsChangeConfirm).not.toBeNull()

        // 终态事件（与流事件同路径）→ accumulateEvent 的清空分支生效
        await internals().handleStreamEvent(CONV, null, {type: 'done', reason: 'aborted'})
        expect((await manager.getStreamSnapshot(CONV))!.pendingToolsChangeConfirm).toBeNull()
    })
})

// ─── P1：刷新快照不得误终态化活跃 loop 的消息行 ─────────────────

interface MessageRow {id: string; ended_at: number | null; metadata: string | null}

describe('★ P1 刷新恢复（getStreamSnapshot）扫描边界', () => {
    it('阻塞中的活跃消息：刷新不写 ended_at / abnormalTermination；用户继续后正常完成仍无标记', async () => {
        const CONV = 'conv-active-p1'
        await postToHandler(CONV, {
            type: WORKER_MESSAGE_TYPES.TOOLS_CHANGE_CONFIRM,
            requestId: 'req-active-1',
            added: ['write_file'],
            removed: [],
        })
        // 模拟「刷新前主进程已把消息行落库」：ensureMessageRow 的 patch 经节流 flush 落盘
        getConversationPersistence().flush(CONV)

        const readRow = (): MessageRow =>
            db.prepare('SELECT id, ended_at, metadata FROM messages WHERE conversation_id = ?').get(CONV) as MessageRow
        const beforeRefresh = readRow()
        expect(beforeRefresh).toBeTruthy()
        expect(beforeRefresh.ended_at).toBeNull()

        // 刷新：渲染端必调 getStreamSnapshot
        const snap = await manager.getStreamSnapshot(CONV)
        // 修复不得牺牲刷新恢复链路：阻塞态仍在快照里（弹窗重现依据）
        expect(snap!.pendingToolsChangeConfirm).toMatchObject({requestId: 'req-active-1'})

        const afterRefresh = readRow()
        expect(afterRefresh.ended_at).toBeNull()
        expect(JSON.parse(afterRefresh.metadata || '{}').abnormalTermination).toBeUndefined()

        // 用户点「继续」→ worker 正常产出 → done(completed)
        await internals().handleStreamEvent(CONV, null, {type: 'text', content: '正常完成'})
        await internals().handleStreamEvent(CONV, null, {type: 'done', reason: 'completed'})

        const final = readRow()
        expect(final.ended_at).not.toBeNull()
        expect(JSON.parse(final.metadata || '{}').abnormalTermination).toBeUndefined()
        const blocks = db.prepare('SELECT block_type FROM message_blocks WHERE message_id = ? ORDER BY sequence')
            .all(final.id) as Array<{block_type: string}>
        expect(blocks.some(b => b.block_type === 'end')).toBe(true)
    })

    it('崩溃残留（无活跃 pending）：扫描仍补终态，原能力不废', async () => {
        const CONV = 'conv-crash-p1'
        db.prepare(
            'INSERT INTO messages (id, conversation_id, role, timestamp, ended_at, metadata, is_partial) VALUES (?, ?, ?, ?, NULL, NULL, 1)'
        ).run('msg-dead', CONV, 'assistant', 1000)
        db.prepare(
            'INSERT INTO message_blocks (id, message_id, block_type, content, data, sequence, timestamp, ended_at) VALUES (?, ?, ?, ?, NULL, 0, ?, NULL)'
        ).run('msg-dead-0', 'msg-dead', 'text', '写到一半', 1001)

        // 无活跃 pending → 快照为 null（无流式态可播种）
        expect(await manager.getStreamSnapshot(CONV)).toBeNull()

        const dead = db.prepare('SELECT ended_at, metadata FROM messages WHERE id = ?').get('msg-dead') as MessageRow
        expect(dead.ended_at).not.toBeNull()
        expect(JSON.parse(dead.metadata || '{}').abnormalTermination).toBe(true)
        const endBlocks = db.prepare("SELECT id FROM message_blocks WHERE message_id = ? AND block_type = 'end'")
            .all('msg-dead') as Array<{id: string}>
        expect(endBlocks).toHaveLength(1)
    })
})
