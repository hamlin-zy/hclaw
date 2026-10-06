/**
 * MCPServerService 写盘失败回滚回归面（本轮 D4）
 *
 * 背景：setEnabled 的幂等短路依赖「内存与磁盘一致」。add / delete / update 若忽略
 * writeMcpConfig 的返回值，写盘失败时内存已是新值而磁盘未变 —— 随后同值重试被幂等短路
 * 拦下 → 漂移固化、不自愈（重启应用表现为「改动莫名回退」）。
 *
 * 判定约定：必须用 `=== false` 判失败（falsy 判断会把返回 undefined 的测试替身误判为失败）。
 * 三条失败路径均不得发 list-changed；成功路径的 notify 行为保持不变。
 *
 * ⚠️ 不写真实 mcp.json：writeMcpConfig 被 mock，返回值由用例逐次指定。
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'

const mocks = vi.hoisted(() => ({
    writeMcpConfig: vi.fn(() => true),
    logger: {info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn()},
}))

vi.mock('@/main/agent/logger', () => ({createLogger: () => mocks.logger}))
vi.mock('@/main/config/mcpConfig', () => ({
    readMcpConfig: () => [],
    writeMcpConfig: mocks.writeMcpConfig,
}))

import {MCPServerService} from '@/main/services/mcpService'

function makeServer(id: string) {
    return {
        id,
        name: id,
        transport: 'stdio' as const,
        command: 'npx',
        args: ['-y', `@foo/${id}`],
        env: {},
        url: '',
        userDescription: '',
        enabled: true,
    }
}

describe('MCPServerService 写盘失败回滚（D4）', () => {
    let service: MCPServerService

    beforeEach(() => {
        mocks.writeMcpConfig.mockReset().mockReturnValue(true)
        service = new MCPServerService()
    })

    it('add: 写盘返回 false → 回滚内存、返回 false、不发 list-changed', () => {
        expect(service.add(makeServer('srv-1'))).toBe(true)
        vi.clearAllMocks()

        const listener = vi.fn()
        service.onEvent(listener)
        mocks.writeMcpConfig.mockReturnValueOnce(false)

        expect(service.add(makeServer('srv-2'))).toBe(false)
        expect(service.get('srv-2')).toBeUndefined()
        expect(service.list().map(s => s.id)).toEqual(['srv-1'])
        expect(listener).not.toHaveBeenCalled()
    })

    it('delete: 写盘返回 false → 放回原索引、返回 false、不发 list-changed', () => {
        service.add(makeServer('srv-1'))
        service.add(makeServer('srv-2'))
        service.add(makeServer('srv-3'))
        const before = service.list().map(s => s.id)
        // list() 按 name 排序，插入顺序另算：直接取内部 Map 的 key 顺序验证索引位置
        const orderBefore = Array.from((service as any).servers.keys())
        vi.clearAllMocks()

        const listener = vi.fn()
        service.onEvent(listener)
        mocks.writeMcpConfig.mockReturnValueOnce(false)

        expect(service.delete('srv-2')).toBe(false)
        expect(service.get('srv-2')).toBeDefined()
        expect(Array.from((service as any).servers.keys())).toEqual(orderBefore)
        expect(service.list().map(s => s.id)).toEqual(before)
        expect(listener).not.toHaveBeenCalled()
    })

    it('update: 写盘返回 false → 回滚 patch、返回 false、不发 list-changed', () => {
        service.add(makeServer('srv-1'))
        const original = service.get('srv-1')!
        vi.clearAllMocks()

        const listener = vi.fn()
        service.onEvent(listener)
        mocks.writeMcpConfig.mockReturnValueOnce(false)

        expect(service.update('srv-1', {args: ['-y', '@foo/changed@2.0.0']})).toBe(false)
        expect(service.get('srv-1')!.args).toEqual(['-y', '@foo/srv-1'])
        // 回滚写回的是改动前的同一对象引用（其余字段零扰动）
        expect(service.get('srv-1')).toBe(original)
        expect(listener).not.toHaveBeenCalled()
    })

    it('成功路径不受影响：add / delete / update 各发一次 list-changed', () => {
        const listener = vi.fn()
        service.onEvent(listener)

        expect(service.add(makeServer('srv-1'))).toBe(true)
        expect(service.update('srv-1', {name: 'renamed'})).toBe(true)
        expect(service.delete('srv-1')).toBe(true)

        expect(listener).toHaveBeenCalledTimes(3)
        expect(mocks.writeMcpConfig).toHaveBeenCalledTimes(3)
    })

    it('写盘返回 undefined（测试替身/签名变化）不视为失败', () => {
        service.add(makeServer('srv-1'))
        vi.clearAllMocks()
        const listener = vi.fn()
        service.onEvent(listener)
        mocks.writeMcpConfig.mockReturnValueOnce(undefined as any)

        expect(service.update('srv-1', {name: 'still-ok'})).toBe(true)
        expect(service.get('srv-1')!.name).toBe('still-ok')
        expect(listener).toHaveBeenCalledTimes(1)
    })
})
