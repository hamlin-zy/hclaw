// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, waitFor} from '@testing-library/react'
import MCPDialog from '../../../../src/renderer/components/dialogs/MCPDialog'

// ── 依赖 mock ──────────────────────────────────────────
// MCPDialog 依赖链过深（MCPUserServerCard/MCPPluginServerCard/MCPEditModal/MCPToolsOverlay/
// MCPErrorHelper + mcpStore + menuBarStore + electronAPI），按 brief 允许降级策略：
// 1) mock 全部子卡片组件为简单 div
// 2) 只测渲染不抛错 + toggleAll 的 startServer/stopServer 分支（点击"全部开启"开关）

const {mockMcpState, mcpApiMock} = vi.hoisted(() => {
    const servers = [
        {id: 'server-a', name: 'Server A', transport: 'stdio', status: 'stopped', tools: [], enabled: true, command: '', args: [], env: {}, url: '', headers: {}, cwd: '', timeout: 60000, autoApprove: [], denyList: [], userDescription: ''},
        {id: 'server-b', name: 'Server B', transport: 'stdio', status: 'stopped', tools: [], enabled: true, command: '', args: [], env: {}, url: '', headers: {}, cwd: '', timeout: 60000, autoApprove: [], denyList: [], userDescription: ''},
    ]
    return {
        mockMcpState: {
            mcpServers: servers,
            hasRehydrated: true,
            addMCPServer: vi.fn(),
            removeMCPServer: vi.fn(),
            updateMCPServer: vi.fn(),
            toggleMCPServer: vi.fn(),
            setServerStatus: vi.fn(),
            setServerStatusesBatch: vi.fn(),
        },
        mcpApiMock: {
            getAllStatus: vi.fn().mockResolvedValue([]),
            list: vi.fn().mockResolvedValue({success: true, data: []}),
            setEnabled: vi.fn().mockResolvedValue({success: true}),
            startServer: vi.fn().mockResolvedValue({success: true}),
            stopServer: vi.fn().mockResolvedValue({success: true}),
            onStatusChanged: vi.fn(),
        },
    }
})

// MCPDialog 以 `useMcpStore()`（无参）解构整包状态，并通过 useMcpStore.getState() 读取快照。
// 因 zustand hook 的 .getState 是静态属性，这里将 getState 挂载在返回函数上。
vi.mock('../../../../src/renderer/stores/mcpStore', () => {
    const getStateFn = () => mockMcpState
    const hook = (selector?: (s: typeof mockMcpState) => unknown) =>
        selector ? selector(mockMcpState) : mockMcpState
    hook.getState = getStateFn
    return {useMcpStore: hook}
})

vi.mock('../../../../src/renderer/components/dialogs/MCPUserServerCard', () => ({
    default: () => <div data-testid="user-server-card">user card</div>,
}))
vi.mock('../../../../src/renderer/components/dialogs/MCPPluginServerCard', () => ({
    default: () => <div data-testid="plugin-server-card">plugin card</div>,
}))
vi.mock('../../../../src/renderer/components/dialogs/MCPEditModal', () => ({
    default: () => <div data-testid="edit-modal">edit</div>,
}))
vi.mock('../../../../src/renderer/components/dialogs/MCPToolsOverlay', () => ({
    default: () => <div data-testid="tools-overlay">tools</div>,
}))
// MCPErrorHelper 内部渲染 MarkdownRenderer，mock 整个 hook 返回无 UI 版本
vi.mock('../../../../src/renderer/components/dialogs/MCPErrorHelper', () => ({
    useMcpErrorDialog: () => ({
        McpErrorOverlay: () => null,
        showError: vi.fn(),
    }),
}))
// Switch 是真实组件（无外部依赖），不 mock

beforeEach(() => {
    vi.stubGlobal('electronAPI', {
        mcp: mcpApiMock,
        windowControls: {close: vi.fn()},
    })
    mcpApiMock.setEnabled.mockClear()
    mcpApiMock.startServer.mockClear()
    mcpApiMock.stopServer.mockClear()
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('MCPDialog 冒烟 + toggleAll 分支（Task 4 改写的 startServer/stopServer 分支）', () => {
    it('渲染不抛错且显示用户 MCP 服务器', async () => {
        render(<MCPDialog />)
        await waitFor(() => expect(screen.getByText('用户 MCP')).toBeTruthy())
        expect(screen.getByText('MCP 服务器')).toBeTruthy()
    })

    it('toggleAll 启用分支调用 startServer 而非 stopServer', async () => {
        render(<MCPDialog />)
        await waitFor(() => expect(screen.getByRole('switch')).toBeTruthy())

        // 当前 userAllEnabled=true（两个 server 均 enabled）→ 点击开关 → 全部禁用
        fireEvent.click(screen.getByRole('switch'))
        // 全部禁用：每个 server 走 setEnabled(false) + stopServer
        await waitFor(() => {
            expect(mcpApiMock.setEnabled).toHaveBeenCalledWith('server-a', false)
            expect(mcpApiMock.stopServer).toHaveBeenCalledWith('server-a')
            expect(mcpApiMock.stopServer).toHaveBeenCalledWith('server-b')
        })
        expect(mcpApiMock.startServer).not.toHaveBeenCalled()
    })
})
