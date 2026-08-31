/**
 * conversationRepository list() updatedAt 双源漂移 单元测试
 *
 * 背景（bug）：writeMessages / writeMessagesDelta 只更新列 updated_at，
 * 不更新 meta JSON 里的 updatedAt；而 list()（IPC conversation-list）返回的
 * updatedAt 来自 meta JSON → 渲染端 loadConversations 重载后拿到旧值，
 * 排序与实时状态（touchConversation 用列时间）不一致。
 *
 * 修复语义：list() 与 listWithStats() 同口径——列 updated_at 为唯一真源，
 * 读侧用它覆盖 meta JSON 的 updatedAt。
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'

// 隔离：重定向到 os.tmpdir() 下的独立临时目录，绝不触碰真实 ~/.hclaw/data/hclaw.db
vi.mock('../../../../src/main/config', () => {
    const os = require('os')
    const path = require('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-updatedat-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
    }
})

import {closeDatabase, getDatabase} from '../../../../src/main/repositories/sqlite'
import {SqliteConversationRepository} from '../../../../src/main/repositories/sqlite/conversationRepository'
import type {Message} from '@shared/types'

let repo: SqliteConversationRepository
let db: ReturnType<typeof getDatabase>

beforeEach(() => {
    repo = new SqliteConversationRepository()
    db = getDatabase()
    db.exec('DROP TABLE IF EXISTS message_blocks')
    db.exec('DROP TABLE IF EXISTS messages')
    db.exec('DROP TABLE IF EXISTS conversations')
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
})

afterEach(() => { closeDatabase() })

function buildMsg(id: string, ts: number): Message {
    return {
        id, role: 'assistant', content: 'hello', timestamp: ts,
        metadata: {}, contentBlocks: [{id: `b-${id}`, type: 'text' as const, text: 'hello', timestamp: ts}],
    } as unknown as Message
}

describe('list() — updatedAt 以列 updated_at 为唯一真源（双源漂移修复）', () => {
    it('writeMessagesDelta 更新列后，list() 返回列值而非 meta JSON 旧值', () => {
        const t0 = 1000
        repo.create('conv-1', {
            id: 'conv-1', title: 't', workspacePath: '',
            createdAt: t0, updatedAt: t0, preview: '', status: 'active',
        } as any)

        // 写侧只更新列 updated_at（meta JSON 的 updatedAt 仍是 t0）
        const t1 = 5000
        repo.writeMessagesDelta('conv-1', buildMsg('m-1', t1))

        const colUpdatedAt = (db.prepare('SELECT updated_at FROM conversations WHERE id = ?').get('conv-1') as {updated_at: number}).updated_at
        expect(colUpdatedAt).toBeGreaterThanOrEqual(t1)

        const listed = repo.list().find(c => c.id === 'conv-1')!
        // 修复前：此处返回 meta JSON 的 t0（漂移）→ 测试失败
        expect(listed.updatedAt).toBe(colUpdatedAt)
    })

    it('writeMessages 更新列后，list() 同样返回列值', () => {
        const t0 = 1000
        repo.create('conv-1', {
            id: 'conv-1', title: 't', workspacePath: '',
            createdAt: t0, updatedAt: t0, preview: '', status: 'active',
        } as any)

        repo.writeMessages('conv-1', [buildMsg('m-1', 5000)])

        const colUpdatedAt = (db.prepare('SELECT updated_at FROM conversations WHERE id = ?').get('conv-1') as {updated_at: number}).updated_at
        const listed = repo.list().find(c => c.id === 'conv-1')!
        expect(listed.updatedAt).toBe(colUpdatedAt)
    })

    it('list() 仍返回 meta JSON 的其余字段（title 等不受影响）', () => {
        repo.create('conv-1', {
            id: 'conv-1', title: '标题', workspacePath: '',
            createdAt: 1000, updatedAt: 1000, preview: '', status: 'active',
        } as any)
        const listed = repo.list().find(c => c.id === 'conv-1')!
        expect(listed.title).toBe('标题')
        expect(listed.createdAt).toBe(1000)
    })
})
