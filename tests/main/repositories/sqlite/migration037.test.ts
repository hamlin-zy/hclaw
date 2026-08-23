import {describe, expect, it} from 'vitest'
import fs from 'fs'
import path from 'path'
import {DatabaseSync} from '@photostructure/sqlite'

/**
 * migration 037（只加列版本）
 *
 * 保护：
 * 1. 迁移文件只包含 ALTER TABLE ADD COLUMN（单语句、原子、成功即记录、失败无副作用）
 * 2. 不包含任何回填 UPDATE（历史数据保持 NULL，旧会话走 think 边界 fallback）
 * 3. 加列后新写入块可携带 turn_index（新会话精确溯源路径）
 */
describe('migration 037 — 只加列不回填', () => {
    it('迁移文件仅含 ALTER TABLE ADD COLUMN（无回填语句）', () => {
        const sql = fs.readFileSync(
            path.join(__dirname, '../../../../src/main/repositories/sqlite/migrations/037_message_blocks_turn_index.sql'),
            'utf8',
        )
        // 必须含加列语句
        expect(sql).toContain('ALTER TABLE message_blocks ADD COLUMN turn_index INTEGER')
        // 不得含回填语句（用户明确要求不修复历史数据）
        expect(sql).not.toContain('WITH RECURSIVE')
        expect(sql).not.toContain('UPDATE message_blocks')
        expect(sql).not.toContain('SET turn_index')
    })

    it('在全新库上执行成功：加列且无任何 turn_index 值（不回填）', () => {
        const db = new DatabaseSync(':memory:')
        db.exec(`CREATE TABLE message_blocks (
            id TEXT PRIMARY KEY, message_id TEXT NOT NULL, block_type TEXT NOT NULL,
            content TEXT, data TEXT, sequence INTEGER NOT NULL, timestamp INTEGER NOT NULL, ended_at INTEGER
        )`)
        db.prepare("INSERT INTO message_blocks (id, message_id, block_type, sequence, timestamp) VALUES ('b1', 'm1', 'think', 0, 1000)").run()

        const sql = fs.readFileSync(
            path.join(__dirname, '../../../../src/main/repositories/sqlite/migrations/037_message_blocks_turn_index.sql'),
            'utf8',
        )
        db.exec(sql)

        const cols = db.prepare('PRAGMA table_info(message_blocks)').all() as Array<{name: string}>
        expect(cols.some(c => c.name === 'turn_index')).toBe(true)
        // 已存在的行 turn_index 为 NULL（不回填历史）
        const row = db.prepare("SELECT turn_index FROM message_blocks WHERE id = 'b1'").get() as {turn_index: number | null}
        expect(row.turn_index).toBeNull()
        db.close()
    })

    it('新写入块可携带 turn_index（新会话精确溯源）', () => {
        const db = new DatabaseSync(':memory:')
        db.exec(`CREATE TABLE message_blocks (
            id TEXT PRIMARY KEY, message_id TEXT NOT NULL, block_type TEXT NOT NULL,
            content TEXT, data TEXT, sequence INTEGER NOT NULL, timestamp INTEGER NOT NULL, ended_at INTEGER
        )`)
        const sql = fs.readFileSync(
            path.join(__dirname, '../../../../src/main/repositories/sqlite/migrations/037_message_blocks_turn_index.sql'),
            'utf8',
        )
        db.exec(sql)
        db.prepare("INSERT INTO message_blocks (id, message_id, block_type, sequence, timestamp, turn_index) VALUES ('b2', 'm2', 'tool_call', 0, 1000, 3)").run()
        const row = db.prepare("SELECT turn_index FROM message_blocks WHERE id = 'b2'").get() as {turn_index: number | null}
        expect(row.turn_index).toBe(3)
        db.close()
    })
})
