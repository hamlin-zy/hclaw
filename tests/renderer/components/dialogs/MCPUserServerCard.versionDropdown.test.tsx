// @vitest-environment jsdom
/**
 * MCPUserServerCard 版本下拉测试（Task 5）
 *
 * 独立成文件而不是并入 MCPDialog.toggle.test.tsx：
 *   MCPDialog.toggle.test.tsx 顶层通过 vi.mock(...) 将 MCPUserServerCard 替换成
 *   `<div data-testid="user-server-card">`，这是为了让 MCPDialog 冒烟/toggleAll/toast 测试
 *   脱离卡片依赖链。Vitest 的 vi.unmock 会被强制 hoist 到文件顶层，且同一文件里
 *   vi.mock 与 vi.unmock 不能共存，所以无法在同一文件里既让 MCPDialog 走 mock、又让 card 走 real。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, waitFor} from '@testing-library/react'
import type {MCPServer} from '@shared/types'

const mcpApiMock = vi.hoisted(() => ({
    switchVersion: vi.fn().mockResolvedValue({success: true}),
}))

// versionMeta 由 useMcpUpdateStore 的 mock 依赖；tests 可直接改写其 server-a 条目
const mockVersionMeta = vi.hoisted(() => ({
    'server-a': {
        current: '1.0.0',
        latest: '2.0.0',
        hasUpdate: true,
        sourceType: 'npx',
        lastChecked: Date.now(),
        availableVersions: ['1.0.0', '1.1.0', '2.0.0'],
    },
}))

vi.mock('../../../../src/renderer/stores/mcpUpdateStore', () => ({
    useMcpUpdateStore: (selector?: (s: unknown) => unknown) => {
        const state = {versionMeta: mockVersionMeta}
        return selector ? selector(state) : state
    },
}))

vi.mock('../../../../src/renderer/components/ConfirmDialog', () => ({
    default: () => null,
    // Match the real ConfirmDialog.handleConfirm contract: call options.onConfirm() when user confirms, then resolve true.
    // Without invoking onConfirm, the switchVersion side effects inside onConfirm never fire in tests.
    confirm: async (options: {onConfirm?: () => void | Promise<void>}) => {
        if (typeof options?.onConfirm === 'function') {
            try {
                await options.onConfirm()
            } catch {
                // swallow — caller (handleVersionSwitch) already guards
            }
        }
        return true
    },
}))

vi.mock('../../../../src/renderer/components/common/Switch', () => ({
    Switch: ({checked, disabled}: {checked?: boolean, disabled?: boolean}) => (
        <button role="switch" aria-checked={checked} disabled={disabled} />
    ),
}))

vi.mock('../../../../src/renderer/components/dialogs/MCPUtils', () => ({
    statusDotClasses: () => 'bg-green-400',
    transportColorClasses: () => 'text-gray-400 border border-gray-200',
    buildMcpConfigJson: () => '{}',
}))

vi.mock('../../../../src/renderer/components/common/CopyButton', () => ({
    CopyButton: () => <button data-testid="copy-btn" />,
}))

// ThemedSelect 是自定义 dropdown（button + portal listbox），
// 本测试聚焦于卡片与 electronAPI.switchVersion 的联动契约，
// 故 mock 为原生 <select>，让 fireEvent.change 与 getByRole('option') 生效。
// 版本下拉顺序按 MCPUserServerCard 内部 .reverse() 反转后的结果断言（最新在上）。
vi.mock('../../../../src/renderer/components/ThemedSelect', () => ({
    default: ({value, options, onChange, disabled, ariaLabel}: {
        value: string
        options: {value: string, label: string}[]
        onChange: (v: string) => void
        disabled?: boolean
        ariaLabel?: string
    }) => (
        <select
            aria-label={ariaLabel}
            disabled={disabled}
            value={value}
            onChange={e => onChange(e.target.value)}
        >
            {options.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
            ))}
        </select>
    ),
}))

beforeEach(() => {
    vi.stubGlobal('electronAPI', {
        mcp: mcpApiMock,
    })
    mcpApiMock.switchVersion.mockClear()
    mcpApiMock.switchVersion.mockResolvedValue({success: true})
    // Reset default versionMeta
    mockVersionMeta['server-a'] = {
        current: '1.0.0',
        latest: '2.0.0',
        hasUpdate: true,
        sourceType: 'npx',
        lastChecked: Date.now(),
        availableVersions: ['1.0.0', '1.1.0', '2.0.0'],
    }
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('MCPUserServerCard 版本下拉（Task 5）', () => {
    const serverWithVersions: MCPServer = {
        id: 'server-a',
        name: 'Server A',
        transport: 'stdio',
        status: 'connected',
        tools: [],
        enabled: true,
        command: 'npx',
        args: ['@scope/pkg@1.0.0'],
        env: {},
        url: '',
        headers: {},
        cwd: '',
        timeout: 60000,
        autoApprove: [],
        denyList: [],
        userDescription: '',
    }
    const noopHandlers = {
        onToggle: () => {},
        onEdit: () => {},
        onDelete: () => {},
        onShowTools: () => {},
        onReconnect: () => {},
    }

    it('renders version dropdown when availableVersions is non-empty', async () => {
        const {default: MCPUserServerCard} = await import(
            '../../../../src/renderer/components/dialogs/MCPUserServerCard'
        )
        render(<MCPUserServerCard server={serverWithVersions} {...noopHandlers} />)
        const select = screen.getByRole('combobox')
        expect(select).toBeTruthy()
        // 组件内部 .reverse() 反转主进程升序返回，"最新在上"
        expect(screen.getAllByRole('option').map(o => o.textContent)).toEqual([
            '2.0.0 (latest)',
            '1.1.0',
            '1.0.0',
        ])
        // Static "current / latest" text is NOT rendered when dropdown is shown
        expect(screen.queryByText('1.0.0 / 2.0.0')).toBeNull()
    })

    it('renders static text when availableVersions is empty', async () => {
        mockVersionMeta['server-a'] = {
            current: '1.0.0',
            latest: '2.0.0',
            hasUpdate: true,
            sourceType: 'npx',
            lastChecked: Date.now(),
            availableVersions: [],
        }
        const {default: MCPUserServerCard} = await import(
            '../../../../src/renderer/components/dialogs/MCPUserServerCard'
        )
        render(<MCPUserServerCard server={serverWithVersions} {...noopHandlers} />)
        expect(screen.queryByRole('combobox')).toBeNull()
        expect(screen.getByText('1.0.0 / 2.0.0')).toBeTruthy()
    })

    it('dispatches hclaw:show-toast success after switchVersion resolves', async () => {
        mockVersionMeta['server-a'] = {
            current: '1.0.0',
            latest: '2.0.0',
            hasUpdate: true,
            sourceType: 'npx',
            lastChecked: Date.now(),
            availableVersions: ['1.0.0', '1.1.0', '2.0.0'],
        }
        mcpApiMock.switchVersion.mockResolvedValue({success: true})
        const {default: MCPUserServerCard} = await import(
            '../../../../src/renderer/components/dialogs/MCPUserServerCard'
        )
        render(<MCPUserServerCard server={serverWithVersions} {...noopHandlers} />)
        const select = screen.getByRole('combobox') as HTMLSelectElement

        const toastSpy = vi.fn()
        window.addEventListener('hclaw:show-toast', toastSpy)
        try {
            fireEvent.change(select, {target: {value: '2.0.0'}})
            await waitFor(() => expect(mcpApiMock.switchVersion).toHaveBeenCalledWith('server-a', '2.0.0'))
            await waitFor(() => expect(toastSpy).toHaveBeenCalled())
            const detail = toastSpy.mock.calls[0][0].detail
            expect(detail.type).toBe('success')
            expect(detail.message).toContain('已切换到 2.0.0')
        } finally {
            window.removeEventListener('hclaw:show-toast', toastSpy)
        }
    })

    it('dispatches hclaw:show-toast error when switchVersion returns success:false', async () => {
        mockVersionMeta['server-a'] = {
            current: '1.0.0',
            latest: '2.0.0',
            hasUpdate: true,
            sourceType: 'npx',
            lastChecked: Date.now(),
            availableVersions: ['1.0.0', '2.0.0'],
        }
        mcpApiMock.switchVersion.mockResolvedValue({success: false, error: 'oops'})
        const {default: MCPUserServerCard} = await import(
            '../../../../src/renderer/components/dialogs/MCPUserServerCard'
        )
        render(<MCPUserServerCard server={serverWithVersions} {...noopHandlers} />)
        const select = screen.getByRole('combobox') as HTMLSelectElement

        const toastSpy = vi.fn()
        window.addEventListener('hclaw:show-toast', toastSpy)
        try {
            fireEvent.change(select, {target: {value: '2.0.0'}})
            await waitFor(() => expect(mcpApiMock.switchVersion).toHaveBeenCalledWith('server-a', '2.0.0'))
            await waitFor(() => expect(toastSpy).toHaveBeenCalled())
            const detail = toastSpy.mock.calls[0][0].detail
            expect(detail.type).toBe('error')
            expect(detail.message).toContain('切换失败')
            expect(detail.message).toContain('oops')
        } finally {
            window.removeEventListener('hclaw:show-toast', toastSpy)
        }
    })

    it('swallows thrown error from switchVersion invoke (Task 4 reviewer ⚠️)', async () => {
        mockVersionMeta['server-a'] = {
            current: '1.0.0',
            latest: '2.0.0',
            hasUpdate: true,
            sourceType: 'npx',
            lastChecked: Date.now(),
            availableVersions: ['1.0.0', '2.0.0'],
        }
        mcpApiMock.switchVersion.mockRejectedValue(new Error('boom'))
        const {default: MCPUserServerCard} = await import(
            '../../../../src/renderer/components/dialogs/MCPUserServerCard'
        )
        const {unmount} = render(<MCPUserServerCard server={serverWithVersions} {...noopHandlers} />)
        const select = screen.getByRole('combobox') as HTMLSelectElement

        const toastSpy = vi.fn()
        window.addEventListener('hclaw:show-toast', toastSpy)
        try {
            expect(() => fireEvent.change(select, {target: {value: '2.0.0'}})).not.toThrow()
            await waitFor(() => expect(toastSpy).toHaveBeenCalled())
            const detail = toastSpy.mock.calls[0][0].detail
            expect(detail.type).toBe('error')
            expect(detail.message).toContain('切换失败')
            expect(detail.message).toContain('boom')
        } finally {
            window.removeEventListener('hclaw:show-toast', toastSpy)
            unmount()
        }
    })
})
