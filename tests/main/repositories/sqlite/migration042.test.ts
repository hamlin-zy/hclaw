import {describe, expect, it} from 'vitest'
import fs from 'fs'
import path from 'path'
import {DatabaseSync, type DatabaseSyncInstance} from '@photostructure/sqlite'

const MIGRATION = path.join(__dirname, '../../../../src/main/repositories/sqlite/migrations/042_add_provider_model_pricing.sql')

/** 构造老库：无 pricing 列的 provider_models */
function makeLegacyDb(): DatabaseSyncInstance {
    const db = new DatabaseSync(':memory:')
    db.exec(`
        CREATE TABLE providers (
            id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, type TEXT NOT NULL,
            auth_type TEXT NOT NULL DEFAULT 'api-key', base_url TEXT NOT NULL DEFAULT '',
            credentials TEXT NOT NULL DEFAULT '{}', email TEXT NOT NULL DEFAULT '',
            enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE provider_models (
            id TEXT PRIMARY KEY,
            provider_id TEXT NOT NULL,
            model_name TEXT NOT NULL,
            model_type TEXT NOT NULL DEFAULT 'text',
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (provider_id) REFERENCES providers (id) ON DELETE CASCADE,
            UNIQUE (provider_id, model_name)
        );
        INSERT INTO providers (id, name, type, created_at, updated_at) VALUES ('p1', 'Legacy Provider', 'openai', 1, 1);
        INSERT INTO provider_models (id, provider_id, model_name, created_at, updated_at) VALUES
            ('m1', 'p1', 'old-model', 1, 1);
    `)
    return db
}

describe('migration 042 — provider_models 增加 pricing 列', () => {
    it('列添加成功，存量行 pricing 为空串（= 未配置）', () => {
        const db = makeLegacyDb()
        db.exec(fs.readFileSync(MIGRATION, 'utf8'))
        const row = db.prepare("SELECT pricing FROM provider_models WHERE id = 'm1'").get() as {pricing: string}
        expect(row.pricing).toBe('')
        db.close()
    })

    it('新列可写入/读回 pricing JSON', () => {
        const db = makeLegacyDb()
        db.exec(fs.readFileSync(MIGRATION, 'utf8'))
        const pricing = JSON.stringify({input: 3e-6, output: 15e-6, cacheRead: 0.3e-6})
        db.prepare(
            'UPDATE provider_models SET pricing = ? WHERE id = ?'
        ).run(pricing, 'm1')
        const row = db.prepare("SELECT pricing FROM provider_models WHERE id = 'm1'").get() as {pricing: string}
        expect(JSON.parse(row.pricing)).toEqual({input: 3e-6, output: 15e-6, cacheRead: 0.3e-6})
        db.close()
    })

    it('新列默认值不破坏 INSERT（省略 pricing 列）', () => {
        const db = makeLegacyDb()
        db.exec(fs.readFileSync(MIGRATION, 'utf8'))
        db.prepare(
            'INSERT INTO provider_models (id, provider_id, model_name, created_at, updated_at) VALUES (?,?,?,?,?)'
        ).run('m2', 'p1', 'new-model', 2, 2)
        const row = db.prepare("SELECT pricing FROM provider_models WHERE id = 'm2'").get() as {pricing: string}
        expect(row.pricing).toBe('')
        db.close()
    })
})
