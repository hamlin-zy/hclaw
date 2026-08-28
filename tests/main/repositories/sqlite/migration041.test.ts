import {describe, expect, it} from 'vitest'
import fs from 'fs'
import path from 'path'
import {DatabaseSync, type DatabaseSyncInstance} from '@photostructure/sqlite'

const MIGRATION = path.join(__dirname, '../../../../src/main/repositories/sqlite/migrations/041_backfill_llm_usage_provider_id.sql')

/** 构造老库：providers + llm_usage（含 NULL provider_id 历史行） */
function makeLegacyDb(): DatabaseSyncInstance {
    const db = new DatabaseSync(':memory:')
    db.exec(`
        CREATE TABLE providers (
            id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, type TEXT NOT NULL,
            auth_type TEXT NOT NULL DEFAULT 'api-key', base_url TEXT NOT NULL DEFAULT '',
            credentials TEXT NOT NULL DEFAULT '{}', email TEXT NOT NULL DEFAULT '',
            enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE llm_usage (
            id TEXT PRIMARY KEY, conversation_id TEXT, message_id TEXT,
            provider_type TEXT, model TEXT, provider_name TEXT, provider_id TEXT,
            input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
            cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
            reasoning_tokens INTEGER, ttft_ms INTEGER, decode_ms INTEGER,
            duration_ms INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
        );
        INSERT INTO providers (id, name, type, created_at, updated_at) VALUES
            ('p-or', 'OpenRouter', 'openai', 1, 1),
            ('p-o', 'dsh', 'openai', 1, 1),                         -- dsh 历史上是 anthropic，现改 openai（name 唯一）
            ('p-x', '智谱', 'openai', 1, 1);
        INSERT INTO llm_usage (id, provider_type, model, provider_name, provider_id, duration_ms, created_at) VALUES
            ('u1', 'openai', 'glm', 'OpenRouter', NULL, 0, 1),      -- name+type 精确命中 → p-or
            ('u2', 'anthropic', 'deepseek', 'dsh', NULL, 0, 1),     -- 类型已改 → 兜底 name 唯一命中 → p-o
            ('u3', 'openai', 'glm', '智谱', NULL, 0, 1),            -- 精确命中 → p-x
            ('u4', 'openai', 'glm', 'OpenRouter', 'already', 0, 1), -- 已有 id → 不动
            ('u5', 'openai', 'glm', '不存在', NULL, 0, 1);          -- 无匹配 → 保持 NULL
    `)
    return db
}

describe('migration 041 — 回填 llm_usage NULL provider_id', () => {
    it('name+type 精确命中回填；已有 id 不动；无匹配保持 NULL', () => {
        const db = makeLegacyDb()
        db.exec(fs.readFileSync(MIGRATION, 'utf8'))
        const get = (id: string) =>
            (db.prepare('SELECT provider_id FROM llm_usage WHERE id = ?').get(id) as {provider_id: string | null}).provider_id
        expect(get('u1')).toBe('p-or')
        expect(get('u3')).toBe('p-x')
        expect(get('u4')).toBe('already')
        expect(get('u5')).toBeNull()
        db.close()
    })

    it('name 唯一但 type 不匹配时兜底回填（服务商改过类型的场景）', () => {
        const db = makeLegacyDb()
        db.exec(fs.readFileSync(MIGRATION, 'utf8'))
        const row = db.prepare("SELECT provider_id FROM llm_usage WHERE id = 'u2'").get() as {provider_id: string | null}
        expect(row.provider_id).toBe('p-o')
        db.close()
    })

    it('可重复执行（幂等）：二次执行无副作用', () => {
        const db = makeLegacyDb()
        const sql = fs.readFileSync(MIGRATION, 'utf8')
        db.exec(sql)
        db.exec(sql)
        const n = db.prepare("SELECT COUNT(*) AS c FROM llm_usage WHERE provider_id = 'p-or'").get() as {c: number}
        expect(n.c).toBe(1)
        db.close()
    })
})
