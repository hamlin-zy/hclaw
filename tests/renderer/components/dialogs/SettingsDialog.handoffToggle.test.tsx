// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, waitFor} from '@testing-library/react'
import SettingsDialog from '../../../../src/renderer/components/dialogs/SettingsDialog'

// ── 依赖 mock ──────────────────────────────────────────
// 沿用 ScheduleEditModal.capability.test.tsx 的 mockZustandStore 模式。
// 验证点：交接引导阈值提供显式「关闭」开关（ratio=0 = 关闭引导），
// 关闭时数值输入禁用，重新开启恢复默认 50%。

const {mockSettingsState, makeSettingsState} = vi.hoisted(() => {
    function makeSettingsState(ratio: number, extraAgent: Record<string, unknown> = {}) {
        const agent = {
            maxTurns: 500, retryCount: 10, initialRetryDelay: 5000, maxRetryDelay: 120000,
            llmTimeout: 600000, compactThreshold: 700000, handoffThresholdRatio: ratio,
            ...extraAgent,
        }
        return {
            settings: {ui: {}, agent},
            pendingSettings: {ui: {}, agent: {...agent}},
            isDirty: false,
            saving: false,
            updatePending: vi.fn((category: string, patch: Record<string, unknown>) => {
                state.pendingSettings = {
                    ...state.pendingSettings,
                    [category]: {...(state.pendingSettings as any)[category], ...patch},
                } as never
            }),
            saveSettings: vi.fn().mockResolvedValue(undefined),
            discardChanges: vi.fn(),
            resetCategoryToDefault: vi.fn(),
            resetAllToDefault: vi.fn(),
        }
    }
    let state = makeSettingsState(0.5)
    const mockSettingsState = {
        get current() { return state },
        set(s: ReturnType<typeof makeSettingsState>) { state = s },
    }
    return {mockSettingsState, makeSettingsState}
})

function mockZustandStore(getState: () => Record<string, unknown>) {
    const hook = (selector?: (s: any) => unknown) => {
        const s = getState()
        return selector ? selector(s) : s
    }
    ;(hook as any).getState = getState
    return hook
}

vi.mock('../../../../src/renderer/stores/settingsStore', () => ({
    useSettingsStore: mockZustandStore(() => mockSettingsState.current),
}))
vi.mock('../../../../src/renderer/stores/themeStore', () => ({
    useThemeStore: mockZustandStore(() => ({theme: 'light'})),
}))

beforeEach(() => {
    mockSettingsState.set(makeSettingsState(0.5))
    vi.stubGlobal('electronAPI', {
        configGetHclawDir: vi.fn().mockResolvedValue(''),
        backgroundList: vi.fn().mockResolvedValue([]),
        applyThemeClass: vi.fn(),
    })
})

afterEach(() => {
    vi.unstubAllGlobals()
})

async function openAgentTab(expectLabel = '交接引导阈值 (%)') {
    render(<SettingsDialog/>)
    await waitFor(() => expect(screen.getByRole('button', {name: /Agent 运行/})).toBeTruthy())
    fireEvent.click(screen.getByRole('button', {name: /Agent 运行/}))
    await waitFor(() => expect(screen.getByText(expectLabel)).toBeTruthy())
}

function getHandoffInput(): HTMLInputElement {
    const label = screen.getByText('交接引导阈值 (%)')
    return label.parentElement!.querySelector('input') as HTMLInputElement
}

describe('SettingsDialog：交接引导阈值关闭开关', () => {
    it('默认启用：开关为开，数值输入可用', async () => {
        await openAgentTab()
        const sw = screen.getByRole('switch', {name: /交接引导/}) as HTMLButtonElement
        expect(sw.getAttribute('aria-checked')).toBe('true')
        expect(getHandoffInput().disabled).toBe(false)
    })

    it('点击关闭 → updatePending 写入 0（关闭引导），数值输入禁用', async () => {
        await openAgentTab()
        const sw = screen.getByRole('switch', {name: /交接引导/})
        fireEvent.click(sw)
        expect(mockSettingsState.current.updatePending).toHaveBeenCalledWith(
            'agent', expect.objectContaining({handoffThresholdRatio: 0}),
        )
        // 关闭态的输入禁用由 test 3（ratio=0 初始渲染）覆盖
    })

    it('已关闭状态（ratio=0）：开关为关、输入禁用；点击开启恢复 50%', async () => {
        mockSettingsState.set(makeSettingsState(0))
        await openAgentTab()
        const sw = screen.getByRole('switch', {name: /交接引导/}) as HTMLButtonElement
        expect(sw.getAttribute('aria-checked')).toBe('false')
        expect(getHandoffInput().disabled).toBe(true)

        fireEvent.click(sw)
        expect(mockSettingsState.current.updatePending).toHaveBeenCalledWith(
            'agent', expect.objectContaining({handoffThresholdRatio: 0.5}),
        )
    })
})

describe('SettingsDialog：交接阈值模式（按比例 / 按窗口大小）', () => {
    function getTokenInput(): HTMLInputElement {
        const label = screen.getByText('交接阈值大小 (K)')
        return label.parentElement!.querySelector('input') as HTMLInputElement
    }

    it('默认按比例：显示百分比输入，隐藏 K 输入', async () => {
        await openAgentTab()
        expect(screen.getByText('交接引导阈值 (%)')).toBeTruthy()
        expect(screen.queryByText('交接阈值大小 (K)')).toBeNull()
    })

    it('按窗口大小：显示 K 输入（默认 200K，min=50），隐藏百分比输入', async () => {
        mockSettingsState.set(makeSettingsState(0.5, {handoffThresholdMode: 'tokens'}))
        await openAgentTab('交接阈值大小 (K)')
        const input = getTokenInput()
        expect(input.value).toBe('200')
        expect(input.min).toBe('50')
        expect(input.disabled).toBe(false)
        expect(screen.queryByText('交接引导阈值 (%)')).toBeNull()
    })

    it('按窗口大小：低于 50 的输入兜底为 50K', async () => {
        mockSettingsState.set(makeSettingsState(0.5, {handoffThresholdMode: 'tokens'}))
        await openAgentTab('交接阈值大小 (K)')
        fireEvent.change(getTokenInput(), {target: {value: '10'}})
        expect(mockSettingsState.current.updatePending).toHaveBeenCalledWith(
            'agent', expect.objectContaining({handoffThresholdTokens: 50_000}),
        )
    })

    it('按窗口大小模式：总开关关闭（ratio=0）时 K 输入禁用', async () => {
        mockSettingsState.set(makeSettingsState(0, {handoffThresholdMode: 'tokens'}))
        await openAgentTab('交接阈值大小 (K)')
        expect(getTokenInput().disabled).toBe(true)
    })
})
