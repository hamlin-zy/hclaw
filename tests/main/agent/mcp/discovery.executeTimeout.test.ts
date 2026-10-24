/**
 * discovery proxy.execute 内层超时（「MCP 默认不限时」第 2 层）
 *
 * proxy.execute 的 `withToolTimeout(..., timeoutMs)` 是 worker 与主进程两条调用路径
 * 的共同收口：`timeoutMs = serverConfig?.timeout ?? MCP_TOOL_TIMEOUT_NO_LIMIT_MS`。
 * 此前缺省 60_000 —— 即使 SDK 层改成不限时，这一层仍会在 60s 杀掉合法长调用。
 *
 * 本文件不 mock SDK/协议，只 spy `withToolTimeout` 观察它实际收到的 timeoutMs
 * （真实等待 24.8 天来验证「不超时」不可行，参数即契约）。
 *
 * 变异验证记录（本批）
 * M1 变异：proxy.execute 的缺省改回 `?? 60_000` → ✅实测红
 *    （断言 2147483647，收到 60000）
 * M2 变异：删除 `serverConfig = !isWorker ? mainProcessMcpClient.getServer(...) : null`
 *    的 getServer 读取（改为 `null` 常量）→ ✅实测红（显式 5000 用例收到哨兵值）
 * 两处均已还原。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {MCP_TOOL_TIMEOUT_NO_LIMIT_MS} from '@/shared/types/mcp'

const state = vi.hoisted(() => ({
    /** worker 线程内 parentPort 是否存在（undefined = 主进程） */
    parentPort: undefined as unknown,
    /** mainProcessMcpClient.getServer 返回值（主进程路径的服务器配置） */
    server: undefined as {config: {timeout?: number; userDescription?: string}} | undefined,
}))

/** withToolTimeout 实际收到的 (toolName, timeoutMs)，按调用顺序 */
const timeoutCalls = vi.hoisted(() => [] as Array<{toolName: string; timeoutMs: number}>)

vi.mock('worker_threads', () => ({
    get parentPort() {
        return state.parentPort
    },
    MessagePort: class {},
}))

vi.mock('../../../../src/main/agent/mcp/client', () => ({
    mcpClient: {
        getServer: () => state.server,
        isToolAutoApproved: () => false,
        isToolDenied: () => false,
        callTool: async () => ({content: [{type: 'text', text: 'done'}]}),
    },
}))

// 保留真实实现（保证执行语义不变），只在外面记录 timeoutMs 参数
vi.mock('../../../../src/main/agent/tools/toolTimeout', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../../src/main/agent/tools/toolTimeout')>()
    return {
        ...actual,
        withToolTimeout: async (
            promise: Parameters<typeof actual.withToolTimeout>[0],
            toolName: string,
            timeoutMs: number,
            onTimeout?: () => void,
        ) => {
            timeoutCalls.push({toolName, timeoutMs})
            return actual.withToolTimeout(promise, toolName, timeoutMs, onTimeout)
        },
    }
})

import {registerMCPTools, setMcpMessagePort, unregisterMCPTools} from '../../../../src/main/agent/mcp/discovery'
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

beforeEach(() => {
    state.parentPort = undefined
    state.server = undefined
    timeoutCalls.length = 0
    setMcpMessagePort(null)
})

afterEach(() => {
    unregisterMCPTools('s')
    setMcpMessagePort(null)
})

/** 注册唯一工具并返回其 proxy（注册名由 allocateMcpToolNames 决定，这里直接查 registry） */
function registerAndGetProxy(): Tool {
    const n = registerMCPTools('s', [TOOL], undefined, 'A')
    expect(n).toBe(1)
    const proxy = toolRegistry.getAll().find((t) => t.description.includes('[MCP:s]'))
    if (!proxy) throw new Error('proxy 未注册')
    return proxy
}

describe('proxy.execute 内层超时 · 主进程路径', () => {
    it('server 未配置 timeout → 传入不限时哨兵（不再 60s）', async () => {
        // getServer 返回了 server，但 config 里没有 timeout（历史配置/未走 parse 缺省）
        state.server = {config: {}}
        const proxy = registerAndGetProxy()

        const result = await proxy.execute({}, CTX)

        expect(result.success).toBe(true)
        expect(timeoutCalls).toHaveLength(1)
        expect(timeoutCalls[0].timeoutMs).toBe(MCP_TOOL_TIMEOUT_NO_LIMIT_MS)
    })

    it('server 不存在（getServer → undefined）→ 同样回落到不限时哨兵', async () => {
        state.server = undefined
        const proxy = registerAndGetProxy()

        await proxy.execute({}, CTX)

        expect(timeoutCalls[0].timeoutMs).toBe(MCP_TOOL_TIMEOUT_NO_LIMIT_MS)
    })

    it('server 显式配置 timeout → 原样使用（用户收紧超时的能力不被吞掉）', async () => {
        state.server = {config: {timeout: 5000}}
        const proxy = registerAndGetProxy()

        await proxy.execute({}, CTX)

        expect(timeoutCalls[0].timeoutMs).toBe(5000)
    })
})

describe('proxy.execute 内层超时 · worker 路径（无 config 视图）', () => {
    it('worker 内 serverConfig 恒为 null → 使用不限时哨兵', async () => {
        state.parentPort = {}
        // 回包最小 MessagePort 替身：postMessage 时同步回填 callId 对应结果
        const handlers: Array<(msg: Record<string, unknown>) => void> = []
        const port = {
            on: (_evt: string, h: (msg: Record<string, unknown>) => void) => {
                handlers.push(h)
            },
            off: () => {},
            postMessage: (msg: Record<string, unknown>) => {
                if (msg.type !== 'call_tool') return
                handlers[0]?.({callId: msg.callId, result: {success: true, output: 'done'}})
            },
        }
        setMcpMessagePort(port as never)
        const proxy = registerAndGetProxy()

        const result = await proxy.execute({}, CTX)

        expect(result.success).toBe(true)
        expect(timeoutCalls[0].timeoutMs).toBe(MCP_TOOL_TIMEOUT_NO_LIMIT_MS)
    })
})
