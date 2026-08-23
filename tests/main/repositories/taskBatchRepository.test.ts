/**
 * taskBatchRepository 单元测试（Task 1）
 *
 * 覆盖：
 * 1. upsertSnapshot 幂等：同一快照写两次，tasks 无重复行
 * 2. diff 删除：第二次快照少一个任务，DB 中该任务行消失
 * 3. getActiveBatch 返回 sort_order 排序的任务；无 active 批次返回 null
 * 4. listBatches 按 created_at 倒序、filter 命中批次名与任务标题、conversationId 限定单会话
 * 5. deleteBatches 连带删 tasks、返回删除数；对不存在 id 不报错
 * 6. deleteByConversation 清空该会话全部数据
 *
 * ⚠️ 隔离保证：vi.mock 把 getHclawDir() 重定向到 os.tmpdir() 下的独立临时目录，
 *    绝不触碰真实 ~/.hclaw/data/hclaw.db。
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'
import * as fs from 'fs'

// 注意：vi.mock 工厂被提升（hoist），不能引用文件级 const —— 路径必须在工厂内计算
vi.mock('../../../src/main/config', async () => {
    const os = await import('os')
    const path = await import('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-taskbatch-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
    }
})

import {getDatabase, closeDatabase} from '../../../src/main/repositories/sqlite'
import {
    upsertSnapshot,
    getActiveBatch,
    listBatches,
    deleteBatches,
    deleteByConversation,
} from '../../../src/main/repositories/sqlite/taskBatchRepository'
import type {Task} from '../../../src/shared/types/message'

let db: ReturnType<typeof getDatabase>

// 直接执行生产迁移文件，验证 040_task_batches.sql 本身可运行且 schema 正确
const migrationSql = fs.readFileSync(
    new URL('../../../src/main/repositories/sqlite/migrations/040_task_batches.sql', import.meta.url),
    'utf-8',
)

function makeConv(id: string, title: string, workspaceId = '/ws/a'): void {
    db.prepare(
        `INSERT INTO conversations (id, workspace_path, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(id, workspaceId, JSON.stringify({id, title, workspacePath: workspaceId}), Date.now(), Date.now())
}

function makeTask(id: string, title: string, status: Task['status'] = 'pending', extra?: Partial<Task>): Task {
    return {id, title, status, ...extra}
}

beforeEach(() => {
    // closeDatabase 后模块级句柄已重置，每个用例重新获取
    db = getDatabase()
    // 每个用例独立表结构：DROP 后跑 040 迁移重建，避免跨用例数据残留
    db.exec('DROP TABLE IF EXISTS tasks')
    db.exec('DROP TABLE IF EXISTS task_batches')
    db.exec('DROP TABLE IF EXISTS conversations')
    db.exec(`CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        workspace_path TEXT NOT NULL DEFAULT '',
        meta TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    )`)
    // ★ 生产外键约束：tasks.batch_id → task_batches.id ON DELETE CASCADE，显式开启防回归
    db.exec('PRAGMA foreign_keys = ON')
    db.exec(migrationSql)
})

afterEach(() => {
    closeDatabase()
})

describe('upsertSnapshot — 快照写入', () => {
    it('幂等：同一快照写两次，tasks 无重复行', () => {
        makeConv('conv-1', '会话一')
        const batch = {id: 'b1', name: '批次一', status: 'active' as const}
        const tasks = [makeTask('t1', '任务A'), makeTask('t2', '任务B')]

        upsertSnapshot('conv-1', batch, tasks)
        upsertSnapshot('conv-1', batch, tasks)

        const rows = db.prepare('SELECT id FROM tasks WHERE batch_id = ?').all('b1') as Array<{id: string}>
        expect(rows.map(r => r.id).sort()).toEqual(['t1', 't2'])
        const batches = db.prepare('SELECT id FROM task_batches').all()
        expect(batches).toHaveLength(1)
    })

    it('diff 删除：第二次快照少一个任务，DB 中该任务行消失', () => {
        makeConv('conv-1', '会话一')
        const batch = {id: 'b1', name: '批次一', status: 'active' as const}
        upsertSnapshot('conv-1', batch, [makeTask('t1', 'A'), makeTask('t2', 'B')])
        upsertSnapshot('conv-1', batch, [makeTask('t1', 'A')])

        const rows = db.prepare('SELECT id FROM tasks WHERE batch_id = ?').all('b1') as Array<{id: string}>
        expect(rows.map(r => r.id)).toEqual(['t1'])
    })

    it('subtasks 序列化落库、sort_order 按数组下标写入；空快照清空旧任务', () => {
        makeConv('conv-1', '会话一')
        const batch = {id: 'b1', name: '批次一', status: 'active' as const}
        upsertSnapshot('conv-1', batch, [
            makeTask('t1', '父任务', 'running', {subtasks: [makeTask('s1', '子任务', 'completed')]}),
            makeTask('t2', '无描述'),
        ])

        const rows = db.prepare('SELECT id, sort_order, subtasks, description FROM tasks WHERE batch_id = ? ORDER BY sort_order').all('b1') as Array<{id: string; sort_order: number; subtasks: string | null; description: string | null}>
        expect(rows[0].sort_order).toBe(0)
        expect(JSON.parse(rows[0].subtasks!)).toEqual([makeTask('s1', '子任务', 'completed')])
        expect(rows[1].sort_order).toBe(1)
        expect(rows[1].description).toBeNull()

        // 空快照 → 旧任务全删
        upsertSnapshot('conv-1', batch, [])
        const after = db.prepare('SELECT id FROM tasks WHERE batch_id = ?').all('b1')
        expect(after).toHaveLength(0)
    })
})

describe('getActiveBatch — 活跃批次读取', () => {
    it('返回 sort_order 排序的任务（含 subtasks 解析与 description）', () => {
        makeConv('conv-1', '会话一')
        upsertSnapshot('conv-1', {id: 'b1', name: '批次一', status: 'active'}, [
            makeTask('t1', '第一件事', 'completed', {description: '描述1'}),
            makeTask('t2', '第二件事', 'pending', {subtasks: [makeTask('s1', '子任务')]}),
        ])

        const result = getActiveBatch('conv-1')
        expect(result).not.toBeNull()
        expect(result!.batch.id).toBe('b1')
        expect(result!.batch.status).toBe('active')
        expect(result!.tasks.map(t => t.id)).toEqual(['t1', 't2'])
        expect(result!.tasks[0].description).toBe('描述1')
        expect(result!.tasks[1].subtasks).toEqual([makeTask('s1', '子任务')])
    })

    it('无 active 批次返回 null（仅有 completed 批次时）', () => {
        makeConv('conv-1', '会话一')
        upsertSnapshot('conv-1', {id: 'b1', name: '已完成', status: 'completed'}, [makeTask('t1', 'A')])
        expect(getActiveBatch('conv-1')).toBeNull()
    })
})

describe('listBatches — 历史列表', () => {
    it('按 created_at 倒序返回，分组携带会话标题与 total/done', () => {
        makeConv('conv-1', '会话甲')
        makeConv('conv-2', '会话乙')

        upsertSnapshot('conv-1', {id: 'b-old', name: '旧批次', status: 'completed'},
            [makeTask('t1', 'A', 'completed'), makeTask('t2', 'B', 'success'), makeTask('t3', 'C', 'pending')])
        upsertSnapshot('conv-2', {id: 'b-mid', name: '中间批次', status: 'completed'}, [makeTask('t4', 'D', 'error')])
        upsertSnapshot('conv-1', {id: 'b-new', name: '新批次', status: 'active'}, [makeTask('t5', 'E', 'completed')])

        const groups = listBatches()
        // 分组按组内最新批次的 created_at 倒序：conv-1（含 b-new）在前
        expect(groups.map(g => g.conversationId)).toEqual(['conv-1', 'conv-2'])
        expect(groups[0].conversationTitle).toBe('会话甲')
        // 组内批次同样 created_at 倒序
        expect(groups[0].batches.map(b => b.id)).toEqual(['b-new', 'b-old'])
        const old = groups[0].batches.find(b => b.id === 'b-old')!
        expect(old.total).toBe(3)
        expect(old.done).toBe(2) // completed + success 算终态，pending 不算
    })

    it('filter 命中批次名或任一任务标题', () => {
        makeConv('conv-1', '会话甲')
        upsertSnapshot('conv-1', {id: 'b1', name: '重构登录模块', status: 'active'}, [makeTask('t1', '写单测')])
        upsertSnapshot('conv-1', {id: 'b2', name: '无关批次', status: 'active'}, [makeTask('t2', '部署上线')])

        // 命中批次名
        let groups = listBatches({filter: '登录'})
        expect(groups[0].batches.map(b => b.id)).toEqual(['b1'])
        // 命中任务标题
        groups = listBatches({filter: '部署'})
        expect(groups[0].batches.map(b => b.id)).toEqual(['b2'])
        // 无命中
        groups = listBatches({filter: '不存在的关键词xyz'})
        expect(groups).toHaveLength(0)
    })

    it('conversationId 限定单会话；workspaceId 过滤走 conversations.workspace_path', () => {
        makeConv('conv-1', '会话甲', '/ws/one')
        makeConv('conv-2', '会话乙', '/ws/two')

        upsertSnapshot('conv-1', {id: 'b1', name: '批次一', status: 'active'}, [makeTask('t1', 'A')])
        upsertSnapshot('conv-2', {id: 'b2', name: '批次二', status: 'active'}, [makeTask('t2', 'B')])

        let groups = listBatches({conversationId: 'conv-2'})
        expect(groups).toHaveLength(1)
        expect(groups[0].conversationId).toBe('conv-2')

        groups = listBatches({workspaceId: '/ws/one'})
        expect(groups).toHaveLength(1)
        expect(groups[0].conversationId).toBe('conv-1')

        // 组合过滤
        groups = listBatches({workspaceId: '/ws/one', conversationId: 'conv-2'})
        expect(groups).toHaveLength(0)
    })

    it('会话已删除时 LEFT JOIN 兜底：标题为空字符串但不丢批次', () => {
        upsertSnapshot('conv-gone', {id: 'b1', name: '孤儿批次', status: 'completed'}, [])
        const groups = listBatches()
        expect(groups).toHaveLength(1)
        expect(groups[0].conversationTitle).toBe('')
    })
})

describe('deleteBatches / deleteByConversation — 删除', () => {
    beforeEach(() => {
        makeConv('conv-1', '会话甲')
        makeConv('conv-2', '会话乙')
        upsertSnapshot('conv-1', {id: 'b1', name: '批次一', status: 'completed'}, [makeTask('t1', 'A'), makeTask('t2', 'B')])
        upsertSnapshot('conv-1', {id: 'b2', name: '批次二', status: 'active'}, [makeTask('t3', 'C')])
        upsertSnapshot('conv-2', {id: 'b3', name: '批次三', status: 'active'}, [makeTask('t4', 'D')])
    })

    it('deleteBatches 连带删 tasks 并返回删除数；不存在 id 不报错', () => {
        expect(deleteBatches(['b1'])).toBe(1)
        expect(db.prepare('SELECT id FROM tasks WHERE batch_id = ?').all('b1')).toHaveLength(0)

        // 其余数据不受影响
        expect(db.prepare('SELECT id FROM tasks WHERE batch_id = ?').all('b2')).toHaveLength(1)

        // 不存在 id：返回 0 且不抛错
        expect(deleteBatches(['no-such-id'])).toBe(0)
        expect(deleteBatches([])).toBe(0)
    })

    it('deleteByConversation 清空该会话全部批次与任务，其他会话不受影响', () => {
        deleteByConversation('conv-1')

        expect(db.prepare('SELECT id FROM task_batches WHERE conversation_id = ?').all('conv-1')).toHaveLength(0)
        expect(db.prepare('SELECT id FROM tasks WHERE conversation_id = ?').all('conv-1')).toHaveLength(0)
        // conv-2 完好
        expect(db.prepare('SELECT id FROM task_batches WHERE conversation_id = ?').all('conv-2')).toHaveLength(1)
        expect(db.prepare('SELECT id FROM tasks WHERE batch_id = ?').all('b3')).toHaveLength(1)
    })
})
