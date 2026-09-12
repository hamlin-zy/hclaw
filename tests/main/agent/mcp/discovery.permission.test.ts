/**
 * getMcpToolPermission fail-closed 单测（spec §6.6）。
 *
 * 背景：catalog 通道下 call_mcp_tool 内的执行期权限判定是 denyList/autoApprove 的
 * 唯一防线。权限服务不可用（无通路 / 超时 / 异常）时若按「未命中」返回，
 * auto 模式 / 无确认回调（渠道会话）下会静默执行本应被 deny 的工具。
 * 因此三条降级路径都必须返回 ok:false，由调用方阻断。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'

const state = vi.hoisted(() => ({
    /** worker 线程内 parentPort 是否存在（undefined = 主进程） */
    parentPort: undefined as unknown,
    isToolDenied: ((_s: string, _t: string) => false) as (serverId: string, toolName: string) => boolean,
    isToolAutoApproved: ((_s: string, _t: string) => false) as (serverId: string, toolName: string) => boolean,
    throwOnQuery: false,
}))

vi.mock('worker_threads', () => ({
    // getter：discovery 内每次访问 parentPort 都读取最新值，便于切换 worker / 主进程
    get parentPort() {
        return state.parentPort
    },
    MessagePort: class {},
}))

vi.mock('../../../../src/main/agent/mcp/client', () => ({
    mcpClient: {
        isToolDenied: (serverId: string, toolName: string) => {
            if (state.throwOnQuery) throw new Error('mcp client boom')
            return state.isToolDenied(serverId, toolName)
        },
        isToolAutoApproved: (serverId: string, toolName: string) => state.isToolAutoApproved(serverId, toolName),
    },
}))

import {getMcpToolPermission, setMcpMessagePort} from '../../../../src/main/agent/mcp/discovery'

beforeEach(() => {
    state.parentPort = undefined
    state.isToolDenied = () => false
    state.isToolAutoApproved = () => false
    state.throwOnQuery = false
    setMcpMessagePort(null)
})

afterEach(() => {
    vi.useRealTimers()
    setMcpMessagePort(null)
})

describe('getMcpToolPermission', () => {
    it('主进程直连：正常判定返回 ok:true + 真实判定值', async () => {
        state.isToolDenied = () => true
        state.isToolAutoApproved = () => false
        const p = await getMcpToolPermission('plugin:github', 'create_issue')
        expect(p).toEqual({denied: true, autoApproved: false, ok: true})
    })

    it('降级路径 1：worker 内无 MessagePort 通路 → ok:false（fail-closed）', async () => {
        state.parentPort = {}
        const p = await getMcpToolPermission('plugin:github', 'create_issue')
        expect(p.ok).toBe(false)
        expect(p.denied).toBe(false)
        expect(p.autoApproved).toBe(false)
    })

    it('降级路径 2：worker 内 3s 超时无响应 → ok:false（fail-closed）', async () => {
        state.parentPort = {}
        vi.useFakeTimers()
        const port = {on: vi.fn(), off: vi.fn(), postMessage: vi.fn()}
        setMcpMessagePort(port as never)

        const pending = getMcpToolPermission('plugin:github', 'create_issue')
        await vi.advanceTimersByTimeAsync(3000)
        const p = await pending

        expect(p.ok).toBe(false)
        expect(port.postMessage).toHaveBeenCalledTimes(1)
    })

    it('降级路径 3：查询抛异常 → ok:false（fail-closed）', async () => {
        state.throwOnQuery = true
        const p = await getMcpToolPermission('plugin:github', 'create_issue')
        expect(p.ok).toBe(false)
    })
})
