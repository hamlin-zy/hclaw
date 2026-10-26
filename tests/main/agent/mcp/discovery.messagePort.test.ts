/**
 * discovery · MessagePort 挂起调用的终结与真取消
 *
 * 背景（V1）：`pendingMcpCalls` 是模块级表，调用方 finally 只在 promise 已 settle 时执行。
 * 端口关闭（MCP Worker 崩溃/被回收）时 Promise 永不 settle → 表条目 + 闭包长期驻留。
 * 修复契约：
 *   - `settleAllPendingMcpCalls(reason)` 单一入口，遍历、删除并以结构化错误 ToolResult resolve；
 *   - port 'close' 与 worker.ts 的 mcp_worker_unavailable 分支都调用它（幂等）；
 *   - worker 分支被 abort 后发出 `{type:'cancel_tool', callId}`（真取消）。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

const state = vi.hoisted(() => ({
    /** worker 线程内 parentPort 是否存在（undefined = 主进程） */
    parentPort: undefined as unknown,
    /** 主进程分支 mcpClient.callTool 的入参记录 */
    mainCalls: [] as Array<{
        serverId: string
        toolName: string
        args: Record<string, unknown>
        signal?: AbortSignal
    }>,
}))

vi.mock('worker_threads', () => ({
    get parentPort() {
        return state.parentPort
    },
    MessagePort: class {},
}))

vi.mock('../../../../src/main/agent/mcp/client', () => ({
    mcpClient: {
        getServer: () => ({config: {}}),
        isToolAutoApproved: () => false,
        isToolDenied: () => false,
        callTool: async (
            serverId: string,
            toolName: string,
            args: Record<string, unknown>,
            signal?: AbortSignal,
        ) => {
            state.mainCalls.push({serverId, toolName, args, signal})
            return {content: []}
        },
    },
}))

import {
    MCP_PORT_REPLACED_REASON,
    registerMCPTools,
    setMcpMessagePort,
    settleAllPendingMcpCalls,
    unregisterMCPTools,
} from '../../../../src/main/agent/mcp/discovery'
import {toolRegistry} from '../../../../src/main/agent/tools/registry'
import type {Tool, ToolContext} from '../../../../src/main/agent/tools/types'
import type {MCPToolDefinition} from '../../../../src/main/agent/mcp/types'

const TOOL: MCPToolDefinition = {
    name: 'slow',
    description: '慢工具',
    inputSchema: {type: 'object', properties: {}},
}

const CTX: ToolContext = {
    abortSignal: new AbortController().signal,
    workingDir: '',
    sendMessage: () => {},
}

/** 记录 handler / 发出的消息，可手动 emit（模拟 MessagePort 事件） */
class FakePort {
    handlers = new Map<string, Array<(arg?: any) => void>>()
    posted: any[] = []

    on = (evt: string, cb: (arg?: any) => void): void => {
        const list = this.handlers.get(evt) ?? []
        list.push(cb)
        this.handlers.set(evt, list)
    }

    off = (evt: string, cb: (arg?: any) => void): void => {
        const list = this.handlers.get(evt)
        if (!list) return
        this.handlers.set(evt, list.filter((h) => h !== cb))
    }

    postMessage = (msg: any): void => {
        this.posted.push(msg)
    }

    emit(evt: string, arg?: any): void {
        for (const cb of [...(this.handlers.get(evt) ?? [])]) cb(arg)
    }
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
    state.parentPort = {}
    state.mainCalls.length = 0
    setMcpMessagePort(null)
})

afterEach(() => {
    unregisterMCPTools('s')
    setMcpMessagePort(null)
})

function registerAndGetProxy(): Tool {
    const n = registerMCPTools('s', [TOOL], undefined, 'A')
    expect(n).toBe(1)
    const proxy = toolRegistry.getAll().find((t) => t.description.includes('[MCP:s]'))
    if (!proxy) throw new Error('proxy 未注册')
    return proxy
}

describe('pendingMcpCalls · 端口关闭清算', () => {
    it('port close → 挂起调用以结构化错误结算，pending 表清空（清理幂等）', async () => {
        const port = new FakePort()
        setMcpMessagePort(port as never)
        const proxy = registerAndGetProxy()

        const pending = proxy.execute({}, CTX)
        let settled = false
        pending.then(() => {
            settled = true
        })
        await tick()
        expect(port.posted.some((m) => m.type === 'call_tool')).toBe(true)
        expect(settled).toBe(false)

        port.emit('close')

        const result = await pending
        expect(result.success).toBe(false)
        expect(result.error).toContain('已关闭')
        // 表已清空：再次清算返回 0（幂等）
        expect(settleAllPendingMcpCalls('again')).toBe(0)
    })

    it('settleAllPendingMcpCalls 一次清算多个挂起调用，并返回清算数量', async () => {
        const port = new FakePort()
        setMcpMessagePort(port as never)
        const proxy = registerAndGetProxy()

        const p1 = proxy.execute({}, CTX)
        const p2 = proxy.execute({}, CTX)
        await tick()
        expect(port.posted.filter((m) => m.type === 'call_tool')).toHaveLength(2)

        expect(settleAllPendingMcpCalls('MCP Worker 不可用')).toBe(2)
        expect(settleAllPendingMcpCalls('MCP Worker 不可用')).toBe(0)

        const [r1, r2] = await Promise.all([p1, p2])
        expect(r1.success).toBe(false)
        expect(r2.success).toBe(false)
        expect(r1.error).toContain('不可用')
    })
})

describe('setMcpMessagePort · 端口替换', () => {
    it('替换为不同 port → 旧端口挂起调用先结算；同一 port 重复设置保持幂等', async () => {
        const p1 = new FakePort()
        setMcpMessagePort(p1 as never)
        const proxy = registerAndGetProxy()

        const pending = proxy.execute({}, CTX)
        await tick()
        expect(p1.posted.some((m) => m.type === 'call_tool')).toBe(true)

        const p2 = new FakePort()
        setMcpMessagePort(p2 as never)

        const result = await pending
        expect(result.success).toBe(false)
        expect(result.error).toBe(MCP_PORT_REPLACED_REASON)

        // 同一 port 重复设置：不结算任何调用（幂等）
        setMcpMessagePort(p2 as never)
        expect(settleAllPendingMcpCalls('sentinel')).toBe(0)
    })
})

describe('worker 分支 · abort 后的真取消', () => {
    it('abort → 发出 cancel_tool（与 call_tool 同 callId），随后不再挂起', async () => {
        const port = new FakePort()
        setMcpMessagePort(port as never)
        const proxy = registerAndGetProxy()

        const ac = new AbortController()
        const pending = proxy.execute({}, {...CTX, abortSignal: ac.signal})
        await tick()

        const callMsg = port.posted.find((m) => m.type === 'call_tool')
        expect(callMsg).toBeTruthy()

        ac.abort()
        const result = await pending

        expect(result.success).toBe(false)
        const cancelMsg = port.posted.find((m) => m.type === 'cancel_tool')
        expect(cancelMsg).toMatchObject({type: 'cancel_tool', callId: callMsg.callId})
        // 调用方 finally 已摘除登记项
        expect(settleAllPendingMcpCalls('bye')).toBe(0)
    })

    it('正常回包不发 cancel_tool（避免对已完成调用误发取消）', async () => {
        const port = new FakePort()
        setMcpMessagePort(port as never)
        const proxy = registerAndGetProxy()

        const pending = proxy.execute({}, CTX)
        await tick()
        const callMsg = port.posted.find((m) => m.type === 'call_tool')

        port.emit('message', {callId: callMsg.callId, result: {success: true, output: 'ok'}})
        const result = await pending

        expect(result).toMatchObject({success: true, output: 'ok'})
        expect(port.posted.some((m) => m.type === 'cancel_tool')).toBe(false)
    })
})

describe('主进程分支 · signal 透传', () => {
    it('无 MessagePort 时直接调主进程 mcpClient.callTool，并把 AbortSignal 作为第 4 参传入', async () => {
        // 主进程分支判定发生在 proxy 创建时（isWorker = !!parentPort）
        state.parentPort = undefined

        const proxy = registerAndGetProxy()
        const ac = new AbortController()
        const result = await proxy.execute({q: 1}, {...CTX, abortSignal: ac.signal})

        expect(state.mainCalls).toHaveLength(1)
        expect(state.mainCalls[0]).toMatchObject({serverId: 's', toolName: 'slow', args: {q: 1}})
        // 关键：不是 undefined，也不是被替换的 controller.signal，而是调用方原始 signal
        expect(state.mainCalls[0].signal).toBe(ac.signal)
        expect(result.success).toBe(true)
    })
})
