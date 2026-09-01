/**
 * conversationRepository 重建排序契约测试（Task 2）
 *
 * 覆盖：
 * - getMessages(readMessages) 对同 timestamp 的消息按 rowid（插入顺序）返回
 *   契约：ORDER BY timestamp ASC, rowid ASC —— Task 4 字节级重建测试依赖此契约
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'

// 隔离：重定向到 os.tmpdir() 下的独立临时目录，绝不触碰真实 ~/.hclaw/data/hclaw.db
vi.mock('../../../../src/main/config', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.mock 工厂被提升，不能引用文件级 const
    const os = require('os')
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- 同上
    const path = require('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-rowid-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
    }
})

import {closeDatabase, getDatabase} from '../../../../src/main/repositories/sqlite'
import {SqliteConversationRepository} from '../../../../src/main/repositories/sqlite/conversationRepository'

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

describe('turn 内落库顺序（spec §5.4）：user → CT → catalog → assistant → tool', () => {
    it('真实写入路径下，turn 链路端到端落库后 DB 读回顺序与落库序一致', () => {
        const convId = 'test-turn-order'
        const ts = Date.now()
        db.prepare('INSERT INTO conversations (id, workspace_path, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run(convId, '', '{}', ts, ts)

        // 真实命令 turn 落库序（同毫秒注入消息先于 LLM 调用，assistant 行由首个内容块经
        // writeBlockDelta 首写分支 ensureMessageRow 语义创建，无占位行）：
        // 1. user 消息
        expect(repo.writeMessagesDelta(convId, {
            id: 'turn-user', role: 'user', content: 'hi', timestamp: ts,
        } as never)).toBe(true)
        // 2. CT 注入消息（controller.ts:347 路径，user role）
        expect(repo.writeMessagesDelta(convId, {
            id: 'turn-ct', role: 'user', content: '[system turn counter]', timestamp: ts,
        } as never)).toBe(true)
        // 3. catalog 注入消息（catalogPublish.ts:104 路径）
        expect(repo.writeMessagesDelta(convId, {
            id: 'turn-catalog', role: 'user', content: '[capability catalog]', timestamp: ts,
            metadata: {sourceKind: 'capability-catalog'},
        } as never)).toBe(true)
        // 4. assistant 行：首个内容块到达，writeBlockDelta 首写分支建行（同 timestamp）
        expect(repo.writeBlockDelta(convId, 'turn-assistant', {
            messageFields: {role: 'assistant', timestamp: ts},
            upsertBlocks: [{
                id: 'turn-assistant-b0', messageId: 'turn-assistant', blockType: 'text',
                content: 'hello', data: null, sequence: 0, timestamp: ts,
            }],
        } as never)).toBe(true)
        // 5. tool 消息（工具执行后追加的 assistant 消息，同毫秒）
        expect(repo.writeMessagesDelta(convId, {
            id: 'turn-tool', role: 'assistant', content: '[tool result]', timestamp: ts,
        } as never)).toBe(true)

        // 读回：ORDER BY timestamp ASC, rowid ASC → 同毫秒按插入（rowid）序
        const msgs = repo.readMessages(convId)
        expect(msgs.map(m => m.id)).toEqual([
            'turn-user', 'turn-ct', 'turn-catalog', 'turn-assistant', 'turn-tool',
        ])
    })
})

describe('重建排序：同 timestamp 按 rowid（插入序）', () => {
    it('同毫秒落库的消息按插入顺序返回', () => {
        const convId = 'test-rowid-order'
        const ts = Date.now()
        // 按顺序落库三条同 timestamp 消息
        const stmt = db.prepare(
            'INSERT INTO messages (id, conversation_id, role, timestamp) VALUES (?, ?, ?, ?)'
        )
        for (const [i, role] of ['user', 'assistant', 'user'].entries()) {
            stmt.run(`rowid-test-${i}`, convId, role, ts)
        }
        const msgs = repo.readMessages(convId)
        expect(msgs.map(m => m.id)).toEqual(['rowid-test-0', 'rowid-test-1', 'rowid-test-2'])
    })
})
