// @vitest-environment jsdom
// ─── MCPDialog 插件 MC 开关错误处理回归（P2-2 未处理拒绝 / P2-6 失败即保留原值）───
// 既有 MCPDialog.toggleLock.test.tsx 只覆盖用户 MCP（handleToggle）；本文件独立存在，
// 把插件卡片换成「行为化替身」并暴露 onToggle 返回的 promise，从而精确断言：
//  ①start/stop 抛错或返回 {success:false} 时，onToggle 的 promise 不 reject（不冒泡成未处理拒绝）
//  ②本地 enabled 保持进入函数时的原值（不落到置新值那一步）
//  ③错误经既有 showError 反馈，且 in-flight/busy 在 finally 中清理
//  ④成功路径行为不变（enabled 置新值）
// 替身刻意不设 disabled（真实卡片用 busy 禁用交互），以便验证「锁」本身而非 DOM 禁用属性。
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, waitFor, act} from '@testing-library/react'
import MCPDialog from '../../../../src/renderer/components/dialogs/MCPDialog'

const {mockMcpState, mcpApiMock, mockShowError, pluginList} = vi.hoisted(() => {
    // 两个插件项：p1 enabled=true（点击 = 停用方向）、p2 enabled=false（点击 = 启用方向）
    const list = [
        {id: 'plugin:p1', name: 'Plugin P1', transport: 'stdio', enabled: true, command: 'x', args: [], env: {}},
        {id: 'plugin:p2', name: 'Plugin P2', transport: 'stdio', enabled: false, command: 'y', args: [], env: {}},
    ]
    return {
        pluginList: list,
        mockMcpState: {
            mcpServers: [],
            hasRehydrated: true,
            addMCPServer: vi.fn(),
            removeMCPServer: vi.fn(),
            updateMCPServer: vi.fn(),
            toggleMCPServer: vi.fn(),
            setServerEnabledLocal: vi.fn(),
            setServerStatus: vi.fn(),
            setServerStatusesBatch: vi.fn(),
        },
        mcpApiMock: {
            getAllStatus: vi.fn().mockResolvedValue([]),
            list: vi.fn().mockResolvedValue({success: true, data: []}),
            setEnabled: vi.fn().mockResolvedValue({success: true}),
            startServer: vi.fn().mockResolvedValue({success: true}),
            stopServer: vi.fn().mockResolvedValue({success: true}),
            switchVersion: vi.fn().mockResolvedValue({success: true}),
            onStatusChanged: vi.fn(),
        },
        mockShowError: vi.fn(),
    }
})

vi.mock('../../../../src/renderer/stores/mcpStore', () => {
    const getStateFn = () => mockMcpState
    const hook = (selector?: (s: typeof mockMcpState) => unknown) =>
        selector ? selector(mockMcpState) : mockMcpState
    hook.getState = getStateFn
    return {useMcpStore: hook}
})

// 行为化替身：把卡片开关暴露为可点击 button，并在元素上挂住 onToggle 返回的 promise，
// 供用例直接断言「是否 reject / 是否冒泡」。
vi.mock('../../../../src/renderer/components/dialogs/MCPUserServerCard', () => ({
    default: ({server, onToggle}: any) => (
        <button data-testid={`user-card-toggle-${server.id}`} onClick={onToggle}>toggle user</button>
    ),
}))
vi.mock('../../../../src/renderer/components/dialogs/MCPPluginServerCard', () => ({
    default: ({server, busy, onToggle}: any) => (
        <button
            data-testid={`plugin-card-toggle-${server.id}`}
            data-enabled={server.enabled ? '1' : '0'}
            data-busy={busy ? '1' : '0'}
            onClick={(e: any) => { e.currentTarget.__togglePromise = onToggle() }}
        >toggle plugin</button>
    ),
}))
vi.mock('../../../../src/renderer/components/dialogs/MCPEditModal', () => ({
    default: () => <div data-testid="edit-modal">edit</div>,
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
    mcpApiMock.getAllStatus.mockReset().mockResolvedValue([])
    mcpApiMock.list.mockReset().mockResolvedValue({success: true, data: pluginList})
    mcpApiMock.setEnabled.mockReset().mockResolvedValue({success: true})
    mcpApiMock.startServer.mockReset().mockResolvedValue({success: true})
    mcpApiMock.stopServer.mockReset().mockResolvedValue({success: true})
    mockMcpState.setServerEnabledLocal.mockClear()
    mockShowError.mockClear()
})

afterEach(() => {
    vi.unstubAllGlobals()
})

/** 渲染 → 切到插件 tab → 等目标插件卡片出现 */
async function renderPluginTab(): Promise<HTMLElement> {
    render(<MCPDialog />)
    fireEvent.click(screen.getByText('插件 MCP'))
    return await screen.findByTestId('plugin-card-toggle-plugin:p1')
}

describe('MCPDialog 插件开关错误处理（P2-2 / P2-6）', () => {
    it('P2-6 stop 返回失败 → enabled 保持原值（失败即保留，不再置为 false）', async () => {
        mcpApiMock.stopServer.mockResolvedValueOnce({success: false, error: '停止失败'})
        const btn = await renderPluginTab()
        expect(btn.getAttribute('data-enabled')).toBe('1')

        await act(async () => {
            fireEvent.click(btn)
            await (btn as any).__togglePromise
        })

        // 失败即保留原值：不得落到末尾的「置新值」分支
        await waitFor(() => expect(mockShowError).toHaveBeenCalledTimes(1))
        expect(btn.getAttribute('data-enabled')).toBe('1')
        expect(mockShowError.mock.calls[0][0]).toMatchObject({
            server: expect.objectContaining({id: 'plugin:p1'}),
            errorMessage: '停止失败',
            action: 'enable',
        })
        // finally 清理：busy 必须复位
        await waitFor(() => expect(btn.getAttribute('data-busy')).toBe('0'))
    })

    it('P2-2 stop 抛错 → promise 不 reject（无未处理拒绝）、enabled 保持原值、错误被反馈', async () => {
        mcpApiMock.stopServer.mockRejectedValueOnce(new Error('IPC 炸了'))
        const btn = await renderPluginTab()

        fireEvent.click(btn)
        const p = (btn as any).__togglePromise
        expect(p).toBeInstanceOf(Promise)
        // 关键：onToggle 返回的 promise 必须 resolve（不冒泡成未处理拒绝）
        await act(async () => { await expect(p).resolves.toBeUndefined() })

        await waitFor(() => expect(mockShowError).toHaveBeenCalledTimes(1))
        expect(btn.getAttribute('data-enabled')).toBe('1')
        expect(mockShowError.mock.calls[0][0]).toMatchObject({
            server: expect.objectContaining({id: 'plugin:p1'}),
            errorMessage: 'IPC 炸了',
            action: 'enable',
        })
        await waitFor(() => expect(btn.getAttribute('data-busy')).toBe('0'))
    })

    it('P2-2 start 抛错（启用方向）→ promise 不 reject、enabled 保持原值、错误被反馈', async () => {
        mcpApiMock.startServer.mockRejectedValueOnce(new Error('启动 IPC 炸了'))
        const btn = await renderPluginTab()
        const p2btn = await screen.findByTestId('plugin-card-toggle-plugin:p2')
        expect(p2btn.getAttribute('data-enabled')).toBe('0')

        fireEvent.click(p2btn)
        const p = (p2btn as any).__togglePromise
        await act(async () => { await expect(p).resolves.toBeUndefined() })

        await waitFor(() => expect(mockShowError).toHaveBeenCalledTimes(1))
        expect(p2btn.getAttribute('data-enabled')).toBe('0')
        expect(mockShowError.mock.calls[0][0]).toMatchObject({
            server: expect.objectContaining({id: 'plugin:p2'}),
            errorMessage: '启动 IPC 炸了',
            action: 'enable',
        })
        void btn
    })

    it('P2-6 start 返回失败（启用方向）→ enabled 保持原值', async () => {
        mcpApiMock.startServer.mockResolvedValueOnce({success: false, error: '启动失败'})
        await renderPluginTab()
        const p2btn = await screen.findByTestId('plugin-card-toggle-plugin:p2')

        await act(async () => {
            fireEvent.click(p2btn)
            await (p2btn as any).__togglePromise
        })

        await waitFor(() => expect(mockShowError).toHaveBeenCalledTimes(1))
        expect(p2btn.getAttribute('data-enabled')).toBe('0')
    })

    it('成功路径不变：stop 成功 → enabled 置为 false、无错误反馈', async () => {
        await renderPluginTab()
        const btn = await screen.findByTestId('plugin-card-toggle-plugin:p1')

        await act(async () => {
            fireEvent.click(btn)
            await (btn as any).__togglePromise
        })

        await waitFor(() => expect(btn.getAttribute('data-enabled')).toBe('0'))
        expect(mockShowError).not.toHaveBeenCalled()
        expect(mcpApiMock.stopServer).toHaveBeenCalledWith('plugin:p1')
        expect(mcpApiMock.startServer).not.toHaveBeenCalled()
    })
})
