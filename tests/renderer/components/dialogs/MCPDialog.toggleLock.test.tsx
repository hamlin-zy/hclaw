// @vitest-environment jsdom
// ─── MCPDialog 渲染层加固回归（第三轮）────────────────────
// 既有 MCPDialog.toggle.test.tsx 把子卡片 mock 成静态 div，无法触发卡片内的 handleToggle；
// 为避免改动既有 4 个用例，本文件独立存在，并把 MCPUserServerCard 换成「行为化替身」：
// 渲染一个可点击 button 并接上 props.onToggle，从而在不引入真实卡片依赖的前提下
// 验证 ①in-flight 锁 ②失败回滚 ③toggleAll 全量持锁与 busy 反馈。
// 注意：替身刻意不设 disabled（真实卡片用 busy 禁用交互），以便验证「锁」本身而非 DOM 禁用属性。
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, waitFor, act} from '@testing-library/react'
import MCPDialog from '../../../../src/renderer/components/dialogs/MCPDialog'

const {mockMcpState, mcpApiMock, mockShowError} = vi.hoisted(() => {
    // 两个 server 初始都 disabled：这样「点击开关」= 启用方向，用例可覆盖 startServer 分支
    const servers = [
        {id: 'server-a', name: 'Server A', transport: 'stdio', status: 'stopped', tools: [], enabled: false, command: '', args: [], env: {}, url: '', headers: {}, cwd: '', timeout: 60000, autoApprove: [], denyList: [], userDescription: ''},
        {id: 'server-b', name: 'Server B', transport: 'stdio', status: 'stopped', tools: [], enabled: false, command: '', args: [], env: {}, url: '', headers: {}, cwd: '', timeout: 60000, autoApprove: [], denyList: [], userDescription: ''},
    ]
    return {
        mockMcpState: {
            mcpServers: servers,
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

// 行为化替身：把卡片开关暴露为可点击 button，直达 MCPDialog 的 onToggle（= handleToggle / handlePluginToggle）
vi.mock('../../../../src/renderer/components/dialogs/MCPUserServerCard', () => ({
    default: ({server, busy, onToggle}: any) => (
        <button
            data-testid={`user-card-toggle-${server.id}`}
            data-busy={busy ? '1' : '0'}
            onClick={onToggle}
        >toggle {server.id}</button>
    ),
}))
vi.mock('../../../../src/renderer/components/dialogs/MCPPluginServerCard', () => ({
    default: ({server, busy, onToggle}: any) => (
        <button
            data-testid={`plugin-card-toggle-${server.id}`}
            data-busy={busy ? '1' : '0'}
            onClick={onToggle}
        >toggle {server.id}</button>
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

/** 受控 Promise：让 IPC 停留在「在飞」状态，精确观测锁生效窗口 */
function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
    return {promise, resolve, reject}
}

beforeEach(() => {
    vi.stubGlobal('electronAPI', {
        mcp: mcpApiMock,
        windowControls: {close: vi.fn()},
    })
    mcpApiMock.setEnabled.mockReset().mockResolvedValue({success: true})
    mcpApiMock.startServer.mockReset().mockResolvedValue({success: true})
    mcpApiMock.stopServer.mockReset().mockResolvedValue({success: true})
    mcpApiMock.switchVersion.mockReset().mockResolvedValue({success: true})
    mockMcpState.setServerEnabledLocal.mockClear()
    mockShowError.mockClear()
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('MCPDialog 渲染层加固：in-flight 锁 / 失败回滚 / 批量持锁', () => {
    it('同一卡片连点两次只触发一次 setEnabled + startServer（in-flight 锁）', async () => {
        const d = deferred<{ success: boolean }>()
        mcpApiMock.setEnabled.mockReturnValueOnce(d.promise)

        render(<MCPDialog />)
        const toggle = await screen.findByTestId('user-card-toggle-server-a')

        // 连点两次：第二次必须被 inFlightRef 同步判重拦下（state 更新是异步的，挡不住同一 tick 连点）
        fireEvent.click(toggle)
        fireEvent.click(toggle)

        await waitFor(() => expect(mcpApiMock.setEnabled).toHaveBeenCalledTimes(1))
        expect(mcpApiMock.setEnabled).toHaveBeenCalledWith('server-a', true)
        // 首次请求仍未返回 → startServer 不应被提前调用
        expect(mcpApiMock.startServer).not.toHaveBeenCalled()

        // 放行首个请求，等待锁清理与后续启动
        await act(async () => { d.resolve({success: true}); await d.promise })
        await waitFor(() => expect(mcpApiMock.startServer).toHaveBeenCalledTimes(1))
        expect(mcpApiMock.startServer).toHaveBeenCalledWith(expect.objectContaining({id: 'server-a'}))
        expect(mcpApiMock.stopServer).not.toHaveBeenCalled()
        expect(mockShowError).not.toHaveBeenCalled()
    })

    it('setEnabled 返回失败时开关回滚本地状态', async () => {
        // 乐观把 enabled=false 翻成 true，但主进程落盘失败
        mcpApiMock.setEnabled.mockResolvedValueOnce({success: false, error: '写盘失败'})

        render(<MCPDialog />)
        const toggle = await screen.findByTestId('user-card-toggle-server-a')
        fireEvent.click(toggle)

        await waitFor(() => expect(mockMcpState.setServerEnabledLocal).toHaveBeenCalledTimes(2))
        // 第一次：乐观置为反值；第二次：回滚为进入函数时捕获的原值
        expect(mockMcpState.setServerEnabledLocal).toHaveBeenNthCalledWith(1, 'server-a', true)
        expect(mockMcpState.setServerEnabledLocal).toHaveBeenNthCalledWith(2, 'server-a', false)
        // 落盘失败后不得继续 start/stop，且必须提示用户
        expect(mcpApiMock.startServer).not.toHaveBeenCalled()
        expect(mcpApiMock.stopServer).not.toHaveBeenCalled()
        await waitFor(() => expect(mockShowError).toHaveBeenCalledTimes(1))
        expect(mockShowError.mock.calls[0][0]).toMatchObject({
            server: expect.objectContaining({id: 'server-a'}),
            errorMessage: '写盘失败',
            action: 'enable',
        })
    })

    it('toggleAll 全量持锁：批量在飞期间单卡片点击被忽略，且卡片显示 busy', async () => {
        const d = deferred<{ success: boolean }>()
        mcpApiMock.setEnabled.mockImplementation((id: string) =>
            id === 'server-a' ? d.promise : Promise.resolve({success: true}))

        render(<MCPDialog />)
        const master = await screen.findByRole('switch')
        // 初始全部 disabled → 点击「全部开启」后批量启用
        fireEvent.click(master)

        await waitFor(() => expect(mcpApiMock.setEnabled).toHaveBeenCalledWith('server-a', true))
        // 批量期间所有目标卡片都应处于 busy（渲染层反馈）
        await waitFor(() =>
            expect(screen.getByTestId('user-card-toggle-server-a').getAttribute('data-busy')).toBe('1'))
        expect(screen.getByTestId('user-card-toggle-server-b').getAttribute('data-busy')).toBe('1')

        // 交叉点击单卡片：必须被锁忽略（否则会与批量打出交叉的 setEnabled）
        fireEvent.click(screen.getByTestId('user-card-toggle-server-a'))
        await act(async () => { await Promise.resolve() })
        expect(mcpApiMock.setEnabled).toHaveBeenCalledTimes(1)

        // 放行批量
        await act(async () => { d.resolve({success: true}); await d.promise })
        await waitFor(() => expect(mcpApiMock.setEnabled).toHaveBeenCalledTimes(2))
        await waitFor(() =>
            expect(screen.getByTestId('user-card-toggle-server-a').getAttribute('data-busy')).toBe('0'))
        expect(mcpApiMock.startServer).toHaveBeenCalledTimes(2)
        expect(mcpApiMock.stopServer).not.toHaveBeenCalled()
    })

    // ─── 本轮活性修复 C：全局互斥 → 按 id 互斥 ────────────────
    it('按 id 互斥：单项在飞时批量开关仍处理其余目标（不再整体静默失效）', async () => {
        const d = deferred<{ success: boolean }>()
        mcpApiMock.setEnabled.mockImplementation((id: string) =>
            id === 'server-a' ? d.promise : Promise.resolve({success: true}))

        render(<MCPDialog />)
        const toggleA = await screen.findByTestId('user-card-toggle-server-a')
        // 单项点 server-a → 进入在飞状态（setEnabled 挂起不返回）
        fireEvent.click(toggleA)
        await waitFor(() => expect(mcpApiMock.setEnabled).toHaveBeenCalledWith('server-a', true))

        // 此刻点「全部开启」：server-a 命中在飞集合应被跳过，server-b 必须照常执行
        fireEvent.click(await screen.findByRole('switch'))

        await waitFor(() => expect(mcpApiMock.setEnabled).toHaveBeenCalledWith('server-b', true))
        // 同一 id 的互斥不放开：server-a 绝不被并发写第二次
        expect(mcpApiMock.setEnabled.mock.calls.filter(c => c[0] === 'server-a')).toHaveLength(1)

        await act(async () => { d.resolve({success: true}); await d.promise })
        await waitFor(() => expect(mcpApiMock.startServer).toHaveBeenCalledTimes(2))
        expect(mcpApiMock.startServer).toHaveBeenCalledWith(expect.objectContaining({id: 'server-a'}))
        expect(mcpApiMock.startServer).toHaveBeenCalledWith(expect.objectContaining({id: 'server-b'}))
    })
})
