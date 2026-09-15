/**
 * executor 超时取消传播（工具侧 AbortSignal）测试
 *
 * 覆盖此前完全无测试护栏的核心机制：
 * - 工具超时 → executor abort 派生信号，工具据此停止后台工作；
 * - 传给工具的是**派生信号**（桥接父信号），不污染 worker 级父信号；
 * - 父信号（用户中止）能传播到工具收到的信号。
 */
import {afterEach, describe, expect, it, vi} from 'vitest'
import {z} from 'zod'
import {executeTool} from '../../../../src/main/agent/tools/executor'
import {toolRegistry} from '../../../../src/main/agent/tools/registry'
import type {Tool, ToolContext, ToolResult} from '../../../../src/main/agent/tools/types'

function makeContext(abortSignal: AbortSignal): ToolContext {
    return {workingDir: '', abortSignal, sendMessage: () => {}} as unknown as ToolContext
}

function makeProbe(name: string, execute: Tool['execute']): Tool {
    return {name, description: `probe-${name}`, inputSchema: z.object({}), execute}
}

/** 哨兵信号：与真实父信号不同 → 若工具从未被调用，断言 `not.toBe(sentinel)` 会失败 */
const sentinel = new AbortController().signal

afterEach(() => {
    vi.useRealTimers()
})

describe('executor 超时取消传播', () => {
    it('超时：abort 传给工具的派生信号，且不污染父信号', async () => {
        vi.useFakeTimers()
        const parent = new AbortController()
        let captured: AbortSignal = sentinel
        const probe = 'timeout_cancel_probe_tool'
        toolRegistry.register(makeProbe(probe, (_args, ctx) => {
            captured = ctx.abortSignal
            return new Promise<ToolResult<string>>(() => { /* never settles */ })
        }))

        const pending = executeTool({id: 'tc-timeout', name: probe, arguments: {}}, makeContext(parent.signal))
        await vi.advanceTimersByTimeAsync(60001)
        const result = await pending

        expect(result.result.success).toBe(false)
        expect(captured).not.toBe(sentinel)
        expect(captured.aborted).toBe(true)
        expect(captured).not.toBe(parent.signal)
        expect(parent.signal.aborted).toBe(false)
    })

    it('用户中止（父信号已 abort）：工具收到已 abort 的派生信号', async () => {
        const parent = new AbortController()
        parent.abort()
        let captured: AbortSignal = sentinel
        const probe = 'parent_abort_probe_tool'
        toolRegistry.register(makeProbe(probe, (_args, ctx) => {
            captured = ctx.abortSignal
            return Promise.resolve({success: true, output: 'ok'})
        }))

        const result = await executeTool({id: 'tc-abort', name: probe, arguments: {}}, makeContext(parent.signal))

        expect(result.result.success).toBe(true)
        expect(captured).not.toBe(sentinel)
        expect(captured.aborted).toBe(true)
    })
})
