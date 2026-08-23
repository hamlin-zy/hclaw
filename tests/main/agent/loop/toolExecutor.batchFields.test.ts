// @vitest-environment node
/**
 * toolExecutor 直发 tasks_update 批次字段补齐回归测试（Task 3 Step 5）
 *
 * 保护根因：task_update 等工具结果直发的 tasks_update 事件原先不含批次字段，
 * 导致批次状态变化（如重开、supersede）不反映到渲染端 currentBatch。
 * 现改为从 TaskStore.getActiveBatch(conversationId) 统一取值。
 */
import {describe, it, expect, beforeEach, vi} from 'vitest'

vi.mock('@/main/agent/state', () => ({
    createToolResultMessage: vi.fn((id: string, name: string, result: unknown) => ({id, name, result})),
    addMessage: vi.fn((s: unknown, _m: unknown) => s),
}))

import {ToolExecutor} from '@/main/agent/loop/toolExecutor'
import {taskStore} from '@/main/agent/tasks/taskStore'
import type {ExecuteToolCall, ExecuteToolResult} from '@/main/agent/tools/executor'
import type {LoopState} from '@/main/agent/state'

const executor = new ToolExecutor()

const toolCall: ExecuteToolCall = {id: 'tc-1', name: 'task_update', arguments: {}}

function makeExecResult(tasks: Array<{id: string; title: string; status: string}>): ExecuteToolResult {
    return {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        result: {success: true, output: {}, tasks},
    } as unknown as ExecuteToolResult
}

const emptyState = {messages: []} as unknown as LoopState

describe('ToolExecutor.processResult — tasks_update 批次字段', () => {
    beforeEach(() => {
        taskStore.reset()
    })

    it('存在活跃批次时，直发 tasks_update 携带 batchId/batchName/batchStatus', () => {
        taskStore.createTask('conv-x', '任务A')
        const batch = taskStore.getActiveBatch('conv-x')!

        const {events} = executor.processResult(
            makeExecResult([{id: 't-1', title: '任务A', status: 'completed'}]),
            toolCall,
            emptyState,
            'conv-x',
        )

        const updates = events.filter(e => e.type === 'tasks_update') as Array<{
            batchId?: string
            batchName?: string
            batchStatus?: string
        }>
        expect(updates).toHaveLength(1)
        expect(updates[0].batchId).toBe(batch.id)
        expect(updates[0].batchName).toBe(batch.name)
        expect(updates[0].batchStatus).toBe('active')
    })

    it('无活跃批次时不附带批次字段', () => {
        const {events} = executor.processResult(
            makeExecResult([{id: 't-1', title: '任务A', status: 'pending'}]),
            toolCall,
            emptyState,
            'conv-empty',
        )

        const update = events.find(e => e.type === 'tasks_update') as Record<string, unknown>
        expect(update).toBeDefined()
        expect('batchId' in update).toBe(false)
        expect('batchName' in update).toBe(false)
        expect('batchStatus' in update).toBe(false)
    })

    it('conversationId 未传时退化为 default 会话批次（向后兼容）', () => {
        taskStore.createTask(undefined, '默认会话任务')
        const batch = taskStore.getActiveBatch(undefined)!

        const {events} = executor.processResult(
            makeExecResult([{id: 't-1', title: '默认会话任务', status: 'pending'}]),
            toolCall,
            emptyState,
        )

        const update = events.find(e => e.type === 'tasks_update') as {batchId?: string}
        expect(update.batchId).toBe(batch.id)
    })
})
