// @vitest-environment jsdom
// ─── MCPDialog 写盘失败闭合回归（P1-1 续：handleRemove / onSave）───
// 既有 MCPDialog.toggleLock.test.tsx / MCPDialog.pluginToggleError.test.tsx 覆盖的是
// 「开关（set-enabled + start/stop）」链路；本文件独立覆盖剩余两条丢弃返回值的路径：
//  ①handleRemove：删除写盘失败时把 server 恢复到 store（列表重现）并走 showError
//  ②onSave 插件分支：saveServer 写盘失败时不合并本地 pluginMcpServers、走 showError
// 外加两条成功路径回归护栏（行为必须与改造前一致）。
// 桩法沿用上述两个文件的风格；store 直接使用**真实 mcpStore**（不再替身）——
// 否则真实 addMCPServer 的「按 name 重算 slug id / 覆写 enabled|status|tools / 二次写盘」
// 三条行为会被替身掩盖（正是本轮 P1 的漏检根因）。
// 注意：用户分支（updateMCPServer）的 store action 为 fire-and-forget，组件层无法闭合，
//       本文件只记录现状（见最后一条用例与实现报告），不作为期望行为锁定。
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, waitFor, act} from '@testing-library/react'
import MCPDialog from '../../../../src/renderer/components/dialogs/MCPDialog'
import {useMcpStore} from '../../../../src/renderer/stores/mcpStore'

const {initialServers, pluginServers, mcpApiMock, mockShowError} = vi.hoisted(() => {
    const user = [
        {id: 'user-a', name: 'User A', transport: 'stdio', status: 'stopped', tools: [], enabled: true, command: 'cmd-a', args: [], env: {}, url: '', headers: {}, cwd: '', timeout: 60000, autoApprove: [], denyList: [], userDescription: ''},
        {id: 'user-b', name: 'User B', transport: 'stdio', status: 'stopped', tools: [], enabled: true, command: 'cmd-b', args: [], env: {}, url: '', headers: {}, cwd: '', timeout: 60000, autoApprove: [], denyList: [], userDescription: ''},
    ]
    // 插件项 status 固定为 stopped：避免成功保存路径顺带触发 stop/start（本文件不覆盖该分支）
    const plugins = [
        {id: 'plugin:p1', name: 'Plugin P1', transport: 'stdio', status: 'stopped', tools: [], enabled: true, command: 'plugin-old', args: [], env: {}},
    ]
    return {
        initialServers: user,
        pluginServers: plugins,
        mcpApiMock: {
            getAllStatus: vi.fn().mockResolvedValue([]),
            list: vi.fn().mockResolvedValue({success: true, data: []}),
            setEnabled: vi.fn().mockResolvedValue({success: true}),
            startServer: vi.fn().mockResolvedValue({success: true}),
            stopServer: vi.fn().mockResolvedValue({success: true}),
            saveServer: vi.fn().mockResolvedValue({success: true}),
            delete: vi.fn().mockResolvedValue({success: true}),
            switchVersion: vi.fn().mockResolvedValue({success: true}),
            onStatusChanged: vi.fn(),
            onMcpStatusUpdate: vi.fn(),
        },
        mockShowError: vi.fn(),
    }
})

// ★ store 使用真实 zustand store（不再用与真实行为不一致的简化替身）——本轮 P1 的漏检根因
//   正是替身掩盖了真实 addMCPServer 的三条行为：按 name 重算 slug id / 覆写 enabled|status|tools /
//   额外再调一次 saveServer。
//   隔离：真实 store 的 persist 适配器（sqliteStorage.mcp）在模块加载时读 mcp:list，此刻
//   electronAPI 尚未 stub → getItem 返回 null，hydration 为 no-op，不会覆盖本文件的 setState。
//   另：真实 removeMCPServer 会先 fire-and-forget 调一次 mcp.delete，组件随后再 await 一次，
//   故需要「组件那次失败」的用例按调用序回放（第 1 次 = store 的 fire-and-forget）。

// 行为化替身：暴露 edit / delete 入口，并把 server 关键字段挂到 data-* 上供断言「本地值是否被改写」
vi.mock('../../../../src/renderer/components/dialogs/MCPUserServerCard', () => ({
    default: ({server, onEdit, onDelete}: any) => (
        <>
            <button data-testid={`user-card-edit-${server.id}`} data-command={server.command}
                    onClick={onEdit}>edit user</button>
            <button data-testid={`user-card-del-${server.id}`} onClick={onDelete}>del user</button>
        </>
    ),
}))
vi.mock('../../../../src/renderer/components/dialogs/MCPPluginServerCard', () => ({
    default: ({server, onEdit}: any) => (
        <button data-testid={`plugin-card-edit-${server.id}`} data-command={server.command}
                onClick={onEdit}>edit plugin</button>
    ),
}))
// 替身把 onSave 返回的 promise 挂到元素上，供用例精确 await 保存流程完成
vi.mock('../../../../src/renderer/components/dialogs/MCPEditModal', () => ({
    default: ({server, onSave, onCancel}: any) => (
        <div data-testid="edit-modal" data-editing={server?.id || 'add'}>
            <button
                data-testid="edit-modal-save"
                onClick={(e: any) => {
                    e.currentTarget.__savePromise = onSave({command: 'new-cmd', name: server?.name ?? 'New Server'})
                }}
            >save</button>
            <button data-testid="edit-modal-cancel" onClick={onCancel}>cancel</button>
        </div>
    ),
}))
vi.mock('../../../../src/renderer/components/dialogs/MCPToolsOverlay', () => ({
    default: () => <div data-testid="tools-overlay">tools</div>,
}))
vi.mock('../../../../src/renderer/components/dialogs/MCPErrorHelper', () => ({
    useMcpErrorDialog: () => ({
        McpErrorOverlay: () => null,
        showError: mockShowError,
    }),
}))

beforeEach(() => {
    vi.stubGlobal('electronAPI', {
        mcp: mcpApiMock,
        windowControls: {close: vi.fn()},
    })
    Object.values(mcpApiMock).forEach((fn: any) => fn.mockReset?.())
    mcpApiMock.getAllStatus.mockResolvedValue([])
    mcpApiMock.list.mockResolvedValue({success: true, data: []})
    mcpApiMock.setEnabled.mockResolvedValue({success: true})
    mcpApiMock.startServer.mockResolvedValue({success: true})
    mcpApiMock.stopServer.mockResolvedValue({success: true})
    mcpApiMock.saveServer.mockResolvedValue({success: true})
    mcpApiMock.delete.mockResolvedValue({success: true})
    useMcpStore.setState({mcpServers: initialServers.map((s: any) => ({...s}))})
    mockShowError.mockClear()
})

afterEach(() => {
    vi.unstubAllGlobals()
})

const storeIds = () => useMcpStore.getState().mcpServers.map((s: any) => s.id)

/** 切到插件 tab，等插件卡片出现 */
async function goPluginTab() {
    fireEvent.click(screen.getByText('插件 MCP'))
    return await screen.findByTestId('plugin-card-edit-plugin:p1')
}

describe('MCPDialog 删除路径写盘失败闭合', () => {
    it('删除写盘失败 → server 被恢复回列表 + 走 showError 反馈', async () => {
        // 真实 store 的 removeMCPServer 会先 fire-and-forget 调一次 delete，组件随后再 await 一次；
        // 两次都返回失败 → 恢复路径成立（后续断言不依赖调用次数）。
        mcpApiMock.delete.mockResolvedValue({success: false, error: '删除 MCP 服务器失败'})

        render(<MCPDialog />)
        fireEvent.click(await screen.findByTestId('user-card-del-user-a'))

        await waitFor(() => expect(mockShowError).toHaveBeenCalledTimes(1))
        expect(mockShowError.mock.calls[0][0]).toMatchObject({
            server: expect.objectContaining({id: 'user-a', name: 'User A'}),
            errorMessage: '删除 MCP 服务器失败',
        })
        // ★ 关键：列表里必须重新出现被删项（不是只调用 action，而是真的回到列表）
        await waitFor(() => expect(screen.getByTestId('user-card-del-user-a')).toBeTruthy())
        await waitFor(() => expect(storeIds()).toContain('user-a'))
        expect(storeIds()).toContain('user-b')
    })

    it('删除 IPC 抛错 → 同样恢复回列表 + 错误被反馈', async () => {
        // 第 1 次 = store.removeMCPServer 的 fire-and-forget（给 resolved，避免未处理拒绝）；
        // 第 2 次 = 组件 await 的那次（真实 store 下顺序确定）。
        mcpApiMock.delete
            .mockResolvedValueOnce({success: true})
            .mockRejectedValueOnce(new Error('IPC 炸了'))

        render(<MCPDialog />)
        fireEvent.click(await screen.findByTestId('user-card-del-user-a'))

        await waitFor(() => expect(mockShowError).toHaveBeenCalledTimes(1))
        expect(mockShowError.mock.calls[0][0]).toMatchObject({
            server: expect.objectContaining({id: 'user-a'}),
            errorMessage: 'IPC 炸了',
        })
        await waitFor(() => expect(storeIds()).toContain('user-a'))
    })

    it('删除成功（回归护栏）→ 列表移除该项、不恢复、无错误反馈', async () => {
        render(<MCPDialog />)
        fireEvent.click(await screen.findByTestId('user-card-del-user-a'))

        await waitFor(() => expect(storeIds()).not.toContain('user-a'))
        expect(screen.queryByTestId('user-card-del-user-a')).toBeNull()
        expect(mockShowError).not.toHaveBeenCalled()
    })
})

describe('P1 删除写盘失败的恢复必须「原样」（真实 store 锁定）', () => {
    // imported:* + 中文名：真实 addMCPServer 会按 name 重算 slug id → 与原 id 漂移
    const imported: any = {
        id: 'imported:foo', name: '导入的外部服务', transport: 'stdio',
        status: 'connected', enabled: false,
        tools: [{name: 'tool-a', description: 'A', inputSchema: {type: 'object'}}],
        errorDetail: '上次错误', command: 'cmd-i', args: ['--x'], env: {K: 'V'},
        url: '', headers: {}, cwd: '', timeout: 30000,
        autoApprove: ['read'], denyList: ['write'], userDescription: '导入说明',
    }

    it('恢复后 id / enabled / status / tools 全原样、插回原索引、且不产生二次写盘', async () => {
        const userA: any = {...initialServers[0]}
        const userB: any = {...initialServers[1]}
        // 故意把 imported 放在中间：addMCPServer 会 append 到末尾，顺序断言即可分辨
        useMcpStore.setState({mcpServers: [userA, imported, userB]})
        mcpApiMock.delete.mockResolvedValue({success: false, error: '删除 MCP 服务器失败'})

        render(<MCPDialog />)
        fireEvent.click(await screen.findByTestId('user-card-del-imported:foo'))

        await waitFor(() => expect(mockShowError).toHaveBeenCalledTimes(1))

        const servers: any[] = useMcpStore.getState().mcpServers
        // ① id 与磁盘原 id 完全一致（addMCPServer 会重算成 slug，如 'dao-ru-de-wai-bu-fu-wu'）
        expect(servers.map(s => s.id)).toEqual(['user-a', 'imported:foo', 'user-b'])
        // ② 恢复的是原对象：enabled/status/tools 不得被覆写为 true/stopped/[]
        expect(servers[1]).toBe(imported)
        expect(servers[1].enabled).toBe(false)
        expect(servers[1].status).toBe('connected')
        expect(servers[1].tools).toHaveLength(1)
        expect(servers[1].timeout).toBe(30000)
        // ③ 未发生二次写盘（addMCPServer 会 saveServer 落盘 → 把被改坏的字段写进 mcp.json）
        expect(mcpApiMock.saveServer).not.toHaveBeenCalled()
        // ④ 顺序合理：插回原索引而非追加到末尾
        expect(servers[2].id).toBe('user-b')
    })
})

describe('MCPDialog 编辑保存在插件分支的写盘失败闭合', () => {
    it('插件保存写盘失败 → 本地 pluginMcpServers 保持原值 + 走 showError 反馈', async () => {
        mcpApiMock.list.mockResolvedValue({success: true, data: pluginServers})
        mcpApiMock.saveServer.mockResolvedValueOnce({success: false, error: '保存 MCP 配置失败'})

        render(<MCPDialog />)
        const editBtn = await goPluginTab()
        expect(editBtn.getAttribute('data-command')).toBe('plugin-old')
        fireEvent.click(editBtn)

        const saveBtn = await screen.findByTestId('edit-modal-save')
        await act(async () => {
            fireEvent.click(saveBtn)
            await (saveBtn as any).__savePromise
        })

        await waitFor(() => expect(mockShowError).toHaveBeenCalledTimes(1))
        expect(mockShowError.mock.calls[0][0]).toMatchObject({
            server: expect.objectContaining({id: 'plugin:p1'}),
            errorMessage: '保存 MCP 配置失败',
        })
        // ★ 关键：本地值不得被合并改写
        expect(screen.getByTestId('plugin-card-edit-plugin:p1').getAttribute('data-command')).toBe('plugin-old')
        expect(mcpApiMock.saveServer).toHaveBeenCalledTimes(1)
        expect(mcpApiMock.saveServer).toHaveBeenCalledWith(expect.objectContaining({id: 'plugin:p1', command: 'new-cmd'}))
        // 写盘失败不得顺带触发进程操作
        expect(mcpApiMock.startServer).not.toHaveBeenCalled()
        expect(mcpApiMock.stopServer).not.toHaveBeenCalled()
    })

    it('插件保存 IPC 抛错 → 本地值保持原值 + 错误被反馈', async () => {
        mcpApiMock.list.mockResolvedValue({success: true, data: pluginServers})
        mcpApiMock.saveServer.mockRejectedValueOnce(new Error('保存 IPC 炸了'))

        render(<MCPDialog />)
        fireEvent.click(await goPluginTab())

        const saveBtn = await screen.findByTestId('edit-modal-save')
        await act(async () => {
            fireEvent.click(saveBtn)
            await (saveBtn as any).__savePromise
        })

        await waitFor(() => expect(mockShowError).toHaveBeenCalledTimes(1))
        expect(mockShowError.mock.calls[0][0]).toMatchObject({
            server: expect.objectContaining({id: 'plugin:p1'}),
            errorMessage: '保存 IPC 炸了',
        })
        expect(screen.getByTestId('plugin-card-edit-plugin:p1').getAttribute('data-command')).toBe('plugin-old')
    })

    it('插件保存成功（回归护栏）→ 本地合并为新值、无错误反馈', async () => {
        mcpApiMock.list.mockResolvedValue({success: true, data: pluginServers})

        render(<MCPDialog />)
        fireEvent.click(await goPluginTab())

        const saveBtn = await screen.findByTestId('edit-modal-save')
        await act(async () => {
            fireEvent.click(saveBtn)
            await (saveBtn as any).__savePromise
        })

        await waitFor(() =>
            expect(screen.getByTestId('plugin-card-edit-plugin:p1').getAttribute('data-command')).toBe('new-cmd'))
        expect(mockShowError).not.toHaveBeenCalled()
        expect(mcpApiMock.saveServer).toHaveBeenCalledTimes(1)
        // 成功路径保持原样：弹窗关闭
        expect(screen.queryByTestId('edit-modal')).toBeNull()
    })
})

describe('MCPDialog 编辑保存在用户分支的现状记录', () => {
    // ⚠️ 本用例记录的是「当前实现的事实」，不是期望行为：
    //    用户分支调用 store 的 updateMCPServer（fire-and-forget，内部再调 saveServer），
    //    组件层拿不到写盘结果 → 写盘失败时既不改回本地值、也无 showError。
    //    闭合该路径需要 store 层配合（见实现报告的建议），本轮按约束未改 store。
    it('[现状证据] 用户分支保存写盘失败时组件层无法感知（updateMCPServer 为 fire-and-forget）', async () => {
        mcpApiMock.saveServer.mockResolvedValue({success: false, error: '保存 MCP 配置失败'})

        render(<MCPDialog />)
        fireEvent.click(await screen.findByTestId('user-card-edit-user-a'))

        const saveBtn = await screen.findByTestId('edit-modal-save')
        await act(async () => {
            fireEvent.click(saveBtn)
            await (saveBtn as any).__savePromise
        })

        // 现状：本地值已被 updateMCPServer 改写，且无任何错误反馈
        await waitFor(() =>
            expect(screen.getByTestId('user-card-edit-user-a').getAttribute('data-command')).toBe('new-cmd'))
        expect(mockShowError).not.toHaveBeenCalled()
        // 写盘确实失败过（saveServer 返回 {success:false}），但结果被丢弃
        expect(mcpApiMock.saveServer).toHaveBeenCalledTimes(1)
    })
})
