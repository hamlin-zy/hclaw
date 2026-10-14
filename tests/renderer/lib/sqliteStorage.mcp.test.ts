/**
 * sqliteStorage — mcp store 只读守卫策略字段 hydration 映射测试
 *
 * 覆盖（回归：mcp getItem 逐字段重建 server 对象时漏搬 readOnlyTools / writeTools /
 * unknownPolicy → hydration 后 store 缺策略值 → 编辑一个已连接 server 保存即回写
 * 空数组，擦除 mcp.json 手配值。本映射是应用启动 hydration 入口，比
 * mcpStore.onListChanged 更早生效）：
 * - getItem('mcp')：mcp:list 返回的三字段 → 渲染层 MCPServer（原值透传）
 * - 磁盘未配置时：数组落 []、unknownPolicy 保持 undefined（区分未配置与显式 deny）
 *
 * 隔离：沿用 sqliteStorage.pricing.test.ts 范式 — vi.hoisted 在模块导入前注入
 * window.electronAPI，不触碰真实 IPC；schemeSync mock 掉避免拉起副作用。
 */
import {describe, expect, it, beforeEach, vi} from 'vitest'

const h = vi.hoisted(() => {
    const mcp = {list: vi.fn()}
    ;(globalThis as any).window = {electronAPI: {mcp}}
    return {mcp}
})

vi.mock('@/renderer/stores/schemeSync', () => ({
    refreshToolStore: vi.fn(),
    syncSchemeToBackend: vi.fn(),
}))

import {sqliteStorage} from '@/renderer/lib/sqliteStorage'

beforeEach(() => {
    vi.clearAllMocks()
})

describe('sqliteStorage mcp — 只读守卫策略字段 hydration 映射', () => {
    it('getItem：三字段从 mcp:list 透传到渲染层 MCPServer（缺字段即擦除手配值）', async () => {
        h.mcp.list.mockResolvedValue({
            success: true,
            data: [{
                id: 'user-a', name: 'User A', transport: 'stdio', command: 'cmd-a',
                readOnlyTools: ['codegraph_explore'],
                writeTools: ['delete_file'],
                unknownPolicy: 'deny',
            }],
        })

        const result = await sqliteStorage.getItem('mcp')
        const server = (result as any).state.mcpServers[0]
        expect(server.readOnlyTools).toEqual(['codegraph_explore'])
        expect(server.writeTools).toEqual(['delete_file'])
        expect(server.unknownPolicy).toBe('deny')
    })

    it('getItem：磁盘未配置策略 → 数组落 []、unknownPolicy 保持 undefined（不折成 deny）', async () => {
        h.mcp.list.mockResolvedValue({
            success: true,
            data: [{id: 'user-b', name: 'User B', transport: 'stdio', command: 'cmd-b'}],
        })

        const result = await sqliteStorage.getItem('mcp')
        const server = (result as any).state.mcpServers[0]
        expect(server.readOnlyTools).toEqual([])
        expect(server.writeTools).toEqual([])
        expect(server.unknownPolicy).toBeUndefined()
    })
})
