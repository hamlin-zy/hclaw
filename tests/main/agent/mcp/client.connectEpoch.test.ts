/**
 * MCPClient.connectEpoch 回收回归面（本轮 D3）
 *
 * connectEpoch 以 serverId 为 key 只增不删 → key 集合随历史 serverId 有界累积
 * （value 是 number，约 10KB 量级，非泄漏但有界不收）。本轮补两条删除路径：
 *   - disconnect()：该 server 断开后回收
 *   - cleanupStoppedServers()：停止超 5 分钟的 server 回收
 *
 * ⚠️ 关键语义：connect() 内部会「先自增纪元 → 再 disconnect 旧 state」，
 *    因此删除必须带归属守卫（当前登记值 === 该 state 的 epoch），
 *    否则会把新一轮刚登记的纪元一起删掉 → 新一轮 doConnect 的纪元校验
 *    （state.epoch !== connectEpoch.get(id)）恒成立，连接被判「已被取代」白起一轮。
 *
 * 用例全部走私有字段注入，不连接真实进程（processController 为替身，killTree 不会被触发）。
 */
import {describe, it, expect, vi} from 'vitest'

vi.mock('@/main/agent/logger', () => ({
    logger: {info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn()},
}))

import {MCPClient} from '@/main/agent/mcp/client'

const processController = {
    isRunning: () => false,
    waitForExit: async () => true,
    killTree: vi.fn(),
}

function makeClient(): MCPClient {
    return new MCPClient({
        logger: {info: () => {}, warn: () => {}, error: () => {}, debug: () => {}},
        processController,
    })
}

function makeState(id: string, epoch: number, status: string, extra: Record<string, unknown> = {}) {
    return {
        config: {
            id, name: id, transport: 'stdio', command: 'npx', args: [], env: {},
            url: '', headers: {}, cwd: '', timeout: 60000, autoApprove: [], denyList: [],
            enabled: true, userDescription: '',
        },
        status,
        tools: [],
        resources: [],
        epoch,
        ...extra,
    } as any
}

describe('MCPClient.connectEpoch 回收（D3）', () => {
    it('disconnect() 后删除该 id 的 connectEpoch', async () => {
        const c = makeClient()
        ;(c as any).servers.set('srv-a', makeState('srv-a', 3, 'connected'))
        ;(c as any).connectEpoch.set('srv-a', 3)

        await (c as any).disconnect('srv-a')

        expect((c as any).connectEpoch.has('srv-a')).toBe(false)
        expect((c as any).servers.has('srv-a')).toBe(false)
    })

    it('disconnect() 不误删新一轮 connect 刚登记的纪元', async () => {
        const c = makeClient()
        // 复刻 connect() 的真实时序：新纪元（4）先自增，旧 state（epoch=3）随后被 disconnect
        ;(c as any).servers.set('srv-b', makeState('srv-b', 3, 'connected'))
        ;(c as any).connectEpoch.set('srv-b', 4)

        await (c as any).disconnect('srv-b')

        expect((c as any).connectEpoch.get('srv-b')).toBe(4)
    })

    it('cleanupStoppedServers() 删除停止超 5 分钟 id 的 connectEpoch', () => {
        const c = makeClient()
        const stale = Date.now() - 6 * 60 * 1000
        ;(c as any).servers.set('srv-old', makeState('srv-old', 2, 'stopped', {stoppedTime: stale}))
        ;(c as any).connectEpoch.set('srv-old', 2)
        ;(c as any).servers.set('srv-fresh', makeState('srv-fresh', 5, 'connected'))
        ;(c as any).connectEpoch.set('srv-fresh', 5)

        const removed = c.cleanupStoppedServers()

        expect(removed).toBe(1)
        expect((c as any).connectEpoch.has('srv-old')).toBe(false)
        // 活跃 server 的纪元不得被误删
        expect((c as any).connectEpoch.get('srv-fresh')).toBe(5)
    })
})
