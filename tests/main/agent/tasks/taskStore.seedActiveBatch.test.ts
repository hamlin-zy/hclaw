/**
 * TaskStore.seedActiveBatch 回归测试（跨轮任务恢复）
 *
 * 背景：taskStore 为 Worker 进程内存态，Worker 每次 agent 运行全新重建。
 * 若 Worker 启动时未从主进程下发快照恢复，新一轮对话中 task_update
 * 找不到上一轮创建的任务（updated=0 静默失败 → UI 待办列表不更新）。
 * 本测试锁定 seed 恢复语义：恢复后任务可查/可更新、批次可复用、幂等、不发事件。
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {taskStore} from '@/main/agent/tasks/taskStore'

describe('TaskStore — seedActiveBatch 跨轮恢复', () => {
    const sendMessage = vi.fn()
    taskStore.init(sendMessage)

    beforeEach(() => {
        sendMessage.mockClear()
        taskStore.reset()
    })

    const SNAPSHOT = {
        batch: {id: 'batch-seed-1', name: '上一轮批次', status: 'active' as const},
        tasks: [
            {id: 'task-seed-1', title: '任务A', status: 'pending' as const, description: 'desc-a'},
            {id: 'task-seed-2', title: '任务B', status: 'running' as const},
        ],
    }

    it('seed 后任务可查询、可更新（跨轮恢复的核心场景）', () => {
        taskStore.seedActiveBatch('conv-1', SNAPSHOT.batch, SNAPSHOT.tasks)

        // 恢复的任务可见
        expect(taskStore.getAllTasks('conv-1')).toHaveLength(2)
        expect(taskStore.getActiveBatch('conv-1')?.id).toBe('batch-seed-1')

        // 同轮内 task_update 语义：按 ID 更新成功（此前跨轮必定 updated=0）
        const updated = taskStore.updateTaskStatus('conv-1', 'task-seed-1', 'completed')
        expect(updated?.status).toBe('completed')
        expect(taskStore.getTask('conv-1', 'task-seed-1')?.status).toBe('completed')
    })

    it('seed 后 createTask 复用恢复的批次（不新建批次）', () => {
        taskStore.seedActiveBatch('conv-1', SNAPSHOT.batch, SNAPSHOT.tasks)

        const task = taskStore.createTask('conv-1', '任务C')
        const batch = taskStore.getActiveBatch('conv-1')!
        expect(batch.id).toBe('batch-seed-1')
        expect(batch.status).toBe('active')
        expect(taskStore.getAllTasks('conv-1')).toHaveLength(3)
        void task
    })

    it('seed 幂等：已有批次数据时忽略后续 seed', () => {
        taskStore.seedActiveBatch('conv-1', SNAPSHOT.batch, SNAPSHOT.tasks)
        // 模拟同会话再次 seed（不该覆盖）
        taskStore.seedActiveBatch('conv-1', {id: 'batch-other', name: '其他', status: 'active'}, [{id: 'x', title: 'X', status: 'pending'}])

        expect(taskStore.getActiveBatch('conv-1')?.id).toBe('batch-seed-1')
        expect(taskStore.getAllTasks('conv-1')).toHaveLength(2)
    })

    it('seed 不触发事件（渲染端已有水合/实时数据，无事件无 UI 闪烁）', () => {
        const callsBefore = sendMessage.mock.calls.length
        taskStore.seedActiveBatch('conv-1', SNAPSHOT.batch, SNAPSHOT.tasks)
        expect(sendMessage.mock.calls.length).toBe(callsBefore)
    })

    it('seed 完成态批次：任务保留且状态可达（改回非终态时批次重开 active）', () => {
        taskStore.seedActiveBatch('conv-1', {id: 'batch-done', name: '完成批次', status: 'completed'}, [
            {id: 'task-done', title: '已完成', status: 'completed' as const},
        ])

        expect(taskStore.getActiveBatch('conv-1')?.status).toBe('completed')
        // 将已完成任务改回 running → syncBatchStatus 重开批次
        taskStore.updateTaskStatus('conv-1', 'task-done', 'running')
        expect(taskStore.getActiveBatch('conv-1')?.status).toBe('active')
    })
})
