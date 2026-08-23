/**
 * AgentManager 测试环境 — #mergeAndPersist 保险丝接线单测（P0 补充）
 *
 * 目标：覆盖 #mergeAndPersist 内 repairTextTail 的两处接线（blocks 已存在分支 /
 * 指纹副本分支），此前仅靠 repository 层纯函数测试间接覆盖。
 *
 * 环境搭建说明：
 * - #mergeAndPersist 是 ES 硬私有（# 前缀），无法直接调用；经由公开入口
 *   handleDoneEvent / handleErrorEvent 驱动（与生产 worker 消息处理同路径）。
 * - pendingAssistantMsg 为 TS-private（运行时可访问），通过括号注入模拟
 *   流式累积结果——pending 构造复用 accumulateStreamEvent 保证真实性。
 * - electron 以空壳 mock；config 重定向到 os.tmpdir() 隔离目录，
 *   绝不触碰真实 ~/.hclaw/data/hclaw.db。
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'

// ── 隔离：config 重定向到独立临时目录（对齐 conversationRepository.repair.test.ts 模式）──
vi.mock('@/main/config', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.mock 工厂被提升，不能引用文件级 const
    const os = require('os')
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- 同上
    const path = require('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-agent-manager-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
    }
})

// ── electron 空壳：manager.impl 仅用 BrowserWindow 类型/null 检查 ──
vi.mock('electron', () => ({
    BrowserWindow: class {},
    app: {getPath: () => '/tmp', isReady: () => true},
    dialog: {showErrorBox: vi.fn()},
    ipcMain: {handle: vi.fn(), on: vi.fn()},
}))

import {AgentManager} from '@/main/agent/manager.impl'
import {accumulateStreamEvent} from '@/main/agent/manager.accumulator'
import type {PendingAssistantMsg as TPending} from '@/main/agent/manager.types'
import {closeDatabase, getDatabase} from '@/main/repositories/sqlite'

let manager: AgentManager
let db: ReturnType<typeof getDatabase>

/** 用真实累积器构造跨段 pending：段1文本 + 工具 + tool_result + 段2文本 */
function buildPending(id: string, seg1: string, seg2: string): TPending {
    let pending = accumulateStreamEvent(null, 'conv-1', {type: 'text', content: seg1} as any, id)
    pending = accumulateStreamEvent(pending!, 'conv-1', {
        type: 'tool_use', toolCall: {id: 'tc-A', name: 'bash', arguments: {}},
    } as any, id)
    pending = accumulateStreamEvent(pending!, 'conv-1', {
        type: 'tool_result', toolCallId: 'tc-A', result: {output: 'ok'},
    } as any)
    return accumulateStreamEvent(pending!, 'conv-1', {type: 'text', content: seg2} as any, id)!
}

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

function seedMessageRow(msgId: string, timestamp: number): void {
    db.prepare('INSERT INTO conversations (id, workspace_path, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run('conv-1', '', '{}', 1, 1)
    db.prepare('INSERT INTO messages (id, conversation_id, role, timestamp) VALUES (?, ?, ?, ?)')
        .run(msgId, 'conv-1', 'assistant', timestamp)
}

function insertTextBlock(msgId: string, id: string, content: string, sequence: number): void {
    db.prepare(
        'INSERT INTO message_blocks (id, message_id, block_type, content, data, sequence, timestamp) VALUES (?, ?, ?, ?, NULL, ?, ?)'
    ).run(id, msgId, 'text', content, sequence, Date.now())
}

function insertThinkBlock(msgId: string, id: string, content: string, sequence: number): void {
    db.prepare(
        'INSERT INTO message_blocks (id, message_id, block_type, content, data, sequence, timestamp) VALUES (?, ?, ?, ?, NULL, ?, ?)'
    ).run(id, msgId, 'think', content, sequence, Date.now())
}

function readDbText(msgId: string): string {
    return (db.prepare(
        "SELECT content FROM message_blocks WHERE message_id = ? AND block_type = 'text' ORDER BY sequence"
    ).all(msgId) as Array<{content: string | null}>).map(b => b.content ?? '').join('')
}

function readEndedAt(msgId: string): number | null {
    return (db.prepare('SELECT ended_at FROM messages WHERE id = ?').get(msgId) as {ended_at: number | null}).ended_at
}

beforeEach(() => {
    manager = new AgentManager()
    db = getDatabase()
    // 每用例独立表结构：DROP 后重建，避免跨用例数据残留（对齐 dualSource.test.ts 模式）
    db.exec('DROP TABLE IF EXISTS message_blocks')
    db.exec('DROP TABLE IF EXISTS messages')
    db.exec('DROP TABLE IF EXISTS conversations')
    seedSchema()
})

afterEach(() => {
    closeDatabase()
})

describe('#mergeAndPersist 接线 — blocks 已存在分支（经 handleDoneEvent 驱动）', () => {
    it('部分 text 前缀已落库：done 后 DB 补齐全文（repairTextTail 接线）', async () => {
        const full = '第一段第二段'
        const flushedPrefix = full.slice(0, 3) // 渲染端崩溃前只 flush 了前 3 字符
        seedMessageRow('m-1', 1000)
        insertTextBlock('m-1', 'text-m-1-0', flushedPrefix, 0)

        const pending = buildPending('m-1', '第一段', '第二段')
        ;(manager as any).pendingAssistantMsg.set('conv-1', pending)

        await manager.handleDoneEvent('conv-1', {type: 'done', reason: 'completed'})

        expect(readDbText('m-1')).toBe(full)
        expect(readEndedAt('m-1')).not.toBeNull()
    })

    it('仅 think 块已落库：done 后插入完整 text 块', async () => {
        seedMessageRow('m-1', 1000)
        insertThinkBlock('m-1', 'think-m-1-0', '思考内容', 0)

        const pending = buildPending('m-1', '', '完整正文')
        ;(manager as any).pendingAssistantMsg.set('conv-1', pending)

        await manager.handleDoneEvent('conv-1', {type: 'done', reason: 'completed'})

        expect(readDbText('m-1')).toBe('完整正文')
    })

    it('块已完整覆盖全文：幂等不追加、不重复（end 块合法新增不计）', async () => {
        const full = '第一段第二段'
        seedMessageRow('m-1', 1000)
        insertTextBlock('m-1', 'text-m-1-0', full, 0)
        const before = (db.prepare("SELECT COUNT(*) AS c FROM message_blocks WHERE message_id = 'm-1' AND block_type != 'end'").get() as {c: number}).c

        const pending = buildPending('m-1', '第一段', '第二段')
        ;(manager as any).pendingAssistantMsg.set('conv-1', pending)

        await manager.handleDoneEvent('conv-1', {type: 'done', reason: 'completed'})

        expect(readDbText('m-1')).toBe(full)
        const after = (db.prepare("SELECT COUNT(*) AS c FROM message_blocks WHERE message_id = 'm-1' AND block_type != 'end'").get() as {c: number}).c
        expect(after).toBe(before)
    })
})

describe('#mergeAndPersist 接线 — 指纹副本分支（渲染端占位 id 与 pending.id 不一致的竞态）', () => {
    it('副本消息只有部分 text：done 后对副本 id 补齐缺口而非跳过', async () => {
        // 渲染端以占位 id 'msg-renderer' 落库了前缀；主进程 pending.id 为 'm-1'（注册机制生效前的双 id 场景）。
        // 行 timestamp 必须贴近 pending.timestamp（真实场景中两者几乎同时创建）
        const full = '第一段第二段'
        const startTs = Date.now()
        seedMessageRow('msg-renderer', startTs)
        insertTextBlock('msg-renderer', 'text-msg-renderer-0', full.slice(0, 3), 0)

        const pending = buildPending('m-1', '第一段', '第二段')
        ;(manager as any).pendingAssistantMsg.set('conv-1', pending)

        await manager.handleDoneEvent('conv-1', {type: 'done', reason: 'completed'})

        // 不产生幽灵副本行，且副本消息被补齐
        const rows = db.prepare("SELECT COUNT(*) AS c FROM messages WHERE conversation_id = 'conv-1'").get() as {c: number}
        expect(rows.c).toBe(1)
        expect(readDbText('msg-renderer')).toBe(full)
        expect(readEndedAt('msg-renderer')).not.toBeNull()
    })
})

describe('#mergeAndPersist 全量写兜底路径回归（无 blocks / 无指纹副本）', () => {
    it('渲染进程从未落库：done 后以 pending 全文整条写入（含 end/endedAt）', async () => {
        const full = '第一段第二段'
        seedMessageRow('m-1', 1000) // 行存在（writeBlockDelta 首写建行）但无任何块
        const pending = buildPending('m-1', '第一段', '第二段')
        ;(manager as any).pendingAssistantMsg.set('conv-1', pending)

        await manager.handleDoneEvent('conv-1', {type: 'done', reason: 'completed'})

        expect(readDbText('m-1')).toBe(full)
        expect(readEndedAt('m-1')).not.toBeNull()
    })
})

describe('#mergeAndPersist — handleErrorEvent 对称收尾', () => {
    it('error 路径同样补齐缺口并落 endedAt', async () => {
        const full = '第一段第二段'
        seedMessageRow('m-1', 1000)
        insertTextBlock('m-1', 'text-m-1-0', full.slice(0, 3), 0)
        const pending = buildPending('m-1', '第一段', '第二段')
        ;(manager as any).pendingAssistantMsg.set('conv-1', pending)

        await manager.handleErrorEvent('conv-1', '模拟错误')

        expect(readDbText('m-1')).toBe(full)
        expect(readEndedAt('m-1')).not.toBeNull()
    })
})
