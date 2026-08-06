/**
 * conversationRepository.buildMessagesFromRows 崩溃恢复标记 单元测试（Task 6）
 *
 * 覆盖 readMessages 还原时对"未完成消息"的 _partialRecovery 标记：
 * - is_partial=1 的 assistant 消息 → metadata._partialRecovery = true
 * - is_partial=0 但 ended_at IS NULL 的 assistant 消息 → _partialRecovery = true（兜底判定）
 * - 有 ended_at 的 assistant 消息 → 无标记
 * - user 消息（即使 is_partial=1）→ 无标记
 * - is_partial=0 + ended_at 存在的正常消息 → 无标记
 *
 * buildMessagesFromRows 为私有方法，通过 SqliteConversationRepository.readMessages 间接验证。
 * 直接 INSERT 携带 is_partial 值的行（repo.writeMessages 不含 is_partial 列）。
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'

// 隔离：重定向到 os.tmpdir() 下的独立临时目录，绝不触碰真实 ~/.hclaw/data/hclaw.db
vi.mock('../../../../src/main/config', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.mock 工厂被提升，不能引用文件级 const
    const os = require('os')
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- 同上
    const path = require('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-recovery-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
    }
})

import {closeDatabase, getDatabase} from '../../../../src/main/repositories/sqlite'
import {SqliteConversationRepository} from '../../../../src/main/repositories/sqlite/conversationRepository'

const CONV = 'conv-recovery'

let repo: SqliteConversationRepository
let db: ReturnType<typeof getDatabase>

/** 直接 INSERT 一条带 is_partial / ended_at 值的消息行 */
function insertMsg(id: string, role: 'user' | 'assistant', isPartial: number, endedAt: number | null): void {
    db.prepare(
        'INSERT INTO messages (id, conversation_id, role, timestamp, ended_at, metadata, llm_stats, is_partial) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, CONV, role, 1000, endedAt, null, null, isPartial)
}

function readMetadata(id: string): Record<string, unknown> {
    const msg = repo.readMessages(CONV).find(m => m.id === id)
    expect(msg).toBeDefined()
    return msg!.metadata ?? {}
}

beforeEach(() => {
    repo = new SqliteConversationRepository()
    db = getDatabase()
    // 每个用例独立表结构：DROP 后重建，避免跨用例数据残留（含 is_partial 列）
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
        content TEXT, data TEXT, sequence INTEGER NOT NULL, timestamp INTEGER NOT NULL, ended_at INTEGER
    )`)
})

afterEach(() => {
    closeDatabase()
})

describe('buildMessagesFromRows — 崩溃恢复标记 _partialRecovery', () => {
    it('is_partial=1 的 assistant 消息 → metadata._partialRecovery = true', () => {
        insertMsg('m-partial', 'assistant', 1, null)

        expect(readMetadata('m-partial')._partialRecovery).toBe(true)
    })

    it('is_partial=0 但 ended_at IS NULL 的 assistant 消息 → _partialRecovery = true（兜底判定）', () => {
        insertMsg('m-no-ended', 'assistant', 0, null)

        expect(readMetadata('m-no-ended')._partialRecovery).toBe(true)
    })

    it('有 ended_at 的 assistant 消息 → 无标记', () => {
        insertMsg('m-finished', 'assistant', 0, 9999)

        expect(readMetadata('m-finished')._partialRecovery).toBeUndefined()
    })

    it('user 消息（即使 is_partial=1）→ 无标记', () => {
        insertMsg('u-partial', 'user', 1, null)

        expect(readMetadata('u-partial')._partialRecovery).toBeUndefined()
    })

    it('is_partial=0 + ended_at 存在的正常消息 → 无标记（正常消息不被误标）', () => {
        insertMsg('m-normal', 'assistant', 0, 8888)
        insertMsg('u-normal', 'user', 0, 8888)

        expect(readMetadata('m-normal')._partialRecovery).toBeUndefined()
        expect(readMetadata('u-normal')._partialRecovery).toBeUndefined()
    })

    it('混合会话：仅未完成的 assistant 消息带标记，其余原样', () => {
        insertMsg('m-crash', 'assistant', 1, null)          // 心跳写入未 final
        insertMsg('m-final', 'assistant', 0, 7777)          // 正常完成
        insertMsg('u-normal', 'user', 0, 7777)              // 用户消息

        const msgs = repo.readMessages(CONV)
        expect(msgs.find(m => m.id === 'm-crash')!.metadata?._partialRecovery).toBe(true)
        expect(msgs.find(m => m.id === 'm-final')!.metadata?._partialRecovery).toBeUndefined()
        expect(msgs.find(m => m.id === 'u-normal')!.metadata?._partialRecovery).toBeUndefined()
    })
})
