import {describe, expect, it} from 'vitest'
import fs from 'fs'
import path from 'path'
import {DatabaseSync, type DatabaseSyncInstance} from '@photostructure/sqlite'

const MIGRATION = path.join(
    __dirname,
    '../../../../src/main/repositories/sqlite/migrations/047_project_groups.sql',
)

/** 构造老库：迁移 001 形态的 workspaces（无 group_id / group_order），含两条存量项目 */
function makeLegacyDb(): DatabaseSyncInstance {
    const db = new DatabaseSync(':memory:')
    db.exec(`
        CREATE TABLE workspaces (
            id TEXT PRIMARY KEY,
            path TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        INSERT INTO workspaces (id, path, name, created_at, updated_at) VALUES
            ('w1', '/ws/a', 'a', 1, 1),
            ('w2', '/ws/b', 'b', 1, 1);
    `)
    return db
}

function apply(db: DatabaseSyncInstance): void {
    db.exec(fs.readFileSync(MIGRATION, 'utf8'))
}

describe('migration 047 — project_groups + workspaces 归属列', () => {
    it('既有库升级：存量项目 group_id / group_order 均为 NULL（零数据迁移）', () => {
        const db = makeLegacyDb()
        apply(db)
        const rows = db.prepare('SELECT id, group_id, group_order FROM workspaces ORDER BY id').all() as Array<{
            id: string; group_id: string | null; group_order: number | null
        }>
        expect(rows).toEqual([
            {id: 'w1', group_id: null, group_order: null},
            {id: 'w2', group_id: null, group_order: null},
        ])
        db.close()
    })

    it('新库初始化：project_groups 表存在且可写读回', () => {
        const db = makeLegacyDb()
        apply(db)
        db.prepare(
            'INSERT INTO project_groups (id, name, sort_order, created_at, updated_at) VALUES (?,?,?,?,?)',
        ).run('pg-1', '一起做的', 0, 10, 10)
        const row = db
            .prepare('SELECT name, sort_order FROM project_groups WHERE id = ?')
            .get('pg-1') as {name: string; sort_order: number}
        expect(row).toEqual({name: '一起做的', sort_order: 0})
        db.close()
    })

    it('workspaces.path 的 UNIQUE 约束不受新列影响', () => {
        const db = makeLegacyDb()
        apply(db)
        expect(() =>
            db.prepare('INSERT INTO workspaces (id, path, name, created_at, updated_at) VALUES (?,?,?,?,?)')
                .run('w3', '/ws/a', 'dup', 1, 1),
        ).toThrow()
        db.close()
    })

    it('idx_workspaces_group 索引存在', () => {
        const db = makeLegacyDb()
        apply(db)
        const idx = db
            .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_workspaces_group'")
            .get() as {name: string} | undefined
        expect(idx?.name).toBe('idx_workspaces_group')
        db.close()
    })

    it('重复执行抛错属预期（幂等由迁移 runner 的 migrations 表保证，不靠 SQL 自身）', () => {
        const db = makeLegacyDb()
        apply(db)
        expect(() => apply(db)).toThrow()
        db.close()
    })
})
