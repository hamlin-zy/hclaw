/**
 * call_mcp_tool 单测：解析 → 权限 → 委托 三步链路（spec §9.3 权限与调用）。
 *
 * 重点（§6.6 安全底线）：catalog 通道下权限层是唯一防线，denyList / autoApprove
 * 必须按 (serverId, MCP 侧原始工具名) 在**执行期**重查，不得依赖 PermissionEngine
 * 的「非破坏性放行」分支。
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'

const perms = vi.hoisted(() => ({
    denied: false,
    autoApproved: false,
    /** 权限查询是否成功（false = 权限服务不可用，须 fail-closed） */
    ok: true,
    mode: 'safe' as 'safe' | 'auto',
    /** getMcpToolMeta 的返回值（undefined = 未命中） */
    meta: undefined as undefined | {proxyName: string; serverId: string; serverName?: string; rawToolName: string; rawInputSchema: unknown},
    calls: {meta: [] as string[], permission: [] as string[]},
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
    },
}))

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
