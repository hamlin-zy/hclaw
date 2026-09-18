import {describe, expect, it, beforeEach, vi} from 'vitest'
import {DatabaseSync, type DatabaseSyncInstance} from '@photostructure/sqlite'

const dbRef = vi.hoisted(() => ({db: null as DatabaseSyncInstance | null}))

vi.mock('../../../../src/main/repositories/sqlite/index', () => ({
    getDatabase: () => dbRef.db,
    saveDatabase: () => {},
}))

import {SqliteConversationRepository} from '../../../../src/main/repositories/sqlite/conversationRepository'

/** 最小 schema：只需要 listWithStats 用到的三张表 */
function seed(): DatabaseSyncInstance {
    const db = new DatabaseSync(':memory:')
    db.exec(`
        CREATE TABLE workspaces (
            id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE conversations (
            id TEXT PRIMARY KEY, workspace_path TEXT NOT NULL, meta TEXT NOT NULL,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE messages (
            id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
            content TEXT NOT NULL, timestamp INTEGER NOT NULL
        );
        CREATE TABLE message_blocks (
            id TEXT PRIMARY KEY, message_id TEXT NOT NULL, block_type TEXT NOT NULL
        );
    `)
    db.prepare('INSERT INTO workspaces (id, path, name, created_at, updated_at) VALUES (?,?,?,?,?)')
        .run('w1', '/ws/a', 'a', 1, 1)
    const conv = db.prepare(
        'INSERT INTO conversations (id, workspace_path, meta, created_at, updated_at) VALUES (?,?,?,?,?)',
    )
    conv.run('c-a1', '/ws/a', JSON.stringify({title: 'A1'}), 10, 10)
    conv.run('c-a2', '/ws/a', JSON.stringify({title: 'A2'}), 20, 20)
    conv.run('c-b1', '/ws/b', JSON.stringify({title: 'B1'}), 30, 30)
    conv.run('c-u1', '', JSON.stringify({title: 'U1'}), 40, 40)
    db.prepare('INSERT INTO messages (id, conversation_id, role, content, timestamp) VALUES (?,?,?,?,?)')
        .run('m1', 'c-a1', 'user', 'hi', 10)
    dbRef.db = db
    return db
}

const repo = new SqliteConversationRepository()

beforeEach(() => { seed() })

describe('listWithStats — scope 四种范围', () => {
    it('scope=all 返回全部项目会话', () => {
        const rows = repo.listWithStats({scope: 'all'})
        expect(rows.map(r => r.id).sort()).toEqual(['c-a1', 'c-a2', 'c-b1', 'c-u1'])
    })

    it('scope=project 只返回该项目（行为与旧签名等价）', () => {
        const rows = repo.listWithStats({scope: 'project', workspacePath: '/ws/a'})
        expect(rows.map(r => r.id).sort()).toEqual(['c-a1', 'c-a2'])
        expect(rows.every(r => r.workspacePath === '/ws/a')).toBe(true)
    })

    it('scope=group 返回该项目集下的全部会话', () => {
        const rows = repo.listWithStats({scope: 'group', groupId: 'pg-1', workspacePaths: ['/ws/a', '/ws/b']})
        expect(rows.map(r => r.id).sort()).toEqual(['c-a1', 'c-a2', 'c-b1'])
    })

    it('scope=group 且项目集为空 → 返回空数组（不抛）', () => {
        expect(repo.listWithStats({scope: 'group', groupId: 'pg-empty', workspacePaths: []})).toEqual([])
    })

    it('scope=unassigned 只返回未归属会话（workspace_path 为空）', () => {
        const rows = repo.listWithStats({scope: 'unassigned'})
        expect(rows.map(r => r.id)).toEqual(['c-u1'])
        expect(rows[0].workspacePath).toBe('')
    })

    it('每条结果都带 workspacePath（项目列数据源）', () => {
        const rows = repo.listWithStats({scope: 'all'})
        expect(rows.map(r => r.workspacePath).sort()).toEqual(['', '/ws/a', '/ws/a', '/ws/b'])
    })
})
