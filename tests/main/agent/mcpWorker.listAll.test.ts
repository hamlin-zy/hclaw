/**
 * FIX-5: handleListAll 必须返回已过滤 denyList 的工具列表。
 *
 * 背景：agent worker 内的 MCPClient 是 MessagePort，discovery.filterDeniedTools 拿不到
 * denyList（getDeniedToolNames 恒 undefined）→ 不过滤；因此 deny 过滤只能在 MCP Worker
 * 源头完成。若 handleListAll 直接发 s.tools，用户明确 deny 的工具仍会被注册进 registry
 * 并出现在 <available_mcp_tools> 广告给模型。
 */
import {describe, it, expect, vi, beforeAll} from 'vitest'

const state = vi.hoisted(() => ({
    servers: [] as any[],
    effective: {} as Record<string, any[]>,
    handlers: [] as Array<(msg: any) => void>,
}))

vi.mock('worker_threads', () => ({
    parentPort: {
        postMessage: () => {},
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
        getAllServers() {
            return state.servers
        }
        getEffectiveTools(serverId: string) {
            return state.effective[serverId] ?? []
        }
        getServerPid() {
            return null
        }
        cleanupStoppedServers() {
            return 0
        }
        async startServer() {}
    },
}))

beforeAll(async () => {
    // 模块副作用：new McpWorkerService() + parentPort.on('message', dispatch)
    await import('../../../src/main/agent/mcpWorker')
})

describe('handleListAll（FIX-5：源头过滤 denyList）', () => {
    it('返回 getEffectiveTools 的结果，被 deny 的工具不出现在 all_result', () => {
        const dispatch = state.handlers[0]
        expect(dispatch).toBeTypeOf('function')

        const agentPort = {
            postMessage: vi.fn(),
            on: vi.fn(),
            off: vi.fn(),
            start: vi.fn(),
        }
        let portHandler: ((msg: any) => void) | undefined
        agentPort.on.mockImplementation((ev: string, cb: (msg: any) => void) => {
            if (ev === 'message') portHandler = cb
        })
        dispatch({type: 'register_agent', port: agentPort})

        state.servers = [
            {
                config: {id: 'plugin:github', name: 'github'},
                status: 'connected',
                tools: [{name: 'create_issue'}, {name: 'denied_tool'}, {name: 'list_issues'}],
            },
        ]
        // getEffectiveTools 已剔除 denied_tool
        state.effective = {'plugin:github': [{name: 'create_issue'}, {name: 'list_issues'}]}

        // list_all 由 Agent Worker 在自己注册的 MessagePort 上发起
        expect(portHandler).toBeTypeOf('function')
        portHandler!({type: 'list_all'})

        const allResult = agentPort.postMessage.mock.calls
            .map(([m]: any[]) => m)
            .find((m: any) => m.type === 'all_result')
        expect(allResult).toBeTruthy()
        expect(allResult.servers).toHaveLength(1)
        const toolNames = allResult.servers[0].tools.map((t: any) => t.name)
        expect(toolNames).toEqual(['create_issue', 'list_issues'])
        expect(toolNames).not.toContain('denied_tool')
    })
})
