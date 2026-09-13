/**
 * FIX-5: handleListAll 必须返回已过滤 denyList 的工具列表。
 *
 * 背景：agent worker 内的 MCPClient 是 MessagePort（无 denyList 视图）→ 不过滤；
 * 因此 deny 过滤只能在 MCP Worker 源头完成（发现期唯一实现点 = getEffectiveTools）。
 * 若 handleListAll 直接发 s.tools，用户明确 deny 的工具仍会被注册进 registry
 * 并出现在 <available_mcp_tools> 广告给模型。
 *
 * 变异验证记录（批 4 · P6）
 * #19① 变异：删 `mcpWorker.ts` 中 `restartServer` 的 merged 分支（并发第二次重启不再回传
 *      `{success:true, merged:true}`）→ ✅实测红：#19①（实现者实测）
 * #19④ 变异：删 `mcpWorker.ts:449` 的 `...(r.error ? {error: r.error} : {})`（失败 error 不再透传）
 *      → ✅实测红：#19④（AssertionError：restart_complete 缺 error:'boom'）
 *      控制器实测：仅 #19④ 红。
 */
import {describe, it, expect, vi, beforeAll, afterEach} from 'vitest'

const state = vi.hoisted(() => ({
    servers: [] as any[],
    effective: {} as Record<string, any[]>,
    handlers: [] as Array<(msg: any) => void>,
    postMessages: [] as any[],
    restartStartResult: {success: true} as {success: boolean; error?: string},
}))

vi.mock('worker_threads', () => ({
    parentPort: {
        postMessage: (msg: any) => { state.postMessages.push(msg) },
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
        getServer(serverId: string) {
            return state.servers.find((s: any) => s.config.id === serverId)
        }
        isConnected() { return false }
        async stopServer() {}
        async startServer() { return state.restartStartResult }
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

describe('批 4 · #19 mcpWorker.restartServer 三分支（postMessage restart_complete）', () => {
    function restartsFor(serverId: string) {
        return state.postMessages.filter((m) => m.type === 'restart_complete' && m.serverId === serverId)
    }
    const cfgOf = (id: string) => ({id, name: id, transport: 'stdio', enabled: true})

    afterEach(() => { state.restartStartResult = {success: true} })

    it('#19① 并发两次重启同一 server → 第二次发 {success:true, merged:true}', async () => {
        const dispatch = state.handlers[0]
        dispatch({type: 'restart_server', serverId: 's-merge', config: cfgOf('s-merge')})
        dispatch({type: 'restart_server', serverId: 's-merge', config: cfgOf('s-merge')})
        await vi.waitFor(() => {
            expect(restartsFor('s-merge').some((m) => m.merged === true && m.success === true)).toBe(true)
        })
    })

    it('#19② 成功 → restart_complete 不含 error 键', async () => {
        const dispatch = state.handlers[0]
        dispatch({type: 'restart_server', serverId: 's-ok', config: cfgOf('s-ok')})
        await vi.waitFor(() => { expect(restartsFor('s-ok')).toHaveLength(1) })
        const msg = restartsFor('s-ok')[0]
        expect(msg.success).toBe(true)
        expect('error' in msg).toBe(false)
    })

    it('#19③ config 与 getServer().config 均缺失 → {success:false, error:"配置丢失"}', async () => {
        const dispatch = state.handlers[0]
        dispatch({type: 'restart_server', serverId: 's-missing'})
        await vi.waitFor(() => { expect(restartsFor('s-missing')).toHaveLength(1) })
        expect(restartsFor('s-missing')[0]).toMatchObject({success: false, error: '配置丢失'})
    })

    it('#19④ startServer 失败 → restart_complete 透传 {success:false, error:"boom"}', async () => {
        const dispatch = state.handlers[0]
        state.restartStartResult = {success: false, error: 'boom'}
        dispatch({type: 'restart_server', serverId: 's-fail', config: cfgOf('s-fail')})
        await vi.waitFor(() => { expect(restartsFor('s-fail')).toHaveLength(1) })
        expect(restartsFor('s-fail')[0]).toMatchObject({success: false, error: 'boom'})
    })
})
