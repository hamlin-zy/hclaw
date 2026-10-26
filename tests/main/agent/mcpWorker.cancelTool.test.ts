/**
 * MCP Worker · cancel_tool 取消协议
 *
 * 背景（V2）：会话 Worker → MCP Worker 的 `call_tool` 消息没有取消字段，
 * 取消只能结算 agent 侧外层 Promise，MCP Worker 里的 SDK 请求继续跑完。
 * 修复契约：
 *   - 新增消息 `{type:'cancel_tool', callId}`（`call_tool` 字段不变）；
 *   - handleCallTool 每个请求新建 AbortController，不复用 run 级 signal；
 *   - 收到 cancel_tool → abort 对应 controller + 删表；重复 cancel 幂等。
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'

const state = vi.hoisted(() => ({
    /** mock callTool 收到的 signal（按调用顺序） */
    calls: [] as Array<{signal?: AbortSignal}>,
    /** 模块顶层 parentPort 收到的消息 */
    postMessages: [] as any[],
    /** 模块顶层 parentPort.on('message') 注册的处理器 */
    handlers: [] as Array<(msg: any) => void>,
}))

vi.mock('worker_threads', () => ({
    parentPort: {
        postMessage: (msg: any) => {
            state.postMessages.push(msg)
        },
        on: (_ev: string, cb: (msg: any) => void) => {
            state.handlers.push(cb)
        },
        close: () => {},
    },
    workerData: {servers: []},
    MessagePort: class {},
}))

vi.mock('../../../src/main/agent/mcp/client', () => ({
    MCPClient: class {
        constructor(_opts: unknown) {}
        onStatusChange() {}
        async callTool(_serverId: string, toolName: string, _args: unknown, signal?: AbortSignal) {
            state.calls.push({signal})
            // fast：立即成功，用于验证成功路径也清理端口索引
            if (toolName === 'fast') return {content: [{type: 'text', text: 'ok'}]}
            // 模拟 SDK：abort → reject（真取消）
            return new Promise((_resolve, reject) => {
                signal?.addEventListener('abort', () => reject(new Error('Request aborted')), {once: true})
            })
        }
    },
}))

import {McpWorkerService} from '../../../src/main/agent/mcpWorker'

interface FakeAgentPort {
    posted: any[]
    on: (evt: string, cb: (msg: any) => void) => void
    off: () => void
    start: () => void
    close: () => void
    postMessage: (msg: any) => void
    emit: (msg: any) => void
    emitEvent: (evt: string, arg?: any) => void
}

function makeAgentPort(): FakeAgentPort {
    const handlers = new Map<string, Array<(arg?: any) => void>>()
    const posted: any[] = []
    return {
        posted,
        on: (evt: string, cb: (msg: any) => void) => {
            const list = handlers.get(evt) ?? []
            list.push(cb)
            handlers.set(evt, list)
        },
        off: () => {},
        start: () => {},
        close: () => {},
        postMessage: (msg: any) => {
            posted.push(msg)
        },
        emit: (msg: any) => {
            for (const cb of [...(handlers.get('message') ?? [])]) cb(msg)
        },
        emitEvent: (evt: string, arg?: any) => {
            for (const cb of [...(handlers.get(evt) ?? [])]) cb(arg)
        },
    }
}

const pendingOf = (svc: McpWorkerService) =>
    (svc as unknown as {
        pendingToolCalls: Map<string, {controller: AbortController; port: unknown}>
    }).pendingToolCalls

const pendingByPortOf = (svc: McpWorkerService) =>
    (svc as unknown as {pendingCallsByPort: Map<unknown, Set<string>>}).pendingCallsByPort

/** 排空「abort → reject → catch → postMessage」整条微任务链；不用固定 setTimeout，消除 flaky */
const flushAsync = () => new Promise<void>((resolve) => setImmediate(resolve))

beforeEach(() => {
    state.calls.length = 0
    state.postMessages.length = 0
})

describe('handleCallTool / handleCancelTool', () => {
    it('收到 cancel_tool → abort 对应 controller、表清理、回包一次；重复 cancel 幂等', async () => {
        const service = new McpWorkerService()
        const port = makeAgentPort()
        service.registerAgent(port as never)

        port.emit({type: 'call_tool', callId: 'c1', serverId: 's', toolName: 'slow', args: {}})
        await vi.waitFor(() => expect(state.calls).toHaveLength(1))

        const signal = state.calls[0].signal
        expect(signal).toBeInstanceOf(AbortSignal)
        expect(signal!.aborted).toBe(false)
        expect(pendingOf(service).has('c1')).toBe(true)

        port.emit({type: 'cancel_tool', callId: 'c1'})

        expect(signal!.aborted).toBe(true)
        expect(pendingOf(service).has('c1')).toBe(false)
        // abort → reject → registerAgent 的 catch 回一次 tool_result
        await vi.waitFor(() => {
            expect(port.posted.filter((m) => m.type === 'tool_result' && m.callId === 'c1')).toHaveLength(1)
        })

        // 重复 cancel：不抛、不产生额外回包
        expect(() => port.emit({type: 'cancel_tool', callId: 'c1'})).not.toThrow()
        await flushAsync()
        expect(port.posted.filter((m) => m.type === 'tool_result' && m.callId === 'c1')).toHaveLength(1)

        // 未知 callId 同样安全
        expect(() => port.emit({type: 'cancel_tool', callId: 'missing'})).not.toThrow()
        expect(pendingOf(service).size).toBe(0)
        expect(pendingByPortOf(service).size).toBe(0)
    })

    it('每个 call_tool 新建独立 AbortController：取消一个不影响另一个', async () => {
        const service = new McpWorkerService()
        const port = makeAgentPort()
        service.registerAgent(port as never)

        port.emit({type: 'call_tool', callId: 'a', serverId: 's', toolName: 'slow', args: {}})
        port.emit({type: 'call_tool', callId: 'b', serverId: 's', toolName: 'slow', args: {}})
        await vi.waitFor(() => expect(state.calls).toHaveLength(2))

        expect(state.calls[0].signal).not.toBe(state.calls[1].signal)
        expect(pendingOf(service).size).toBe(2)

        port.emit({type: 'cancel_tool', callId: 'a'})

        expect(state.calls[0].signal!.aborted).toBe(true)
        expect(state.calls[1].signal!.aborted).toBe(false)
        expect(pendingOf(service).size).toBe(1)
        expect(pendingByPortOf(service).size).toBe(1)

        port.emit({type: 'cancel_tool', callId: 'b'})
        expect(pendingOf(service).size).toBe(0)
        expect(pendingByPortOf(service).size).toBe(0)
    })

    it('成功回包后两张表清空，端口索引不残留', async () => {
        const service = new McpWorkerService()
        const port = makeAgentPort()
        service.registerAgent(port as never, 'conv-ok')

        port.emit({type: 'call_tool', callId: 'ok', serverId: 's', toolName: 'fast', args: {}})

        await vi.waitFor(() => {
            expect(port.posted.filter((m) => m.type === 'tool_result' && m.callId === 'ok')).toHaveLength(1)
        })
        expect(pendingOf(service).size).toBe(0)
        expect(pendingByPortOf(service).size).toBe(0)
    })
})

describe('端口级 abort · unregisterAgent / 端口 close', () => {
    it('unregisterAgent → 归属端口的挂起调用被 abort、两张表清空、只回一次包', async () => {
        const service = new McpWorkerService()
        const port = makeAgentPort()
        service.registerAgent(port as never, 'conv-1')

        port.emit({type: 'call_tool', callId: 'c1', serverId: 's', toolName: 'slow', args: {}})
        await vi.waitFor(() => expect(state.calls).toHaveLength(1))
        const signal = state.calls[0].signal
        expect(signal!.aborted).toBe(false)
        expect(pendingOf(service).has('c1')).toBe(true)
        expect(pendingByPortOf(service).get(port)?.has('c1')).toBe(true)

        service.unregisterAgent('conv-1')

        expect(signal!.aborted).toBe(true)
        expect(pendingOf(service).size).toBe(0)
        expect(pendingByPortOf(service).size).toBe(0)
        // abort → reject → registerAgent 的 catch 回一次 tool_result
        await vi.waitFor(() => {
            expect(port.posted.filter((m) => m.type === 'tool_result' && m.callId === 'c1')).toHaveLength(1)
        })

        // 重复注销 + 迟到的 cancel_tool：不产生额外回包
        service.unregisterAgent('conv-1')
        port.emit({type: 'cancel_tool', callId: 'c1'})
        await flushAsync()
        expect(port.posted.filter((m) => m.type === 'tool_result' && m.callId === 'c1')).toHaveLength(1)
    })

    it('端口 emit close → 该端口挂起调用被 abort、两张表清空、只回一次包', async () => {
        const service = new McpWorkerService()
        const port = makeAgentPort()
        service.registerAgent(port as never, 'conv-2')

        port.emit({type: 'call_tool', callId: 'c2', serverId: 's', toolName: 'slow', args: {}})
        await vi.waitFor(() => expect(state.calls).toHaveLength(1))
        const signal = state.calls[0].signal
        expect(signal!.aborted).toBe(false)
        expect(pendingOf(service).has('c2')).toBe(true)
        expect(pendingByPortOf(service).get(port)?.has('c2')).toBe(true)

        port.emitEvent('close')

        expect(signal!.aborted).toBe(true)
        expect(pendingOf(service).size).toBe(0)
        expect(pendingByPortOf(service).size).toBe(0)
        await vi.waitFor(() => {
            expect(port.posted.filter((m) => m.type === 'tool_result' && m.callId === 'c2')).toHaveLength(1)
        })

        // 幂等：重复 close 与迟到 cancel 均不产生额外回包
        port.emitEvent('close')
        port.emit({type: 'cancel_tool', callId: 'c2'})
        await flushAsync()
        expect(port.posted.filter((m) => m.type === 'tool_result' && m.callId === 'c2')).toHaveLength(1)
    })
})
