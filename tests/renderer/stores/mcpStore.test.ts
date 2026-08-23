/**
 * mcpStore 单元测试
 *
 * 覆盖：
 * - addMCPServer：toSlug id 生成 / 重名自动加后缀 / 默认值（status/tools/enabled/timeout/autoApprove/denyList）+ saveServer
 * - removeMCPServer / updateMCPServer / toggleMCPServer：本地状态 + saveServer
 * - setServerStatus：更新 status/tools/errorDetail/extra；未命中 server 保持原样
 * - setServerStatusesBatch：批量单次 set（仅命中项更新，未命中项保留）
 * - onStatusChanged IPC 监听：新 server 追加（含默认字段）、已有 server 更新、
 *   防降级（connected → connecting 跳过）、error 写入 errorDetail
 * - hasRehydrated：persist rehydration 完成（依赖 mcp.list mock）
 *
 * 隔离：mcpStore 顶层注册 IPC 监听且 persist 通过 sqliteStorage 走
 * window.electronAPI.mcp.list，必须在 import 之前注入 window（vi.hoisted）。
 * sqliteStorage.mcp.setItem 是空实现，不会触发额外写盘。
 */
import {describe, expect, it, beforeEach, vi} from 'vitest'
import type {MCPServer} from '@/shared/types'

const h = vi.hoisted(() => {
    const statusHandlers: Array<(p: any) => void> = []
    const listHandlers: Array<() => void> = []
    const mcp: any = {
        onStatusChanged: vi.fn((fn: (p: any) => void) => { statusHandlers.push(fn) }),
        onListChanged: vi.fn((fn: () => void) => { listHandlers.push(fn) }),
        list: vi.fn(),
        saveServer: vi.fn(),
        delete: vi.fn(),
    }
    ;(globalThis as any).window = {electronAPI: {mcp}}
    return {mcp, statusHandlers, listHandlers}
})

import {useMcpStore} from '@/renderer/stores/mcpStore'

function resetStore() {
    useMcpStore.setState({mcpServers: []})
}

beforeEach(async () => {
    vi.clearAllMocks()
    resetStore()
    // 默认：list 返回空 → rehydration 完成（清空 mcpServers）
    h.mcp.list.mockResolvedValue({success: true, data: []})
    h.mcp.saveServer.mockResolvedValue({success: true})
    h.mcp.delete.mockResolvedValue({success: true})
})

describe('addMCPServer', () => {
    it('生成 slug id + 默认值（status/tools/enabled/timeout/autoApprove/denyList）+ saveServer', () => {
        const store = useMcpStore.getState()
        const server = store.addMCPServer({
            name: 'My Server',
            transport: 'stdio',
            command: 'node',
            enabled: true,
        })
        expect(server.id).toBe('my-server')
        expect(server.name).toBe('My Server')
        expect(server.status).toBe('stopped')
        expect(server.tools).toEqual([])
        expect(server.enabled).toBe(true)
        expect(server.timeout).toBe(60000)
        expect(server.autoApprove).toEqual([])
        expect(server.denyList).toEqual([])

        const state = useMcpStore.getState()
        expect(state.mcpServers).toHaveLength(1)
        expect(state.mcpServers[0].id).toBe('my-server')
        // 触发 IPC 持久化
        expect(h.mcp.saveServer).toHaveBeenCalledWith(expect.objectContaining({id: 'my-server'}))
    })

    it('重名时 id 自动加序号后缀（my-server-1）', () => {
        const store = useMcpStore.getState()
        store.addMCPServer({name: 'My Server', transport: 'stdio', enabled: true})
        store.addMCPServer({name: 'My Server', transport: 'stdio', enabled: true})
        const ids = useMcpStore.getState().mcpServers.map(s => s.id)
        expect(ids).toEqual(['my-server', 'my-server-1'])
    })

    it('两个不同名字生成不同 id', () => {
        const store = useMcpStore.getState()
        store.addMCPServer({name: 'Server A', transport: 'stdio', enabled: true})
        store.addMCPServer({name: 'Server B', transport: 'stdio', enabled: true})
        expect(useMcpStore.getState().mcpServers.map(s => s.id)).toEqual(['server-a', 'server-b'])
    })

    it('自定义 timeout/autoApprove/denyList 保留', () => {
        const store = useMcpStore.getState()
        store.addMCPServer({
            name: 'Srv', transport: 'stdio', command: 'x',
            timeout: 30000, autoApprove: ['read'], denyList: ['write'], enabled: true,
        })
        const s = useMcpStore.getState().mcpServers[0]
        expect(s.timeout).toBe(30000)
        expect(s.autoApprove).toEqual(['read'])
        expect(s.denyList).toEqual(['write'])
    })
})

describe('removeMCPServer', () => {
    it('移除服务器并调用 api.delete', () => {
        useMcpStore.setState({
            mcpServers: [{
                id: 'a', name: 'A', status: 'stopped', tools: [],
                transport: 'stdio', enabled: true,
            }],
        })
        useMcpStore.getState().removeMCPServer('a')
        expect(useMcpStore.getState().mcpServers).toEqual([])
        expect(h.mcp.delete).toHaveBeenCalledWith('a')
    })

    it('移除不存在的 id 不报错', () => {
        useMcpStore.getState().removeMCPServer('nope')
        expect(h.mcp.delete).toHaveBeenCalledWith('nope')
    })
})

describe('updateMCPServer', () => {
    it('更新字段 + saveServer（保存合并后的完整对象）', () => {
        useMcpStore.setState({
            mcpServers: [{
                id: 'a', name: 'A', status: 'stopped', tools: [],
                transport: 'stdio', enabled: true, command: 'old',
            }],
        })
        useMcpStore.getState().updateMCPServer('a', {command: 'new', enabled: false})
        const s = useMcpStore.getState().mcpServers[0]
        expect(s.command).toBe('new')
        expect(s.enabled).toBe(false)
        expect(h.mcp.saveServer).toHaveBeenCalledWith(expect.objectContaining({
            id: 'a', name: 'A', command: 'new', enabled: false,
        }))
    })

    it('未命中 id 不调用 saveServer', () => {
        useMcpStore.getState().updateMCPServer('nope', {command: 'x'})
        expect(h.mcp.saveServer).not.toHaveBeenCalled()
    })
})

describe('toggleMCPServer', () => {
    it('翻转 enabled + saveServer', () => {
        useMcpStore.setState({
            mcpServers: [{
                id: 'a', name: 'A', status: 'stopped', tools: [],
                transport: 'stdio', enabled: true,
            }],
        })
        useMcpStore.getState().toggleMCPServer('a')
        expect(useMcpStore.getState().mcpServers[0].enabled).toBe(false)
        expect(h.mcp.saveServer).toHaveBeenCalledWith(expect.objectContaining({id: 'a', enabled: false}))
        useMcpStore.getState().toggleMCPServer('a')
        expect(useMcpStore.getState().mcpServers[0].enabled).toBe(true)
    })

    it('未命中 id 不调用 saveServer', () => {
        useMcpStore.getState().toggleMCPServer('nope')
        expect(h.mcp.saveServer).not.toHaveBeenCalled()
    })
})

describe('setServerStatus', () => {
    it('更新 status/tools/errorDetail + saveServer', () => {
        useMcpStore.setState({
            mcpServers: [{
                id: 'a', name: 'A', status: 'stopped', tools: [],
                transport: 'stdio', enabled: true,
            }],
        })
        useMcpStore.getState().setServerStatus('a', 'connected', [{id: 't1', name: 'tool', description: '', inputSchema: {}}], 'err-detail')
        const s = useMcpStore.getState().mcpServers[0]
        expect(s.status).toBe('connected')
        expect(s.tools).toHaveLength(1)
        expect(s.tools[0].name).toBe('tool')
        expect(s.errorDetail).toBe('err-detail')
        expect(h.mcp.saveServer).toHaveBeenCalledWith(expect.objectContaining({id: 'a', status: 'connected'}))
    })

    it('tools/errorDetail 不传时保留原值', () => {
        useMcpStore.setState({
            mcpServers: [{
                id: 'a', name: 'A', status: 'stopped', tools: [{id: 't', name: 'keep', description: '', inputSchema: {}}],
                transport: 'stdio', enabled: true, errorDetail: 'old',
            }],
        })
        useMcpStore.getState().setServerStatus('a', 'error')
        const s = useMcpStore.getState().mcpServers[0]
        expect(s.status).toBe('error')
        expect(s.tools[0].name).toBe('keep')
        expect(s.errorDetail).toBe('old')
    })

    it('extra 合并进服务器', () => {
        useMcpStore.setState({
            mcpServers: [{
                id: 'a', name: 'A', status: 'stopped', tools: [],
                transport: 'stdio', enabled: true,
            }],
        })
        useMcpStore.getState().setServerStatus('a', 'connected', undefined, undefined, {userDescription: 'note'})
        expect(useMcpStore.getState().mcpServers[0].userDescription).toBe('note')
    })

    it('未命中 id → 不调用 saveServer 且列表不变', () => {
        useMcpStore.getState().setServerStatus('nope', 'connected')
        expect(h.mcp.saveServer).not.toHaveBeenCalled()
    })
})

describe('setServerStatusesBatch', () => {
    it('批量更新命中项，未命中项保留，单次 set（无 saveServer 调用）', () => {
        useMcpStore.setState({
            mcpServers: [
                {id: 'a', name: 'A', status: 'stopped', tools: [], transport: 'stdio', enabled: true},
                {id: 'b', name: 'B', status: 'stopped', tools: [], transport: 'stdio', enabled: true},
            ],
        })
        useMcpStore.getState().setServerStatusesBatch([
            {id: 'a', status: 'connecting'},
            {id: 'b', status: 'connected', tools: [{id: 't', name: 'toolB', description: '', inputSchema: {}}], errorDetail: 'boom'},
        ])
        const servers = useMcpStore.getState().mcpServers
        expect(servers[0]).toMatchObject({id: 'a', status: 'connecting'})
        expect(servers[1]).toMatchObject({id: 'b', status: 'connected', errorDetail: 'boom'})
        expect(servers[1].tools[0].name).toBe('toolB')
        // 批量更新不触发 saveServer
        expect(h.mcp.saveServer).not.toHaveBeenCalled()
    })

    it('未命中 id 的更新项被忽略（不影响其他项）', () => {
        useMcpStore.setState({
            mcpServers: [{id: 'a', name: 'A', status: 'stopped', tools: [], transport: 'stdio', enabled: true}],
        })
        useMcpStore.getState().setServerStatusesBatch([{id: 'missing', status: 'connected'}])
        expect(useMcpStore.getState().mcpServers[0].status).toBe('stopped')
    })
})

describe('onStatusChanged IPC 监听', () => {
    it('模块加载时注册了 onStatusChanged 监听', () => {
        expect(h.statusHandlers.length).toBeGreaterThanOrEqual(1)
    })

    it('未知 server（新发现）→ 追加到 store 并带默认字段', () => {
        h.statusHandlers[0]({
            serverId: 'plugin:new-server',
            status: 'connected',
            tools: [{id: 't', name: 'tool', description: '', inputSchema: {}}],
            error: 'err-x',
        })
        const s = useMcpStore.getState().mcpServers.find(x => x.id === 'plugin:new-server')
        expect(s).toBeTruthy()
        expect(s).toMatchObject({
            id: 'plugin:new-server',
            name: 'plugin:new-server',
            transport: 'stdio',
            status: 'connected',
            enabled: true,
            command: '',
            args: [],
            env: {},
            url: '',
            headers: {},
            cwd: '',
            timeout: 60000,
            autoApprove: [],
            denyList: [],
            userDescription: '',
            errorDetail: 'err-x',
        })
        expect(s!.tools).toEqual([{id: 't', name: 'tool', description: '', inputSchema: {}}])
    })

    it('已有 server → 更新 status/tools/errorDetail', () => {
        useMcpStore.setState({
            mcpServers: [{
                id: 'a', name: 'A', status: 'stopped', tools: [],
                transport: 'stdio', enabled: true, errorDetail: '',
            }],
        })
        h.statusHandlers[0]({
            serverId: 'a',
            status: 'connected',
            tools: [{id: 't1', name: 'x', description: '', inputSchema: {}}],
            error: '',
        })
        const s = useMcpStore.getState().mcpServers[0]
        expect(s.status).toBe('connected')
        expect(s.tools[0].name).toBe('x')
        expect(s.errorDetail).toBe('')
    })

    it('无 tools 字段时保留已有 tools（不覆盖为空）', () => {
        useMcpStore.setState({
            mcpServers: [{
                id: 'a', name: 'A', status: 'connecting', tools: [{id: 't', name: 'keep', description: '', inputSchema: {}}],
                transport: 'stdio', enabled: true,
            }],
        })
        h.statusHandlers[0]({serverId: 'a', status: 'connected', error: ''})
        expect(useMcpStore.getState().mcpServers[0].tools[0].name).toBe('keep')
    })

    it('防降级：connected → connecting 被跳过', () => {
        useMcpStore.setState({
            mcpServers: [{
                id: 'a', name: 'A', status: 'connected', tools: [],
                transport: 'stdio', enabled: true,
            }],
        })
        h.statusHandlers[0]({serverId: 'a', status: 'connecting', error: ''})
        expect(useMcpStore.getState().mcpServers[0].status).toBe('connected')
    })
})

describe('hasRehydrated（persist 相关）', () => {
    it('rehydration 完成后 hasRehydrated 为 true', async () => {
        // 首次 import 时 persist 已异步完成（list 返回空）
        await vi.waitFor(() => {
            expect(useMcpStore.getState().hasRehydrated).toBe(true)
        })
    })
})

describe('onListChanged IPC 监听', () => {
    it('模块加载时注册了 onListChanged 监听', () => {
        expect(h.listHandlers.length).toBeGreaterThanOrEqual(1)
    })

    it('触发 onListChanged → 调 mcp.list 刷新配置，保留 store 已有 runtime 状态', async () => {
        useMcpStore.setState({
            mcpServers: [{
                id: 'a', name: 'OldName', status: 'connected', tools: [{id: 't', name: 'keep', description: '', inputSchema: {}}],
                transport: 'stdio', enabled: true, errorDetail: 'rt-err',
            }],
        })
        h.mcp.list.mockResolvedValue({
            success: true,
            data: [{
                id: 'a', name: 'NewName', transport: 'http', url: 'http://x',
                status: 'stopped', tools: [], errorDetail: 'disk-err', enabled: true,
            }],
        })
        h.listHandlers[0]()
        await vi.waitFor(() => {
            const s = useMcpStore.getState().mcpServers[0]
            expect(s.name).toBe('NewName')
        })
        const s = useMcpStore.getState().mcpServers[0]
        // 配置字段被后端刷新
        expect(s.transport).toBe('http')
        expect(s.url).toBe('http://x')
        // runtime 状态保留 store 值（不被列表覆盖）
        expect(s.status).toBe('connected')
        expect(s.tools[0].name).toBe('keep')
        expect(s.errorDetail).toBe('rt-err')
    })

    it('list 失败（success:false）→ 不修改 store', async () => {
        h.mcp.list.mockResolvedValue({success: false, error: 'db down'})
        const before = useMcpStore.getState().mcpServers
        h.listHandlers[0]()
        await vi.waitFor(() => {
            expect(h.mcp.list).toHaveBeenCalled()
        })
        expect(useMcpStore.getState().mcpServers).toEqual(before)
    })
})
