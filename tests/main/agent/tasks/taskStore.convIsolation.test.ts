import {beforeEach, describe, expect, it, vi} from 'vitest'
import {taskStore} from '@/main/agent/tasks/taskStore'

describe('TaskStore — 按会话隔离待办', () => {
    // 单例只 init 一次（与真实 Worker 环境一致），所有测试共享同一个 sendMessage mock
    const sendMessage = vi.fn()
    taskStore.init(sendMessage)

    beforeEach(() => {
        sendMessage.mockClear()
        taskStore.reset()
    })

    it('主会话与子会话的任务互相隔离', () => {
        // 主会话创建任务
        taskStore.createTask('conv-root', '主会话任务')
        // 子会话创建任务
        taskStore.createTask('conv-child', '子会话任务')

        // 主会话只看到自己的任务
        const rootTasks = taskStore.getAllTasks('conv-root')
        expect(rootTasks).toHaveLength(1)
        expect(rootTasks[0].title).toBe('主会话任务')

        // 子会话只看到自己的任务
        const childTasks = taskStore.getAllTasks('conv-child')
        expect(childTasks).toHaveLength(1)
        expect(childTasks[0].title).toBe('子会话任务')
    })

    it('notifyUpdate 事件携带归属会话 ID', () => {
        taskStore.createTask('conv-child', '子会话任务')

        const calls = sendMessage.mock.calls
        const lastMsg = calls[calls.length - 1]?.[0]
        expect(lastMsg.conversationId).toBe('conv-child')
        expect(lastMsg.tasks).toHaveLength(1)
        expect(lastMsg.tasks[0].title).toBe('子会话任务')
    })

    it('更新状态只影响指定会话的任务', () => {
        const rootTask = taskStore.createTask('conv-root', '主任务')
        taskStore.createTask('conv-child', '子任务')

        taskStore.updateTaskStatus('conv-child', rootTask.id, 'completed')
        // 子会话中不存在主会话的任务 ID → 更新失败
        expect(taskStore.getTask('conv-child', rootTask.id)).toBeUndefined()
        // 主会话任务状态不受影响
        expect(taskStore.getTask('conv-root', rootTask.id)?.status).toBe('pending')
    })

    it('无会话 ID 时归入 default 隔离区（向后兼容）', () => {
        taskStore.createTask(undefined, '无会话任务')
        expect(taskStore.getAllTasks(undefined)).toHaveLength(1)
        // 与有会话 ID 的任务互不影响
        taskStore.createTask('conv-root', '主任务')
        expect(taskStore.getAllTasks(undefined)).toHaveLength(1)
        expect(taskStore.getAllTasks('conv-root')).toHaveLength(1)
    })
})
