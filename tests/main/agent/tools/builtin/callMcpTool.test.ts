/**
 * call_mcp_tool 单测：解析 → 权限 → 委托 三步链路（spec §9.3 权限与调用）。
 *
 * 重点（§6.6 安全底线）：catalog 通道下权限层是唯一防线，denyList / autoApprove
 * 必须按 (serverId, MCP 侧原始工具名) 在**执行期**重查，不得依赖 PermissionEngine
 * 的「非破坏性放行」分支。
 */
import {describe, it, expect, vi, beforeEach, beforeAll, afterAll} from 'vitest'

const perms = vi.hoisted(() => ({
    denied: false,
    autoApproved: false,
    /** 权限查询是否成功（false = 权限服务不可用，须 fail-closed） */
    ok: true,
    mode: 'safe' as 'safe' | 'auto',
    /** permissionRulesManager.getRules() 的返回值（权限面板规则） */
    rules: [] as Array<{tool: string; action: 'allow' | 'deny' | 'ask'}>,
    /** getMcpToolMeta 的返回值（undefined = 未命中） */
    meta: undefined as undefined | {proxyName: string; serverId: string; serverName?: string; rawToolName: string; rawInputSchema: unknown},
    calls: {meta: [] as string[], permission: [] as string[]},
}))

const engineMocks = vi.hoisted(() => ({
    addRule: vi.fn(async (_rule: {tool: string; action: string}) => {}),
}))

vi.mock('../../../../../src/main/agent/mcp/discovery', () => ({
    getMcpToolMeta: (name: string) => {
        perms.calls.meta.push(name)
        return perms.meta
    },
    getMcpToolPermission: async (serverId: string, rawToolName: string) => {
        perms.calls.permission.push(`${serverId}/${rawToolName}`)
        return {denied: perms.denied, autoApproved: perms.autoApproved, ok: perms.ok}
    },
}))

vi.mock('../../../../../src/main/agent/permissions/permissionRule', () => ({
    permissionRulesManager: {
        getContext: async () => ({mode: perms.mode}),
        getRules: async () => perms.rules,
    },
}))

// 真 permissionEngine 会触达 DB（ensureInit），这里只替换 permissionEngine（always 落库断言用）；
// matchesToolRulePattern 走真实实现，避免测试复刻一份匹配语义（否则无法发现语义漂移）。
vi.mock('../../../../../src/main/agent/tools/permission', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../../../src/main/agent/tools/permission')>()
    return {
        ...actual,
        permissionEngine: {addRule: engineMocks.addRule, getMode: async () => perms.mode},
    }
})

import {callMcpTool} from '../../../../../src/main/agent/tools/builtin/callMcpTool'
import {toolRegistry} from '../../../../../src/main/agent/tools/registry'
import type {ToolContext} from '../../../../../src/main/agent/tools/types'

const PROXY_NAME = 'm_github_create_issue'

function context(requestConfirmation?: (msg: string) => Promise<'allow' | 'always' | 'deny'>): ToolContext {
    return {
        workingDir: 'E:/tmp',
        abortSignal: new AbortController().signal,
        sendMessage: () => {},
        ...(requestConfirmation ? {requestConfirmation} : {}),
    } as ToolContext
}

beforeEach(() => {
    perms.denied = false
    perms.autoApproved = false
    perms.ok = true
    perms.mode = 'safe'
    perms.calls = {meta: [], permission: []}
    perms.rules = []
    engineMocks.addRule.mockClear()
    perms.meta = {
        proxyName: PROXY_NAME,
        serverId: 'plugin:github',
        serverName: 'github',
        rawToolName: 'create_issue',
        rawInputSchema: {type: 'object', properties: {}},
    }
    toolRegistry.register({
        name: PROXY_NAME,
        description: 'proxy',
        inputSchema: undefined as never,
        execute: async () => ({success: true, output: 'OK'}),
    })
})

describe('call_mcp_tool 名称解析', () => {
    it('未命中的 name → 返回可读错误 + 目录提示，不执行', async () => {
        perms.meta = undefined
        const r = await callMcpTool.execute({name: 'm_unknown_tool'}, context())
        expect(r.success).toBe(false)
        expect(r.error).toContain('<available_mcp_tools>')
        expect(r.error).toContain('m_unknown_tool')
    })

    it('命中元数据 → 按 (serverId, 原始工具名) 查权限（不是 proxy 名）', async () => {
        perms.autoApproved = true
        await callMcpTool.execute({name: PROXY_NAME}, context())
        expect(perms.calls.permission).toEqual(['plugin:github/create_issue'])
    })

    it('registry 中 proxy 已缺失（server 断开）→ 返回错误，提示重新查看目录', async () => {
        toolRegistry.unregister(PROXY_NAME)
        perms.autoApproved = true
        const r = await callMcpTool.execute({name: PROXY_NAME}, context())
        expect(r.success).toBe(false)
        expect(r.error).toContain('<available_mcp_tools>')
    })
})

describe('call_mcp_tool 权限下沉', () => {
    it('denyList 命中 → 直接拒绝，不执行 proxy', async () => {
        perms.denied = true
        const execute = vi.fn(async (_args: unknown) => ({success: true, output: 'OK'}))
        toolRegistry.register({name: PROXY_NAME, description: 'p', inputSchema: undefined as never, execute})
        const r = await callMcpTool.execute({name: PROXY_NAME}, context())
        expect(r.success).toBe(false)
        expect(r.error).toContain('denyList')
        expect(execute).not.toHaveBeenCalled()
    })

    it('autoApprove 命中 → 不弹确认，直接执行', async () => {
        perms.autoApproved = true
        const confirm = vi.fn(async (_msg: string) => 'allow' as const)
        const r = await callMcpTool.execute({name: PROXY_NAME, args: {repo: 'x'}}, context(confirm))
        expect(confirm).not.toHaveBeenCalled()
        expect(r.success).toBe(true)
    })

    it('未命中 autoApprove + safe 模式 → 弹确认；拒绝则不执行', async () => {
        const execute = vi.fn(async (_args: unknown) => ({success: true, output: 'OK'}))
        toolRegistry.register({name: PROXY_NAME, description: 'p', inputSchema: undefined as never, execute})
        const confirm = vi.fn(async (_msg: string) => 'deny' as const)
        const r = await callMcpTool.execute({name: PROXY_NAME}, context(confirm))
        expect(confirm).toHaveBeenCalledTimes(1)
        expect(confirm.mock.calls[0][0]).toContain('create_issue')
        expect(r.success).toBe(false)
        expect(execute).not.toHaveBeenCalled()
    })

    it('未命中 autoApprove + safe 模式 → 确认通过后执行', async () => {
        const confirm = vi.fn(async (_msg: string) => 'allow' as const)
        const r = await callMcpTool.execute({name: PROXY_NAME}, context(confirm))
        expect(confirm).toHaveBeenCalledTimes(1)
        expect(r.success).toBe(true)
        expect(r.output).toBe('OK')
    })

    it('auto 模式 → 未命中 autoApprove 也不弹确认（与 PermissionEngine auto 分支一致）', async () => {
        perms.mode = 'auto'
        const confirm = vi.fn(async (_msg: string) => 'allow' as const)
        const r = await callMcpTool.execute({name: PROXY_NAME}, context(confirm))
        expect(confirm).not.toHaveBeenCalled()
        expect(r.success).toBe(true)
    })

    it('无确认回调（渠道会话）→ 不阻塞，直接执行（与 native 通道一致）', async () => {
        const r = await callMcpTool.execute({name: PROXY_NAME}, context())
        expect(r.success).toBe(true)
    })
})

describe('call_mcp_tool 显式权限规则（权限面板）', () => {
    it('规则 m_github_create_issue = allow → safe 模式不弹确认、仍执行 proxy', async () => {
        perms.rules = [{tool: PROXY_NAME, action: 'allow'}]
        const execute = vi.fn(async (_args: unknown) => ({success: true, output: 'OK'}))
        toolRegistry.register({name: PROXY_NAME, description: 'p', inputSchema: undefined as never, execute})
        const confirm = vi.fn(async (_msg: string) => 'deny' as const)
        const r = await callMcpTool.execute({name: PROXY_NAME}, context(confirm))
        expect(confirm).not.toHaveBeenCalled()
        expect(execute).toHaveBeenCalledTimes(1)
        expect(r.success).toBe(true)
    })

    it('规则 m_* = allow（glob）→ 对 m_github_create_issue 生效', async () => {
        perms.rules = [{tool: 'm_*', action: 'allow'}]
        const execute = vi.fn(async (_args: unknown) => ({success: true, output: 'OK'}))
        toolRegistry.register({name: PROXY_NAME, description: 'p', inputSchema: undefined as never, execute})
        const confirm = vi.fn(async (_msg: string) => 'deny' as const)
        const r = await callMcpTool.execute({name: PROXY_NAME}, context(confirm))
        expect(confirm).not.toHaveBeenCalled()
        expect(execute).toHaveBeenCalledTimes(1)
        expect(r.success).toBe(true)
    })

    it('规则 call_mcp_tool = allow → 放行（覆盖所有 MCP 调用）', async () => {
        perms.rules = [{tool: 'call_mcp_tool', action: 'allow'}]
        const confirm = vi.fn(async (_msg: string) => 'deny' as const)
        const r = await callMcpTool.execute({name: PROXY_NAME}, context(confirm))
        expect(confirm).not.toHaveBeenCalled()
        expect(r.success).toBe(true)
    })

    it('规则 * = allow → 跳过工具内确认（引擎层 allow 结论）', async () => {
        perms.rules = [{tool: '*', action: 'allow'}]
        const confirm = vi.fn(async (_msg: string) => 'deny' as const)
        const r = await callMcpTool.execute({name: PROXY_NAME}, context(confirm))
        expect(confirm).not.toHaveBeenCalled()
        expect(r.success).toBe(true)
    })

    it('★ 规则 call_mcp_tool = deny/ask → 工具内不拒绝、不弹确认（交引擎层，避免双弹窗/矛盾结论）', async () => {
        for (const action of ['deny', 'ask'] as const) {
            perms.rules = [{tool: 'call_mcp_tool', action}]
            const execute = vi.fn(async (_args: unknown) => ({success: true, output: 'OK'}))
            toolRegistry.register({name: PROXY_NAME, description: 'p', inputSchema: undefined as never, execute})
            const confirm = vi.fn(async (_msg: string) => 'deny' as const)
            const r = await callMcpTool.execute({name: PROXY_NAME}, context(confirm))
            expect(confirm, `action=${action} 不应在工具内再弹确认`).not.toHaveBeenCalled()
            expect(execute, `action=${action} 不应被工具内拒绝`).toHaveBeenCalledTimes(1)
            expect(r.success).toBe(true)
        }
    })

    it('规则 deny（且 autoApprove=true）→ 拒绝、execute 未被调用（规则 deny 压过 autoApprove）', async () => {
        perms.rules = [{tool: PROXY_NAME, action: 'deny'}]
        perms.autoApproved = true
        const execute = vi.fn(async (_args: unknown) => ({success: true, output: 'OK'}))
        toolRegistry.register({name: PROXY_NAME, description: 'p', inputSchema: undefined as never, execute})
        const r = await callMcpTool.execute({name: PROXY_NAME}, context())
        expect(r.success).toBe(false)
        expect(r.error).toContain('create_issue')
        expect(r.error).toContain('权限规则')
        expect(execute).not.toHaveBeenCalled()
    })

    it('proxy 名 glob（m_github_*）= deny → 工具内硬拒（MCP 专属严格层）', async () => {
        perms.rules = [{tool: 'm_github_*', action: 'deny'}]
        const execute = vi.fn(async (_args: unknown) => ({success: true, output: 'OK'}))
        toolRegistry.register({name: PROXY_NAME, description: 'p', inputSchema: undefined as never, execute})
        const r = await callMcpTool.execute({name: PROXY_NAME}, context())
        expect(r.success).toBe(false)
        expect(r.error).toContain('权限规则')
        expect(execute).not.toHaveBeenCalled()
    })

    it('★ allow 规则不得绕过 MCP denyList（denyList 是 server 级硬约束，优先级最高）', async () => {
        perms.denied = true
        for (const rule of [{tool: PROXY_NAME, action: 'allow' as const}, {tool: '*', action: 'allow' as const}]) {
            perms.rules = [rule]
            const execute = vi.fn(async (_args: unknown) => ({success: true, output: 'OK'}))
            toolRegistry.register({name: PROXY_NAME, description: 'p', inputSchema: undefined as never, execute})
            const r = await callMcpTool.execute({name: PROXY_NAME}, context())
            expect(r.success, `rule=${rule.tool} denyList 命中应拒绝`).toBe(false)
            expect(r.error).toContain('denyList')
            expect(execute).not.toHaveBeenCalled()
        }
    })

    it('bash: 前缀规则属于另一命名空间：既不命中 proxy 作用域、也不被引擎层识别', async () => {
        perms.rules = [{tool: 'bash:call_mcp_tool', action: 'allow'}]
        const confirm = vi.fn(async (_msg: string) => 'deny' as const)
        const r = await callMcpTool.execute({name: PROXY_NAME}, context(confirm))
        // 既无 proxy 作用域放行、也不构成引擎层规则 → 仍走工具内确认
        expect(confirm).toHaveBeenCalledTimes(1)
        expect(r.success).toBe(false)
    })

    it('无匹配规则 + safe → 仍弹确认（回归）', async () => {
        perms.rules = []
        const confirm = vi.fn(async (_msg: string) => 'deny' as const)
        const r = await callMcpTool.execute({name: PROXY_NAME}, context(confirm))
        expect(confirm).toHaveBeenCalledTimes(1)
        expect(r.success).toBe(false)
    })

    it('规则 ask → 视为需要确认（弹窗），不得直接拒绝/静默放行', async () => {
        perms.rules = [{tool: PROXY_NAME, action: 'ask'}]
        const confirm = vi.fn(async (_msg: string) => 'allow' as const)
        const r = await callMcpTool.execute({name: PROXY_NAME}, context(confirm))
        expect(confirm).toHaveBeenCalledTimes(1)
        expect(r.success).toBe(true)
    })

    it('★ proxy 作用域 ask 在 auto 下仍弹确认（模式无关，与引擎层 ask 语义一致）', async () => {
        perms.mode = 'auto'
        perms.rules = [{tool: PROXY_NAME, action: 'ask'}]
        const confirm = vi.fn(async (_msg: string) => 'allow' as const)
        const r = await callMcpTool.execute({name: PROXY_NAME}, context(confirm))
        expect(confirm).toHaveBeenCalledTimes(1)
        expect(r.success).toBe(true)
    })

    it('★ proxy 作用域 ask + 无确认通道 → fail-closed 阻断（不得静默放行）', async () => {
        const execute = vi.fn(async (_args: unknown) => ({success: true, output: 'OK'}))
        toolRegistry.register({name: PROXY_NAME, description: 'p', inputSchema: undefined as never, execute})
        perms.mode = 'auto'
        perms.rules = [{tool: PROXY_NAME, action: 'ask'}]
        const r = await callMcpTool.execute({name: PROXY_NAME}, context())
        expect(r.success).toBe(false)
        expect(r.error).toContain('确认通道')
        expect(execute).not.toHaveBeenCalled()
    })
})

describe('call_mcp_tool always 落库', () => {
    it('确认返回 always → addRule({tool: proxy 名, action: allow}) 调用一次，且本次照常执行', async () => {
        const execute = vi.fn(async (_args: unknown) => ({success: true, output: 'OK'}))
        toolRegistry.register({name: PROXY_NAME, description: 'p', inputSchema: undefined as never, execute})
        const onEvent = vi.fn()
        const confirm = vi.fn(async (_msg: string) => 'always' as const)
        const ctx = {...context(confirm), onEvent} as ToolContext
        const r = await callMcpTool.execute({name: PROXY_NAME}, ctx)
        expect(execute).toHaveBeenCalledTimes(1)
        expect(r.success).toBe(true)
        expect(engineMocks.addRule).toHaveBeenCalledTimes(1)
        expect(engineMocks.addRule).toHaveBeenCalledWith({tool: PROXY_NAME, action: 'allow'})
        expect(onEvent).toHaveBeenCalledWith({type: 'permission-rules-updated'})
    })
})

describe('call_mcp_tool fail-closed（§6.6 唯一防线）', () => {
    it('权限服务不可用（ok:false）→ 阻断，不执行 proxy，返回可读错误', async () => {
        perms.ok = false
        const execute = vi.fn(async (_args: unknown) => ({success: true, output: 'OK'}))
        toolRegistry.register({name: PROXY_NAME, description: 'p', inputSchema: undefined as never, execute})
        const r = await callMcpTool.execute({name: PROXY_NAME}, context())
        expect(r.success).toBe(false)
        expect(r.error).toContain('权限服务暂不可用')
        expect(r.error).toContain('create_issue')
        expect(execute).not.toHaveBeenCalled()
    })

    it('★ ok:false + auto 模式 → 仍阻断（不得因 auto 放行而静默执行 denyList 命中的工具）', async () => {
        perms.ok = false
        perms.mode = 'auto'
        const execute = vi.fn(async (_args: unknown) => ({success: true, output: 'OK'}))
        toolRegistry.register({name: PROXY_NAME, description: 'p', inputSchema: undefined as never, execute})
        const r = await callMcpTool.execute({name: PROXY_NAME}, context())
        expect(r.success).toBe(false)
        expect(execute).not.toHaveBeenCalled()
    })

    it('★ ok:false + 有确认回调 → 也阻断（不退回用户确认，避免确认被绕过）', async () => {
        perms.ok = false
        const confirm = vi.fn(async (_msg: string) => 'allow' as const)
        const execute = vi.fn(async (_args: unknown) => ({success: true, output: 'OK'}))
        toolRegistry.register({name: PROXY_NAME, description: 'p', inputSchema: undefined as never, execute})
        const r = await callMcpTool.execute({name: PROXY_NAME}, context(confirm))
        expect(r.success).toBe(false)
        expect(confirm).not.toHaveBeenCalled()
        expect(execute).not.toHaveBeenCalled()
    })
})

describe('call_mcp_tool 参数透传（§6.5.3 不做 zod 强校验）', () => {
    it('args 原样透传给 proxy.execute（嵌套/未知字段不报错）', async () => {
        perms.autoApproved = true
        const execute = vi.fn(async (_args: unknown) => ({success: true, output: 'OK'}))
        toolRegistry.register({name: PROXY_NAME, description: 'p', inputSchema: undefined as never, execute})
        const args = {repo: 'a/b', nested: {deep: [1, 2, 3]}, extra: null}
        await callMcpTool.execute({name: PROXY_NAME, args}, context())
        expect(execute.mock.calls[0][0]).toEqual(args)
    })

    it('args 缺省 → 传空对象', async () => {
        perms.autoApproved = true
        const execute = vi.fn(async (_args: unknown) => ({success: true, output: 'OK'}))
        toolRegistry.register({name: PROXY_NAME, description: 'p', inputSchema: undefined as never, execute})
        await callMcpTool.execute({name: PROXY_NAME}, context())
        expect(execute.mock.calls[0][0]).toEqual({})
    })

    it('proxy 抛错 → 转为可读错误，不冒泡', async () => {
        perms.autoApproved = true
        toolRegistry.register({
            name: PROXY_NAME,
            description: 'p',
            inputSchema: undefined as never,
            execute: async () => {
                throw new Error('server 参数错误: repo is required')
            },
        })
        const r = await callMcpTool.execute({name: PROXY_NAME}, context())
        expect(r.success).toBe(false)
        expect(r.error).toContain('repo is required')
    })
})

// ── 取消传播（B 批 · MCP discovery 消费 abortSignal）─────────────────────
//
// 本文件把 discovery 整体 mock 掉了（只留元数据 / 权限查询），而 proxy 的**真实**实现在
// discovery.ts —— 故此处以 importActual 取真模块注册真 proxy，再走 call_mcp_tool 的完整
// 链路（解析 → 权限 → proxy.execute）驱动取消语义，避免测试替身复刻一份假语义。
describe('MCP proxy 取消传播（abortSignal）', () => {
    const SERVER_ID = 'srv-abort'
    let realDiscovery: typeof import('../../../../../src/main/agent/mcp/discovery')

    beforeAll(async () => {
        realDiscovery = await vi.importActual<typeof import('../../../../../src/main/agent/mcp/discovery')>(
            '../../../../../src/main/agent/mcp/discovery',
        )
    })

    afterAll(() => {
        realDiscovery.unregisterMCPTools(SERVER_ID)
    })

    /** 注册真 proxy，并把 mock 的元数据指向它（call_mcp_tool 依据 meta 解析 registry 项） */
    function registerRealProxy(toolName: string) {
        realDiscovery.registerMCPTools(
            SERVER_ID,
            [{name: toolName, description: 'd', inputSchema: {type: 'object', properties: {}}}] as never,
            undefined,
            'gh',
        )
        const meta = realDiscovery.getAllMcpToolMeta().find((m) => m.serverId === SERVER_ID)!
        perms.meta = meta
        perms.autoApproved = true   // 跳过确认，直击 proxy.execute
        return meta
    }

    it('调用前已取消 → 以取消错误结算，不发起底层 MCP 调用', async () => {
        const meta = registerRealProxy('echo')
        const {mcpClient} = await import('../../../../../src/main/agent/mcp/client')
        const callTool = vi.spyOn(mcpClient, 'callTool')
        const controller = new AbortController()
        controller.abort()

        const r = await callMcpTool.execute({name: meta.proxyName}, {...context(), abortSignal: controller.signal})

        expect(callTool).not.toHaveBeenCalled()
        expect(r.success).toBe(false)
        expect(r.error).toContain('已取消')
        callTool.mockRestore()
    })

    it('调用中途取消 → 立即以取消错误结算，不等底层返回（不挂起）', async () => {
        const meta = registerRealProxy('slow')
        const {mcpClient} = await import('../../../../../src/main/agent/mcp/client')
        const controller = new AbortController()
        // 底层永不返回（模拟挂住的 MCP server）；「请求已发出」后再取消
        const callTool = vi.spyOn(mcpClient, 'callTool').mockImplementation(() => {
            controller.abort()
            return new Promise<never>(() => {})
        })

        const r = await callMcpTool.execute({name: meta.proxyName}, {...context(), abortSignal: controller.signal})

        expect(callTool).toHaveBeenCalledTimes(1)   // 已发出的请求无远端硬取消（已知边界）
        expect(r.success).toBe(false)
        expect(r.error).toContain('已取消')
        callTool.mockRestore()
    })
})
