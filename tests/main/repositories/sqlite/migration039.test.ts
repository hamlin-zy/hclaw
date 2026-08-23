import {describe, expect, it} from 'vitest'
import fs from 'fs'
import path from 'path'
import {DatabaseSync, type DatabaseSyncInstance} from '@photostructure/sqlite'

const MIGRATION = path.join(__dirname, '../../../../src/main/repositories/sqlite/migrations/039_model_scheme_fixed_roles.sql')

/** 构造老库：model_scheme_roles（含自定义/死角色 + 自定义 displayName）+ providers（无 api_style） */
function makeLegacyDb(): DatabaseSyncInstance {
    const db = new DatabaseSync(':memory:')
    db.exec(`
        CREATE TABLE model_scheme_roles (
            id TEXT PRIMARY KEY, scheme_id TEXT NOT NULL, role TEXT NOT NULL,
            endpoint_id TEXT NOT NULL, model_id TEXT NOT NULL, model_type TEXT NOT NULL DEFAULT 'text',
            enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
            display_name TEXT, icon TEXT, description TEXT
        );
        CREATE TABLE providers (
            id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, type TEXT NOT NULL,
            auth_type TEXT NOT NULL DEFAULT 'api-key', base_url TEXT NOT NULL DEFAULT '',
            credentials TEXT NOT NULL DEFAULT '{}', email TEXT NOT NULL DEFAULT '',
            enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        INSERT INTO model_scheme_roles (id, scheme_id, role, endpoint_id, model_id, model_type, enabled, created_at, updated_at, display_name, icon, description) VALUES
            ('r1', 's1', 'primary', 'p1', 'm1', 'text', 1, 1, 1, '我的主力', 'custom-icon', '自定义描述'),
            ('r2', 's1', 'image_generation', 'p1', 'm-img', 'image', 1, 1, 1, '生图', NULL, NULL),
            ('r3', 's1', 'voice_clone', 'p1', 'm-voice', 'voice', 1, 1, 1, NULL, NULL, NULL),
            ('r4', 's1', 'custom-uuid-role', 'p1', 'm-x', 'text', 1, 1, 1, '自定义角色', NULL, NULL),
            ('r5', 's1', 'video_understanding', 'p1', 'm-video', 'video', 0, 1, 1, NULL, NULL, NULL),
            ('r6', 's1', 'lightweight', 'p1', 'm-lite', 'text', 1, 1, 1, '自定义轻量名', 'lite-icon', NULL),
            ('r7', 's1', 'reasoning', 'p1', 'm-reason', 'text', 1, 1, 1, NULL, NULL, NULL),
            ('r8', 's1', 'image_understanding', 'p1', 'm-img-u', 'image', 1, 1, 1, '看图', NULL, NULL),
            ('r9', 's1', 'audio_understanding', 'p1', 'm-audio-u', 'audio', 1, 1, 1, NULL, NULL, NULL);
        INSERT INTO providers (id, name, type, enabled, created_at, updated_at) VALUES
            ('p1', 'OpenAI', 'openai', 1, 1, 1);
    `)
    return db
}

describe('migration 039 — 固定 6 角色 + api_style', () => {
    it('迁移后仅剩固定 6 角色，displayName 重置为固定值', () => {
        const db = makeLegacyDb()
        const sql = fs.readFileSync(MIGRATION, 'utf8')
        db.exec(sql)
        const roles = db.prepare('SELECT role, display_name, icon FROM model_scheme_roles ORDER BY role').all() as Array<{role: string; display_name: string | null; icon: string | null}>
        expect(roles.map(r => r.role).sort()).toEqual([
            'audio_understanding', 'image_understanding', 'lightweight',
            'primary', 'reasoning', 'video_understanding',
        ])
        const primary = roles.find(r => r.role === 'primary')!
        expect(primary.display_name).toBe('主力模型')
        expect(primary.icon).toBe('🎯')
        const video = roles.find(r => r.role === 'video_understanding')!
        expect(video.display_name).toBe('视频理解')
        expect(video.icon).toBe('🎬')
        db.close()
    })

    it('providers 表新增 api_style 列，默认 chat', () => {
        const db = makeLegacyDb()
        const sql = fs.readFileSync(MIGRATION, 'utf8')
        db.exec(sql)
        const cols = db.prepare('PRAGMA table_info(providers)').all() as Array<{name: string}>
        expect(cols.some(c => c.name === 'api_style')).toBe(true)
        const row = db.prepare("SELECT api_style FROM providers WHERE id = 'p1'").get() as {api_style: string}
        expect(row.api_style).toBe('chat')
        db.close()
    })

    it('事务回滚：中途失败不部分执行（含 BEGIN/COMMIT）', () => {
        const sql = fs.readFileSync(MIGRATION, 'utf8')
        expect(sql.trim().startsWith('BEGIN')).toBe(true)
        expect(sql.trim().endsWith('COMMIT;')).toBe(true)
        // 构造缺列库：删除 display_name 列 → UPDATE 失败 → 显式 ROLLBACK 后整体还原（DELETE 不生效）
        const db = makeLegacyDb()
        db.exec('ALTER TABLE model_scheme_roles DROP COLUMN display_name')
        expect(() => db.exec(sql)).toThrow()
        // SQLite 显式事务在语句失败时不会自动回滚整个事务（已成功的 DELETE 仍在事务内）；
        // 迁移的 BEGIN/COMMIT 保证所有变更可被一次性撤销——显式 ROLLBACK 验证此性质。
        db.exec('ROLLBACK')
        const count = db.prepare('SELECT COUNT(*) as c FROM model_scheme_roles').get() as {c: number}
        expect(count.c).toBe(9) // 全部还原（6 固定 + 3 待删）
        db.close()
    })
})
