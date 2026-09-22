/**
 * message_blocks 不可变列守卫（迁移 051）—— UPSERT 契约的 SQL 层兜底
 *
 * 契约：`id` / `sequence` / `block_type` / `message_id` 只在 INSERT 时确定
 * （sequence 由 nextSeq() 分配、id/block_type/message_id 由写侧派生），
 * UPDATE 永不修改 —— 见 brief / spec《块 id 派生稳定化 + UPSERT 契约守卫》。
 *
 * 本测试**走真实迁移执行路径**（runMigrations() → 逐个执行 migrations/*.sql），
 * 不手写建触发器，否则测不到迁移文件本身是否被 runner 执行。
 *
 * 用例覆盖：
 * - 迁移 051 已被执行（migrations 表有记录）且触发器已建
 * - 防误伤：合法 UPDATE（content / data / timestamp / ended_at）仍然成功
 * - 四列任一被 UPDATE → ABORT，错误信息含 immutable
 * - ★ 已知边界：INSERT OR REPLACE 绕过守卫（REPLACE = DELETE + INSERT，BEFORE UPDATE
 *   触发器不生效）—— 用例显式固化该边界范围，守卫升级覆盖 REPLACE 前须先改该用例
 */
import {describe, expect, it, beforeAll, afterAll, vi} from 'vitest'

// 隔离：重定向到 os.tmpdir() 下的独立临时目录，绝不触碰真实 ~/.hclaw/data/hclaw.db
vi.mock('../../../src/main/config', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.mock 工厂被提升，不能引用文件级 const
    const os = require('os')
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- 同上
    const path = require('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-blockimmutable-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
    }
})
vi.mock('../../../src/main/hclawPaths', async () => await import('../../../src/main/config'))  // 路径能力已下沉到叶子 hclawPaths：让叶子跟随本文件对 config 的桩

import {closeDatabase, getDatabase, runMigrations} from '../../../src/main/repositories/sqlite'
import {SqliteMessageBlockRepository} from '../../../src/main/repositories/sqlite/messageBlockRepository'

const GUARD_TRIGGER = 'trg_message_blocks_immutable_cols'
const MIGRATION_FILE = '051_message_blocks_immutable_columns.sql'
const MSG_ID = 'msg-immutable-1'
const MSG_ID_2 = 'msg-immutable-2'   // REPLACE 边界用例的第二条消息（外键目标）
const BLOCK_ID = `${MSG_ID}-b0`

let db: ReturnType<typeof getDatabase>

beforeAll(() => {
    db = getDatabase()
    runMigrations()   // ★ 真实迁移路径：由 051 迁移文件建立守卫触发器

    db.prepare('INSERT INTO conversations (id, workspace_path, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run('conv-immutable', '', '{}', 1, 1)
    db.prepare('INSERT INTO messages (id, conversation_id, role, timestamp) VALUES (?, ?, ?, ?)')
        .run(MSG_ID, 'conv-immutable', 'assistant', 1000)
    db.prepare('INSERT INTO messages (id, conversation_id, role, timestamp) VALUES (?, ?, ?, ?)')
        .run(MSG_ID_2, 'conv-immutable', 'assistant', 1000)
})

afterAll(() => { closeDatabase() })

/** 每个用例前重置块行（保证幂等：用例里对块的修改不跨用例残留） */
function seedBlock(): void {
    db.prepare('DELETE FROM message_blocks WHERE message_id = ?').run(MSG_ID)
    db.prepare(
        'INSERT INTO message_blocks (id, message_id, block_type, content, data, sequence, timestamp, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(BLOCK_ID, MSG_ID, 'text', '原文', null, 0, 1000, null)
}

interface BlockRow {
    id: string
    message_id: string
    block_type: string
    content: string | null
    data: string | null
    sequence: number
    timestamp: number
    ended_at: number | null
}

function readRow(): BlockRow {
    return db.prepare('SELECT id, message_id, block_type, content, data, sequence, timestamp, ended_at FROM message_blocks WHERE id = ?')
        .get(BLOCK_ID) as BlockRow
}

describe('迁移 051 — message_blocks 不可变列守卫', () => {
    it('runMigrations() 已执行 051 且建出守卫触发器', () => {
        const executed = db.prepare('SELECT name FROM migrations WHERE name = ?').get(MIGRATION_FILE) as {name: string} | undefined
        expect(executed?.name).toBe(MIGRATION_FILE)

        const trigger = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(GUARD_TRIGGER) as {name: string; sql: string} | undefined
        expect(trigger?.name).toBe(GUARD_TRIGGER)
        expect(trigger?.sql).toContain('BEFORE UPDATE OF id, sequence, block_type, message_id')
    })

    it('防误伤：合法 UPDATE（content / data / timestamp / ended_at）仍然成功', () => {
        seedBlock()
        db.prepare('UPDATE message_blocks SET content = ?, data = ?, timestamp = ?, ended_at = ? WHERE id = ?')
            .run('改后的正文', '{"k":1}', 2000, 2000, BLOCK_ID)

        const row = readRow()
        expect(row.content).toBe('改后的正文')
        expect(row.data).toBe('{"k":1}')
        expect(row.timestamp).toBe(2000)
        expect(row.ended_at).toBe(2000)
        // 不可变列保持原值（写入的是合法列，不应被守卫牵连）
        expect(row.id).toBe(BLOCK_ID)
        expect(row.message_id).toBe(MSG_ID)
        expect(row.block_type).toBe('text')
        expect(row.sequence).toBe(0)
    })

    it('防误伤：仓库真实写路径 updateBlock() 仍可用', () => {
        seedBlock()
        const repo = new SqliteMessageBlockRepository()
        repo.updateBlock(BLOCK_ID, {content: 'repo 写入', endedAt: 3000})

        const row = readRow()
        expect(row.content).toBe('repo 写入')
        expect(row.ended_at).toBe(3000)
        expect(row.sequence).toBe(0)
    })

    it('UPDATE sequence → ABORT（错误信息含 immutable）', () => {
        seedBlock()
        expect(() => db.prepare('UPDATE message_blocks SET sequence = ? WHERE id = ?').run(99, BLOCK_ID))
            .toThrow(/immutable/)
        expect(readRow().sequence).toBe(0)
    })

    it('UPDATE id → ABORT（错误信息含 immutable）', () => {
        seedBlock()
        expect(() => db.prepare('UPDATE message_blocks SET id = ? WHERE id = ?').run('hijacked-id', BLOCK_ID))
            .toThrow(/immutable/)
        expect(readRow().id).toBe(BLOCK_ID)
    })

    it('UPDATE block_type → ABORT（错误信息含 immutable）', () => {
        seedBlock()
        expect(() => db.prepare('UPDATE message_blocks SET block_type = ? WHERE id = ?').run('think', BLOCK_ID))
            .toThrow(/immutable/)
        expect(readRow().block_type).toBe('text')
    })

    it('UPDATE message_id → ABORT（错误信息含 immutable）', () => {
        seedBlock()
        expect(() => db.prepare('UPDATE message_blocks SET message_id = ? WHERE id = ?').run('other-msg', BLOCK_ID))
            .toThrow(/immutable/)
        expect(readRow().message_id).toBe(MSG_ID)
    })

    it('非法列与合法列同句 UPDATE → 整句 ABORT，合法列也不落地（原子性）', () => {
        seedBlock()
        expect(() => db.prepare('UPDATE message_blocks SET content = ?, sequence = ? WHERE id = ?').run('半截', 42, BLOCK_ID))
            .toThrow(/immutable/)
        const row = readRow()
        expect(row.content).toBe('原文')
        expect(row.sequence).toBe(0)
    })

    it('守卫列范围锁定为契约四列：turn_index 等其他列不被拦截', () => {
        // 契约只冻结 id / sequence / block_type / message_id；本用例用于在守卫列被悄悄扩大时失败
        seedBlock()
        expect(() => db.prepare('UPDATE message_blocks SET turn_index = ? WHERE id = ?').run(7, BLOCK_ID)).not.toThrow()
    })

    it('★ 已知边界（非漏洞）：INSERT OR REPLACE 不受守卫管辖，可改写四列 —— 守卫只覆盖 UPDATE 路径', () => {
        // 现状固化（已实证）：REPLACE = DELETE + INSERT，SQLite 的 BEFORE UPDATE 触发器对它
        // 完全不生效。本用例显式固化「REPLACE 不受守卫管辖」这一**已知边界**：
        // 同 id 一行可被 REPLACE 任意改写 sequence 0→77、block_type text→think、
        // message_id 改挂到另一条消息，全程不抛错（对比上方 4 条 UPDATE 用例全部 ABORT）。
        // id 列语义同理失效：REPLACE 语句给什么 id 就落什么 id（它是 REPLACE 的冲突键，
        // 等于「写入侧自由决定」，而非被守卫冻结）。
        //
        // 这是已知边界而非漏洞，用例如实描述守卫范围；仓内该写法真实存在 5 处
        // （messageBlockRepository.ts:9,88、conversationRepository.ts:153,217、
        //  manager.impl.ts:955），均须自证不重排 sequence。
        // ★ 若未来守卫要覆盖 REPLACE 路径（如改为 BEFORE INSERT OR REPLACE 组合 /
        //   改用 UPSERT … ON CONFLICT DO UPDATE），必须先改这条用例（把「不抛错」
        //   改成「抛错」），否则守卫升级与用例将互相矛盾。
        seedBlock()
        db.prepare('INSERT OR REPLACE INTO message_blocks (id, message_id, block_type, content, data, sequence, timestamp, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(BLOCK_ID, MSG_ID_2, 'think', '被 REPLACE 改写', null, 77, 1000, null)

        const row = readRow()
        expect(row.sequence).toBe(77)          // 守卫列被改写
        expect(row.block_type).toBe('think')   // 守卫列被改写
        expect(row.message_id).toBe(MSG_ID_2)  // 守卫列被改写
        expect(row.id).toBe(BLOCK_ID)          // REPLACE 冲突键本身保持不变
    })
})
