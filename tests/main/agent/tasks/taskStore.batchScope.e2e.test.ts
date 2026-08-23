/**
 * C-1 批次作用域快照 — 跨批次边界端到端回归测试
 *
 * 场景：同一会话两次 createTask，中间第一批全部进入终态。
 * 修复前缺陷：emitTasksUpdate / toolExecutor 直发路径发送会话全量任务列表，
 *   主进程持久化旁路 upsertSnapshot 按新 batch.id 重写全部任务行的 batch_id
 *   → 第一批次被吞并成空壳、历史明细错挂到第二批次。
 * 修复后契约：
 *   1. TaskStore 层：第二批的事件载荷只含第二批任务（含 supersede 收尾事件）
 *   2. DB 层：两个批次各自持有正确任务归属（batch_id 不串批）
 *
 * 链路模拟：taskStore.sendMessage → buildTasksUpdateEventPayload（worker 序列化桥接，
 * 与 worker.ts 生产代码一致）→ upsertSnapshot（manager.impl.ts 持久化旁路的守卫条件）。
 *
 * ⚠️ 隔离保证：vi.mock 把 getHclawDir() 重定向到 os.tmpdir() 独立临时目录。
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'
import * as fs from 'fs'

// 注意：vi.mock 工厂被提升（hoist），不能引用文件级 const —— 路径必须在工厂内计算
vi.mock('../../../../src/main/config', async () => {
    const os = await import('os')
    const path = await import('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-batchscope-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
    }
})

import {getDatabase, closeDatabase} from '../../../../src/main/repositories/sqlite'
import {
    upsertSnapshot,
    getTasksByBatchId,
    listBatches,
} from '../../../../src/main/repositories/sqlite/taskBatchRepository'
import {taskStore, buildTasksUpdateEventPayload} from '../../../../src/main/agent/tasks/taskStore'
import type {TasksUpdateMsg} from '../../../../src/main/agent/tasks/taskStore'

// 直接执行生产迁移文件（与 taskBatchRepository.test 同构）
const migrationSql = fs.readFileSync(
    new URL('../../../../src/main/repositories/sqlite/migrations/040_task_batches.sql', import.meta.url),
    'utf-8',
)

/** 模拟 worker 序列化桥接 + manager.impl 持久化旁路（生产守卫条件原样复制） */
function persistBypass(msg: TasksUpdateMsg): void {
    const payload = buildTasksUpdateEventPayload(msg)
    if (payload.type === 'tasks_update' && payload.batchId) {
        if (payload.batchName == null || payload.batchStatus == null) return
        const convId = msg.conversationId || 'default'
        upsertSnapshot(
            convId,
            {id: payload.batchId, name: payload.batchName, status: payload.batchStatus},
            payload.tasks,
        )
    }
}

describe('TaskStore × DB — 跨批次边界回归（C-1）', () => {
    // 单例只 init 一次；事件记录 + 持久化旁路复现主进程真实接线
    const events: TasksUpdateMsg[] = []
    taskStore.init((msg) => {
        events.push(msg)
        persistBypass(msg)
    })

    let db: ReturnType<typeof getDatabase>

    beforeEach(() => {
        events.length = 0
        taskStore.reset()
        db = getDatabase()
        db.exec('DROP TABLE IF EXISTS tasks')
        db.exec('DROP TABLE IF EXISTS task_batches')
        db.exec(`CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY,
            workspace_path TEXT NOT NULL DEFAULT '',
            meta TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )`)
        db.exec('PRAGMA foreign_keys = ON')
        db.exec(migrationSql)
    })

    afterEach(() => {
        closeDatabase()
    })

    it('同一会话两批任务（中间第一批全终态）→ DB 两批次各自持有正确任务归属', () => {
        // ── 第一批：两个任务 ──
        const a1 = taskStore.createTask('conv-x', '第一批任务A')
        const a2 = taskStore.createTask('conv-x', '第一批任务B')
        const batch1 = taskStore.getActiveBatch('conv-x')!

        // ── 边界：第一批全部终态 ──
        taskStore.updateTaskStatus('conv-x', a1.id, 'completed')
        taskStore.updateTaskStatus('conv-x', a2.id, 'completed')
        expect(taskStore.getActiveBatch('conv-x')!.status).toBe('completed')

        // ── 第二批：新任务开新批次 ──
        const b1 = taskStore.createTask('conv-x', '第二批任务C')
        const b2 = taskStore.createTask('conv-x', '第二批任务D')
        const batch2 = taskStore.getActiveBatch('conv-x')!
        expect(batch2.id).not.toBe(batch1.id)

        // ── DB 断言：两批次行各自存在、状态正确 ──
        const batchRows = db.prepare('SELECT id, status FROM task_batches ORDER BY created_at').all() as Array<{id: string; status: string}>
        expect(batchRows).toHaveLength(2)
        expect(batchRows.map(r => r.id)).toEqual([batch1.id, batch2.id])
        expect(batchRows[0]!.status).toBe('completed')
        expect(batchRows[1]!.status).toBe('active')

        // ── DB 断言：任务行 batch_id 不串批（修复前第二批 upsert 会把 A/B 重挂到 batch2）──
        const batch1Tasks = getTasksByBatchId(batch1.id)
        expect(batch1Tasks.map(t => t.title)).toEqual(['第一批任务A', '第一批任务B'])
        expect(batch1Tasks.map(t => t.id)).toEqual([a1.id, a2.id])

        const batch2Tasks = getTasksByBatchId(batch2.id)
        expect(batch2Tasks.map(t => t.title)).toEqual(['第二批任务C', '第二批任务D'])
        expect(batch2Tasks.map(t => t.id)).toEqual([b1.id, b2.id])

        // 全库恰好 4 行且归属唯一
        const allRows = db.prepare('SELECT id, batch_id FROM tasks').all() as Array<{id: string; batch_id: string}>
        expect(allRows).toHaveLength(4)
        for (const row of allRows) {
            expect([batch1.id, batch2.id]).toContain(row.batch_id)
        }

        // 历史窗口数据源视角：该会话分组下两个批次计数各自独立
        const groups = listBatches({conversationId: 'conv-x'})
        expect(groups).toHaveLength(1)
        const byId = new Map(groups[0]!.batches.map(b => [b.id, b]))
        expect(byId.get(batch1.id)).toMatchObject({status: 'completed', total: 2, done: 2})
        expect(byId.get(batch2.id)).toMatchObject({status: 'active', total: 2, done: 0})
    })

    it('TaskStore 层：第二批的每次事件载荷只含第二批任务（内存残留不外泄）', () => {
        const a = taskStore.createTask('conv-y', '第一批任务A')
        taskStore.updateTaskStatus('conv-y', a.id, 'completed')

        events.length = 0
        taskStore.createTask('conv-y', '第二批任务B')

        // 开新批事件只含第二批任务
        const last = events[events.length - 1]!
        expect(last.batchId).toBe(taskStore.getActiveBatch('conv-y')!.id)
        expect(last.tasks.map(t => t.title)).toEqual(['第二批任务B'])
        expect(last.tasks.some(t => t.id === a.id)).toBe(false)

        // 第二批任务状态变化的事件同样只含第二批任务
        events.length = 0
        const b = taskStore.getTask('conv-y', last.tasks[0]!.id)!
        taskStore.updateTaskStatus('conv-y', b.id, 'running')
        expect(events[0]!.tasks.map(t => t.id)).toEqual([b.id])
        expect(events[0]!.tasks.some(t => t.id === a.id)).toBe(false)

        // getCurrentBatchTasks（toolExecutor 直发路径数据源）与会话全量的差异
        expect(taskStore.getCurrentBatchTasks('conv-y').map(t => t.id)).toEqual([b.id])
        expect(taskStore.getAllTasks('conv-y')).toHaveLength(2)
    })

    it('supersede 收尾路径：显式 batchName 取代活跃批次时，收尾事件与落库都只含第一批任务', () => {
        const a = taskStore.createTask('conv-z', '旧批任务A')
        const oldBatch = taskStore.getActiveBatch('conv-z')!

        taskStore.createTask('conv-z', '新批任务B', undefined, '用户指定批次')

        // supersede 收尾事件（旧批次 completed）也必须是批次作用域
        const closing = events.find(e => e.batchId === oldBatch.id && e.batchStatus === 'completed')!
        expect(closing).toBeDefined()
        expect(closing.tasks.map(t => t.id)).toEqual([a.id])
        const newBatch = taskStore.getActiveBatch('conv-z')!

        // DB：旧批次保留自己的任务且为 completed（未被吞并成空壳）
        expect(getTasksByBatchId(oldBatch.id).map(t => t.id)).toEqual([a.id])
        const rows = db.prepare('SELECT id, status FROM task_batches').all() as Array<{id: string; status: string}>
        expect(rows.find(r => r.id === oldBatch.id)!.status).toBe('completed')
        expect(getTasksByBatchId(newBatch.id).map(t => t.title)).toEqual(['新批任务B'])
    })
})
