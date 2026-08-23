/**
 * TaskStore → Worker postMessage 桥接序列化回归（Task 3 修复轮 1 · C1）
 *
 * 背景：worker.ts 的 taskStore.init 回调此前硬编码 `event: {type, tasks}`，
 * 丢弃 batchId/batchName/batchStatus——supersede 收尾事件到达主进程
 * handleStreamEvent 时无 batchId，持久化旁路跳过，旧批次在 DB 永久滞留 active。
 *
 * 本测试覆盖桥接完整性：真实 TaskStore 产生的消息（含 supersede 补发的
 * completed 收尾事件）经 buildTasksUpdateEventPayload 序列化后仍携带批次字段。
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {buildTasksUpdateEventPayload, taskStore} from '@/main/agent/tasks/taskStore'
import type {TasksUpdateMsg} from '@/main/agent/tasks/taskStore'
import type {Task} from '@shared/types'

describe('worker 桥接序列化 — supersede 收尾事件批次字段透传', () => {
    const sendMessage = vi.fn()
    taskStore.init(sendMessage)

    beforeEach(() => {
        sendMessage.mockClear()
        taskStore.reset()
    })

    it('取代旧活跃批次后，经序列化的第一条事件仍携带 batchStatus=completed 及批次标识', () => {
        taskStore.createTask('conv-1', '旧任务')
        const oldBatch = taskStore.getActiveBatch('conv-1')!
        expect(oldBatch.status).toBe('active')

        sendMessage.mockClear()
        taskStore.createTask('conv-1', '新任务', undefined, '用户指定批次名')

        // 模拟 worker.ts init 回调的 postMessage 序列化步骤
        const serialized = (sendMessage.mock.calls as Array<[TasksUpdateMsg]>)
            .map(([msg]) => buildTasksUpdateEventPayload(msg))

        expect(serialized.length).toBe(2)
        // 第一条：旧批次 completed 收尾事件——批次字段不得被丢弃
        expect(serialized[0].batchId).toBe(oldBatch.id)
        expect(serialized[0].batchName).toBe(oldBatch.name)
        expect(serialized[0].batchStatus).toBe('completed')
        // 第二条：新批次 active 事件同样完整透传
        expect(serialized[1].batchId).not.toBe(oldBatch.id)
        expect(serialized[1].batchName).toBe('用户指定批次名')
        expect(serialized[1].batchStatus).toBe('active')

        // 主进程持久化旁路的准入条件：event.batchId 存在且 name/status 非空
        for (const ev of serialized) {
            expect(ev.batchId).toBeTruthy()
            expect(ev.batchName).toBeTruthy()
            expect(ev.batchStatus).toBeTruthy()
        }
    })

    it('末任务全部终态后，序列化事件的 batchStatus 为 completed', () => {
        const t = taskStore.createTask('conv-1', '任务A')
        const batch = taskStore.getActiveBatch('conv-1')!

        taskStore.updateTaskStatus('conv-1', t.id, 'completed')

        const msg = sendMessage.mock.calls[sendMessage.mock.calls.length - 1][0] as TasksUpdateMsg
        const ev = buildTasksUpdateEventPayload(msg)
        expect(ev.batchId).toBe(batch.id)
        expect(ev.batchStatus).toBe('completed')
    })

    it('无批次时序列化结果不携带批次字段（向后兼容原载荷）', () => {
        const msg: TasksUpdateMsg = {type: 'tasks_update', conversationId: 'conv-x', tasks: []}
        const ev = buildTasksUpdateEventPayload(msg)
        expect(ev.type).toBe('tasks_update')
        expect(ev.tasks).toEqual([])
        expect('batchId' in ev).toBe(false)
        expect('batchName' in ev).toBe(false)
        expect('batchStatus' in ev).toBe(false)
    })

    it('tasks 数组原样透传（不被序列化改动）', () => {
        const tasks: Task[] = [{id: 't-1', title: 'A', status: 'pending'}]
        const ev = buildTasksUpdateEventPayload({type: 'tasks_update', tasks})
        expect(ev.tasks).toBe(tasks)
    })
})
