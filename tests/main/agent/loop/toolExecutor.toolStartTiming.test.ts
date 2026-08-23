// @vitest-environment node
/**
 * tool_start 即时推送回归测试
 *
 * 保护根因：tool_start 事件必须通过 context.onEvent 在工具执行前即时推送，
 * 否则 controller 在 executeToolCalls 返回后才 yield execEvents，
 * 渲染进程收到 tool_start 时工具已完成（isRunning=false），倒计时永不显示。
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'

// ── 依赖 mock ──
vi.mock('../../../../src/main/agent/tools/executor', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../../src/main/agent/tools/executor')>()
    return {
        ...actual,
        // 保留真实的 resolveToolTimeoutMs，mock 掉 executeTool（避免真实执行）
        executeTool: vi.fn(async () => ({
            toolCallId: 'tc-1',
            toolName: 'bash',
            result: {success: true, output: 'done'},
        })),
    }
})

vi.mock('../../../../src/main/agent/tools/permission', () => ({
    permissionEngine: {
        check: () => ({allowed: true}),
    },
}))

vi.mock('../../../../src/main/agent/state', () => ({
    createToolResultMessage: vi.fn((id: string, name: string, result: any) => ({id, name, result})),
    addMessage: vi.fn((s: any, m: any) => ({...s, messages: [...(s.messages || []), m]})),
}))

import {ToolExecutor} from '../../../../src/main/agent/loop/toolExecutor'

describe('ToolExecutor.execute tool_start 即时推送', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('tool_start 在工具执行前通过 onEvent 即时推送（不等 execEvents 延迟 yield）', async () => {
        const onEvent = vi.fn()
        const executor = new ToolExecutor()
        const context = {
            workingDir: 'E:\\workspace',
            abortSignal: new AbortController().signal,
            sendMessage: vi.fn(),
            onEvent,
        }

        // 记录事件到达顺序：onEvent 应早于 executeTool 完成
        const order: string[] = []
        const {executeTool} = await import('../../../../src/main/agent/tools/executor')
        ;(executeTool as any).mockImplementation(async () => {
            order.push('execute-done')
            return {toolCallId: 'tc-1', toolName: 'bash', result: {success: true, output: 'done'}}
        })
        onEvent.mockImplementation(() => order.push('onEvent-tool_start'))

        const {result, events} = await executor.execute(
            {id: 'tc-1', name: 'bash', arguments: {command: 'sleep 10'}},
            context as any,
        )

        expect(result.result.success).toBe(true)

        // onEvent 必须被调用，且调用时携带 tool_start（执行前即时推送）
        expect(onEvent).toHaveBeenCalled()
        const sent = onEvent.mock.calls[0][0]
        expect(sent.type).toBe('tool_start')
        expect(sent.toolCall.id).toBe('tc-1')
        expect(sent.toolCall.timeoutMs).toBe(30000)

        // 时序：onEvent(tool_start) 必须先于 executeTool 完成（即早于 tool_result 转发）
        expect(order.indexOf('onEvent-tool_start')).toBeLessThan(order.indexOf('execute-done'))

        // events 数组仍保留 tool_start（供主进程累积器落库）
        expect(events.some(e => e.type === 'tool_start')).toBe(true)
    })

    it('tool_start 携带 resolveToolTimeoutMs 解析的超时值（bash 默认 30s）', async () => {
        const onEvent = vi.fn()
        const executor = new ToolExecutor()
        const context = {
            workingDir: 'E:\\workspace',
            abortSignal: new AbortController().signal,
            sendMessage: vi.fn(),
            onEvent,
        }

        await executor.execute(
            {id: 'tc-2', name: 'bash', arguments: {command: 'sleep 10'}},
            context as any,
        )

        const sent = onEvent.mock.calls[0][0]
        expect(sent.type).toBe('tool_start')
        expect(sent.toolCall.timeoutMs).toBe(30000)
    })

    it('agent 工具不注入 timeoutMs（无倒计时展示意义）', async () => {
        const onEvent = vi.fn()
        const executor = new ToolExecutor()
        const context = {
            workingDir: 'E:\\workspace',
            abortSignal: new AbortController().signal,
            sendMessage: vi.fn(),
            onEvent,
        }

        await executor.execute(
            {id: 'tc-3', name: 'agent', arguments: {task: 'explore', agentType: 'explore'}},
            context as any,
        )

        const sent = onEvent.mock.calls[0][0]
        expect(sent.type).toBe('tool_start')
        expect(sent.toolCall.timeoutMs).toBeUndefined()
    })

    it('tool_completed 在工具执行完成后通过 onEvent 即时推送（与 tool_start 对称）', async () => {
        const onEvent = vi.fn()
        const executor = new ToolExecutor()
        const context = {
            workingDir: 'E:\\workspace',
            abortSignal: new AbortController().signal,
            sendMessage: vi.fn(),
            onEvent,
        }

        const order: string[] = []
        const {executeTool} = await import('../../../../src/main/agent/tools/executor')
        ;(executeTool as any).mockImplementation(async () => {
            order.push('execute-done')
            return {toolCallId: 'tc-1', toolName: 'bash', result: {success: true, output: 'done'}}
        })
        onEvent.mockImplementation((e: any) => order.push(`onEvent-${e.type}`))

        await executor.execute(
            {id: 'tc-1', name: 'bash', arguments: {command: 'sleep 10'}},
            context as any,
        )

        // tool_completed 必须通过 onEvent 即时推送（Promise.all 阻塞正式 tool_result 前的旁路）
        const completedCalls = onEvent.mock.calls.filter(c => c[0].type === 'tool_completed')
        expect(completedCalls.length).toBe(1)
        expect(completedCalls[0][0].toolCallId).toBe('tc-1')
        expect(completedCalls[0][0].result.success).toBe(true)

        // 时序：tool_start 先于 executeTool 完成，tool_completed 后于完成
        const startIdx = order.indexOf('onEvent-tool_start')
        const doneIdx = order.indexOf('execute-done')
        const completedIdx = order.indexOf('onEvent-tool_completed')
        expect(startIdx).toBeLessThan(doneIdx)
        expect(doneIdx).toBeLessThan(completedIdx)
    })

    it('tool_completed 只走 onEvent 旁路，不进入 events 数组（正式 tool_result 由 processResult 生成）', async () => {
        const onEvent = vi.fn()
        const executor = new ToolExecutor()
        const context = {
            workingDir: 'E:\\workspace',
            abortSignal: new AbortController().signal,
            sendMessage: vi.fn(),
            onEvent,
        }

        const {events} = await executor.execute(
            {id: 'tc-1', name: 'bash', arguments: {command: 'sleep 10'}},
            context as any,
        )

        expect(events.some(e => e.type === 'tool_completed')).toBe(false)
        expect(events.some(e => e.type === 'tool_start')).toBe(true)
    })
})
