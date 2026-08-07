/**
 * doMergeAndPersist 保险丝补写语义（Task 6）单元测试
 *
 * 覆盖块级增量模型下主进程保险丝（fuse）的新语义：
 * - 有 blocks（渲染端已在段边界精细落库）→ 只补 endedAt（setMessageEnded 原语），
 *   绝不 DELETE+全量 INSERT 覆盖精细块（否则主进程截断版内容会劣化已落库数据）
 * - 无 blocks（渲染进程崩溃、从未落库）→ 现状全量写路径兜底
 *
 * ⚠️ 隔离保证：vi.mock 把 getHclawDir() 重定向到 os.tmpdir() 下的独立临时目录，
 *    绝不触碰真实 ~/.hclaw/data/hclaw.db（与 conversationRepository.delta.test.ts 同款探针模式）。
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'

// 注意：vi.mock 工厂被提升（hoist），不能引用文件级 const —— 路径必须在工厂内计算
vi.mock('../../../src/main/config', () => {
    const os = require('os')
    const path = require('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-persister-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
    }
})

import {getDatabase, closeDatabase} from '../../../src/main/repositories/sqlite'
import {SqliteConversationRepository} from '../../../src/main/repositories/sqlite/conversationRepository'
import {doMergeAndPersist} from '@/main/agent/manager.persister'
import type {PendingAssistantMsg} from '@/main/agent/manager.types'

function makePending(id: string, content: string): PendingAssistantMsg {
    return {
        id,
        content,
        toolCalls: [],
        thinkContent: null,
        timestamp: 1000,
    }
}

let repo: SqliteConversationRepository
let db: ReturnType<typeof getDatabase>

beforeEach(() => {
    repo = new SqliteConversationRepository()
    db = getDatabase()
    // 每个用例独立表结构：DROP 后重建，避免跨用例数据残留
    db.exec('DROP TABLE IF EXISTS message_blocks')
    db.exec('DROP TABLE IF EXISTS messages')
    db.exec('DROP TABLE IF EXISTS conversations')
    // 最小 schema（与迁移 001 + 006 + 033 对齐：含 llm_stats + is_partial）
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
        content TEXT, data TEXT, sequence INTEGER NOT NULL, timestamp INTEGER NOT NULL, ended_at INTEGER
    )`)
    repo.create('conv-1', {id: 'conv-1', title: 't', workspacePath: '/tmp/test-ws', createdAt: 1, updatedAt: 1, preview: '', status: 'active'})
})

afterEach(() => {
    closeDatabase()
})

describe('doMergeAndPersist — 保险丝补写语义', () => {
    it('有 blocks 且 isFinal：只补 endedAt，绝不覆盖渲染端精细块', async () => {
        // 预置渲染端已落库的精细块
        repo.writeBlockDelta('conv-1', 'm1', {
            upsertBlocks: [{id: 'text-m1-0', messageId: 'm1', blockType: 'text', content: '精细块', data: null, sequence: 0, timestamp: 1}],
            messageFields: {role: 'assistant', timestamp: 1},
        })

        // 主进程保险丝：pending 持有截断版全量内容，但消息已有 blocks → 只补 endedAt
        await doMergeAndPersist('conv-1', makePending('m1', '主进程截断版全量内容……'), true)

        // 精细块未被覆盖（end 块是 setMessageEnded 自身补的，排除在外）
        const blocks = db.prepare("SELECT id, content FROM message_blocks WHERE message_id = ? AND block_type != 'end'").all('m1')
        expect(blocks).toEqual([{id: 'text-m1-0', content: '精细块'}])
        // ended_at 已补齐
        const m = db.prepare('SELECT ended_at FROM messages WHERE id = ?').get('m1') as {ended_at: number | null}
        expect(m.ended_at).toBeGreaterThan(0)
        // 补上 end 块（setMessageEnded 原语行为）
        const end = db.prepare("SELECT COUNT(*) AS c FROM message_blocks WHERE message_id = ? AND block_type = 'end'").get('m1') as {c: number}
        expect(end.c).toBe(1)
    })

    it('有 blocks 且 !isFinal：什么都不做（无 DELETE / 无 INSERT / 无 ended_at 变更）', async () => {
        repo.writeBlockDelta('conv-1', 'm1', {
            upsertBlocks: [{id: 'text-m1-0', messageId: 'm1', blockType: 'text', content: '精细块', data: null, sequence: 0, timestamp: 1}],
            messageFields: {role: 'assistant', timestamp: 1},
        })

        await doMergeAndPersist('conv-1', makePending('m1', '中途保险丝写入'), false)

        const blocks = db.prepare('SELECT id, content FROM message_blocks WHERE message_id = ?').all('m1')
        expect(blocks).toEqual([{id: 'text-m1-0', content: '精细块'}])
        const m = db.prepare('SELECT ended_at FROM messages WHERE id = ?').get('m1') as {ended_at: number | null}
        expect(m.ended_at).toBeNull()
    })

    it('无 blocks（渲染进程从未落库）：现状全量写路径兜底', async () => {
        await doMergeAndPersist('conv-1', makePending('m1', '兜底全量内容'), false)

        const blocks = db.prepare('SELECT block_type, content FROM message_blocks WHERE message_id = ? ORDER BY sequence').all('m1')
        expect(blocks).toEqual([{block_type: 'text', content: '兜底全量内容'}])
        const m = db.prepare('SELECT role, is_partial, ended_at FROM messages WHERE id = ?').get('m1') as {role: string; is_partial: number; ended_at: number | null}
        expect(m.role).toBe('assistant')
        expect(m.is_partial).toBe(1) // !isFinal → 部分写入标记
        expect(m.ended_at).toBeNull()
    })

    it('无 blocks 且 isFinal：全量写并标记结束（ended_at + end 块）', async () => {
        await doMergeAndPersist('conv-1', makePending('m1', '最终兜底内容'), true)

        const m = db.prepare('SELECT ended_at, is_partial FROM messages WHERE id = ?').get('m1') as {ended_at: number | null; is_partial: number}
        expect(m.ended_at).toBeGreaterThan(0)
        expect(m.is_partial).toBe(0)
        const end = db.prepare("SELECT COUNT(*) AS c FROM message_blocks WHERE message_id = ? AND block_type = 'end'").get('m1') as {c: number}
        expect(end.c).toBe(1)
    })

    it('TOCTOU 竞态防护：首次 COUNT 之后、全量写事务之前渲染端写入精细块 → 事务内重查，放弃全量写只补 endedAt', async () => {
        // 模拟竞态：doMergeAndPersist 首次 COUNT 检查（无 blocks）后，await import(...) 让出的
        // 时间片内渲染端把精细块落库。这里在 import 之后的 beforeUserRows 查询处注入
        // "渲染端写入"（消息行 + 精细块，与 writeBlockDelta 建行语义一致）。
        // 修复前（无事务内重查）：DELETE + 全量 INSERT 会删掉该精细块并用截断版覆盖——本用例锁定此回归。
        const origPrepare = db.prepare.bind(db)
        let injected = false
        vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
            const stmt = origPrepare(sql)
            if (!injected && sql.includes('FROM messages') && sql.includes('WHERE conversation_id')) {
                injected = true
                // 渲染端 writeBlockDelta 等价写入：消息行 + 精细块（同一事务原子性以单条语句体现）
                origPrepare("INSERT OR REPLACE INTO messages (id, conversation_id, role, timestamp, ended_at, metadata, llm_stats) VALUES (?, ?, 'assistant', ?, NULL, '{}', NULL)")
                    .run('m1', 'conv-1', 1)
                origPrepare("INSERT OR REPLACE INTO message_blocks (id, message_id, block_type, content, data, sequence, timestamp, ended_at) VALUES (?, ?, 'text', ?, NULL, 0, ?, NULL)")
                    .run('text-race-0', 'm1', 'import 窗口内渲染端写入的精细块', 1)
            }
            return stmt
        }) as any)

        await doMergeAndPersist('conv-1', makePending('m1', '主进程截断版全量内容……'), true)
        vi.restoreAllMocks()

        // ★ 不变式：渲染端精细块未被 DELETE/覆盖（end 块是 setMessageEnded 补的，排除）
        const blocks = db.prepare("SELECT id, content FROM message_blocks WHERE message_id = ? AND block_type != 'end'").all('m1')
        expect(blocks).toEqual([{id: 'text-race-0', content: 'import 窗口内渲染端写入的精细块'}])
        // 主进程截断版内容不得出现
        const truncated = db.prepare("SELECT COUNT(*) AS c FROM message_blocks WHERE message_id = ? AND content = ?")
            .get('m1', '主进程截断版全量内容……') as {c: number}
        expect(truncated.c).toBe(0)
        // 退化分支只补 endedAt（复用 setMessageEnded 原语）
        const m = db.prepare('SELECT ended_at FROM messages WHERE id = ?').get('m1') as {ended_at: number | null}
        expect(m.ended_at).toBeGreaterThan(0)
        const end = db.prepare("SELECT COUNT(*) AS c FROM message_blocks WHERE message_id = ? AND block_type = 'end'").get('m1') as {c: number}
        expect(end.c).toBe(1)
    })
})
