import {describe, expect, it, beforeEach, vi} from 'vitest'
import {DatabaseSync, type DatabaseSyncInstance} from '@photostructure/sqlite'

const dbRef = vi.hoisted(() => ({db: null as DatabaseSyncInstance | null}))

vi.mock('../../../../src/main/repositories/sqlite/index', () => ({
    getDatabase: () => dbRef.db,
    saveDatabase: () => {},
}))

import {projectGroupRepo} from '../../../../src/main/repositories/sqlite/projectGroupRepository'

const SCHEMA = `
    CREATE TABLE project_groups (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_order INTEGER NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE workspaces (
        id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        group_id TEXT, group_order INTEGER
    );
`

function seed(projects: Array<{id: string; path: string; groupId?: string | null; groupOrder?: number | null}>): DatabaseSyncInstance {
    const db = new DatabaseSync(':memory:')
    db.exec(SCHEMA)
    const stmt = db.prepare(
        'INSERT INTO workspaces (id, path, name, created_at, updated_at, group_id, group_order) VALUES (?,?,?,?,?,?,?)',
    )
    for (const p of projects) stmt.run(p.id, p.path, p.path, 1, 1, p.groupId ?? null, p.groupOrder ?? null)
    dbRef.db = db
    return db
}

beforeEach(() => { dbRef.db = null })

describe('projectGroupRepository — 组 CRUD', () => {
    it('create 追加到末尾（sort_order = 现有最大值 + 1），list 返回成员', () => {
        seed([{id: 'w1', path: '/ws/a'}])
        expect(projectGroupRepo.create('pg-1', '组一')).toBe(true)
        expect(projectGroupRepo.create('pg-2', '组二')).toBe(true)
        const groups = projectGroupRepo.list()
        expect(groups.map(g => [g.name, g.sortOrder])).toEqual([['组一', 0], ['组二', 1]])
        expect(groups[0].members).toEqual([])
    })

    it('rename 只改名称；dissolve 把成员置 NULL 并删组（排序重编号连续无空洞）', () => {
        const db = seed([{id: 'w1', path: '/ws/a', groupId: 'pg-1', groupOrder: 0}])
        projectGroupRepo.create('pg-1', '组一')
        projectGroupRepo.create('pg-2', '组二')
        expect(projectGroupRepo.rename('pg-1', '改名')).toBe(true)
        expect(projectGroupRepo.dissolve('pg-1')).toBe(true)
        expect(projectGroupRepo.list().map(g => [g.name, g.sortOrder])).toEqual([['组二', 0]])
        expect((db.prepare("SELECT group_id FROM workspaces WHERE id='w1'").get() as {group_id: string | null}).group_id).toBeNull()
    })

    it('同名组允许（名称不唯一）', () => {
        seed([])
        expect(projectGroupRepo.create('pg-1', '同名')).toBe(true)
        expect(projectGroupRepo.create('pg-2', '同名')).toBe(true)
        expect(projectGroupRepo.list()).toHaveLength(2)
    })
})

describe('projectGroupRepository — 归属与排序', () => {
    it('assign 加入组：group_order 追加到目标组末尾', () => {
        const db = seed([{id: 'w1', path: '/ws/a'}, {id: 'w2', path: '/ws/b'}, {id: 'w3', path: '/ws/c'}])
        projectGroupRepo.create('pg-1', '组一')
        expect(projectGroupRepo.assign('/ws/a', 'pg-1')).toBe(true)
        expect(projectGroupRepo.assign('/ws/b', 'pg-1')).toBe(true)
        const members = projectGroupRepo.list()[0].members
        expect(members).toEqual([{projectPath: '/ws/a', groupOrder: 0}, {projectPath: '/ws/b', groupOrder: 1}])
        expect((db.prepare("SELECT group_id FROM workspaces WHERE path='/ws/c'").get() as {group_id: string | null}).group_id).toBeNull()
    })

    it('assign 到当前组幂等：不改 group_order', () => {
        seed([{id: 'w1', path: '/ws/a', groupId: 'pg-1', groupOrder: 0}])
        projectGroupRepo.create('pg-1', '组一')
        expect(projectGroupRepo.assign('/ws/a', 'pg-1')).toBe(true)
        expect(projectGroupRepo.list()[0].members).toEqual([{projectPath: '/ws/a', groupOrder: 0}])
    })

    it('assign(null) = 移出组', () => {
        const db = seed([{id: 'w1', path: '/ws/a', groupId: 'pg-1', groupOrder: 0}])
        projectGroupRepo.create('pg-1', '组一')
        expect(projectGroupRepo.assign('/ws/a', null)).toBe(true)
        const row = db.prepare("SELECT group_id, group_order FROM workspaces WHERE path='/ws/a'").get() as {group_id: string | null; group_order: number | null}
        expect(row).toEqual({group_id: null, group_order: null})
    })

    it('reorderProjects 全量重编号；入参与库内不一致时整批回滚', () => {
        seed([
            {id: 'w1', path: '/ws/a', groupId: 'pg-1', groupOrder: 0},
            {id: 'w2', path: '/ws/b', groupId: 'pg-1', groupOrder: 1},
        ])
        projectGroupRepo.create('pg-1', '组一')
        expect(projectGroupRepo.reorderProjects('pg-1', ['/ws/b', '/ws/a'])).toBe(true)
        expect(projectGroupRepo.list()[0].members).toEqual([{projectPath: '/ws/b', groupOrder: 0}, {projectPath: '/ws/a', groupOrder: 1}])
        // 不一致：/ws/zzz 不在该组内
        expect(projectGroupRepo.reorderProjects('pg-1', ['/ws/b', '/ws/zzz'])).toBe(false)
        expect(projectGroupRepo.list()[0].members).toEqual([{projectPath: '/ws/b', groupOrder: 0}, {projectPath: '/ws/a', groupOrder: 1}])
    })

    it('reorderGroups 全量重编号；id 集合与库内不一致时整批回滚', () => {
        seed([])
        projectGroupRepo.create('pg-1', '组一')
        projectGroupRepo.create('pg-2', '组二')
        expect(projectGroupRepo.reorderGroups(['pg-2', 'pg-1'])).toBe(true)
        expect(projectGroupRepo.list().map(g => [g.name, g.sortOrder])).toEqual([['组二', 0], ['组一', 1]])
        expect(projectGroupRepo.reorderGroups(['pg-2'])).toBe(false)
        expect(projectGroupRepo.list().map(g => [g.name, g.sortOrder])).toEqual([['组二', 0], ['组一', 1]])
    })
})

describe('projectGroupRepository — 级联删除', () => {
    it('remove 删组 + 逐项目复用现有删除链路（仓储层只删归属/组记录）', () => {
        seed([{id: 'w1', path: '/ws/a', groupId: 'pg-1', groupOrder: 0}])
        projectGroupRepo.create('pg-1', '组一')
        expect(projectGroupRepo.remove('pg-1')).toBe(true)
        expect(projectGroupRepo.list()).toEqual([])
    })
})
