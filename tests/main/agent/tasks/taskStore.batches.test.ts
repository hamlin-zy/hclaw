import {beforeEach, describe, expect, it, vi} from 'vitest'
import {taskStore} from '@/main/agent/tasks/taskStore'
import type {Task} from '@shared/types'

/** tasks_update 事件载荷形状 */
interface TasksUpdateMsg {
    type: 'tasks_update'
    conversationId?: string
    tasks: Task[]
    batchId?: string
    batchName?: string
    batchStatus?: 'active' | 'completed'
}

/**
 * TaskStore 批次逻辑用例（Task 2）
 * 规则：
 * - 首次 createTask 开新批次；存在非终态任务时归入当前批次；全部终态后再创建则开新批次
 * - 显式 batchName 强制开新批次并取代旧活跃批次
 * - 末任务转终态 → 批次 completed；completed 批次内任务回 pending → 重开为 active
 * - 清空后批次内无任务 → completed
 */
describe('TaskStore — 任务批次', () => {
    // 单例只 init 一次（与真实 Worker 环境一致），所有测试共享同一个 sendMessage mock
    const sendMessage = vi.fn()
    taskStore.init(sendMessage)

    beforeEach(() => {
        sendMessage.mockClear()
        taskStore.reset()
    })

    /** 取最后一条 tasks_update 事件载荷 */
    const lastMsg = (): TasksUpdateMsg => sendMessage.mock.calls[sendMessage.mock.calls.length - 1]?.[0] as TasksUpdateMsg

    it('首次 createTask 开新批次（active），batchName 为首任务标题截断 50 字符', () => {
        const longTitle = '标'.repeat(60)
        taskStore.createTask('conv-1', longTitle)

        const batch = taskStore.getActiveBatch('conv-1')
        expect(batch).not.toBeNull()
        expect(batch!.status).toBe('active')
        expect(batch!.name).toBe(longTitle.slice(0, 50))
        expect(batch!.name).toHaveLength(50)

        // 事件载荷携带批次字段
        const msg = lastMsg()
        expect(msg.type).toBe('tasks_update')
        expect(msg.batchId).toBe(batch!.id)
        expect(msg.batchName).toBe(batch!.name)
        expect(msg.batchStatus).toBe('active')
    })

    it('存在非终态任务时 createTask 归入当前批次', () => {
        taskStore.createTask('conv-1', '任务A')
        const before = taskStore.getActiveBatch('conv-1')

        taskStore.createTask('conv-1', '任务B')

        const after = taskStore.getActiveBatch('conv-1')
        expect(after!.id).toBe(before!.id)
        expect(after!.status).toBe('active')
    })

    it('全部任务终态后再 createTask → 开新批次', () => {
        const t = taskStore.createTask('conv-1', '任务A')
        const oldBatch = taskStore.getActiveBatch('conv-1')!

        taskStore.updateTaskStatus('conv-1', t.id, 'completed')
        // 全部终态 → 当前批次变 completed
        expect(taskStore.getActiveBatch('conv-1')!.status).toBe('completed')

        taskStore.createTask('conv-1', '任务B')
        const newBatch = taskStore.getActiveBatch('conv-1')!
        expect(newBatch.id).not.toBe(oldBatch.id)
        expect(newBatch.name).toBe('任务B')
        expect(newBatch.status).toBe('active')
    })

    it('取代旧活跃批次时：先补发旧批次 completed 收尾事件，再开新批（两条消息不同 batchId）', () => {
        taskStore.createTask('conv-1', '旧任务')
        const oldBatch = taskStore.getActiveBatch('conv-1')!
        expect(oldBatch.status).toBe('active')

        sendMessage.mockClear()
        taskStore.createTask('conv-1', '新任务', undefined, '用户指定批次名')

        const msgs = sendMessage.mock.calls.map(c => c[0] as TasksUpdateMsg)
        expect(msgs.length).toBe(2)
        // 第一条：旧批次的收尾事件（completed）
        expect(msgs[0].batchId).toBe(oldBatch.id)
        expect(msgs[0].batchName).toBe(oldBatch.name)
        expect(msgs[0].batchStatus).toBe('completed')
        // 第二条：新批次事件（active）
        expect(msgs[1].batchId).not.toBe(oldBatch.id)
        expect(msgs[1].batchStatus).toBe('active')
        expect(msgs[1].batchName).toBe('用户指定批次名')
    })

    it('显式 batchName 开新批次且旧活跃批次被取代（新批次使用显式名称）', () => {
        taskStore.createTask('conv-1', '旧任务')
        const oldBatch = taskStore.getActiveBatch('conv-1')!
        expect(oldBatch.status).toBe('active')

        taskStore.createTask('conv-1', '新任务', undefined, '用户指定批次名')

        const newBatch = taskStore.getActiveBatch('conv-1')!
        expect(newBatch.id).not.toBe(oldBatch.id)
        expect(newBatch.name).toBe('用户指定批次名')
        expect(newBatch.status).toBe('active')
    })

    it('末任务转终态 → 批次变 completed，且对应事件载荷 batchStatus=completed', () => {
        const a = taskStore.createTask('conv-1', '任务A')
        const b = taskStore.createTask('conv-1', '任务B')
        const batch = taskStore.getActiveBatch('conv-1')!

        taskStore.updateTaskStatus('conv-1', a.id, 'completed')
        // 还有非终态任务 → 批次仍 active
        expect(taskStore.getActiveBatch('conv-1')!.status).toBe('active')

        taskStore.updateTaskStatus('conv-1', b.id, 'failed')

        expect(taskStore.getActiveBatch('conv-1')!.status).toBe('completed')
        // 终态事件自带 batchStatus='completed'（批次状态变更先于事件构建）
        const msg = lastMsg()
        expect(msg.tasks.every((t: Task) => ['completed', 'failed'].includes(t.status))).toBe(true)
        expect(msg.batchId).toBe(batch.id)
        expect(msg.batchStatus).toBe('completed')
    })

    it('批次重开：completed 批次内任务 updateTaskStatus 回 pending → 批次回 active', () => {
        const t = taskStore.createTask('conv-1', '任务A')
        const batch = taskStore.getActiveBatch('conv-1')!
        taskStore.updateTaskStatus('conv-1', t.id, 'completed')
        expect(taskStore.getActiveBatch('conv-1')!.status).toBe('completed')

        taskStore.updateTaskStatus('conv-1', t.id, 'pending')

        const reopened = taskStore.getActiveBatch('conv-1')!
        expect(reopened.id).toBe(batch.id)
        expect(reopened.status).toBe('active')
        // 重开事件携带 active
        expect(lastMsg().batchStatus).toBe('active')
    })

    it('clear 场景：clearCompleted 后批次内任务数为 0 → 批次置 completed', () => {
        // 模拟 taskUpdateTool clear=true 的实际路径：逐个调用 deleteTask
        const a = taskStore.createTask('conv-1', '任务A')
        const b = taskStore.createTask('conv-1', '任务B')
        const batch = taskStore.getActiveBatch('conv-1')!

        for (const t of [a, b]) {
            taskStore.updateTaskStatus('conv-1', t.id, 'completed')
            taskStore.deleteTask('conv-1', t.id)
        }

        expect(taskStore.getAllTasks('conv-1')).toHaveLength(0)
        expect(taskStore.getActiveBatch('conv-1')!.id).toBe(batch.id)
        expect(taskStore.getActiveBatch('conv-1')!.status).toBe('completed')
        expect(lastMsg().batchStatus).toBe('completed')
    })

    it('多会话隔离：conv A 的批次不影响 conv B', () => {
        const a = taskStore.createTask('conv-A', '会话A任务')
        taskStore.createTask('conv-B', '会话B任务')
        const batchA = taskStore.getActiveBatch('conv-A')!
        const batchB = taskStore.getActiveBatch('conv-B')!

        expect(batchA.id).not.toBe(batchB.id)

        // A 的全部任务终态只影响 A 的批次
        taskStore.updateTaskStatus('conv-A', a.id, 'completed')
        expect(taskStore.getActiveBatch('conv-A')!.status).toBe('completed')
        expect(taskStore.getActiveBatch('conv-B')!.status).toBe('active')
        expect(taskStore.getActiveBatch('conv-B')!.id).toBe(batchB.id)
    })
})
