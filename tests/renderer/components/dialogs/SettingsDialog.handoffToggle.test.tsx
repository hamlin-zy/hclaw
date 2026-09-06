// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, waitFor} from '@testing-library/react'
import SettingsDialog from '../../../../src/renderer/components/dialogs/SettingsDialog'

// ── 依赖 mock ──────────────────────────────────────────
// 沿用 ScheduleEditModal.capability.test.tsx 的 mockZustandStore 模式。
// 验证点：交接引导阈值提供显式「关闭」开关（ratio=0 = 关闭引导），
// 关闭时数值输入禁用，重新开启恢复默认 50%。

const {mockSettingsState, makeSettingsState} = vi.hoisted(() => {
    function makeSettingsState(ratio: number) {
        return {
            settings: {
                ui: {},
                agent: {
                    maxTurns: 500, retryCount: 10, initialRetryDelay: 5000, maxRetryDelay: 120000,
                    llmTimeout: 600000, compactThreshold: 700000, handoffThresholdRatio: ratio,
                },
            },
            pendingSettings: {
                ui: {},
                agent: {
                    maxTurns: 500, retryCount: 10, initialRetryDelay: 5000, maxRetryDelay: 120000,
                    llmTimeout: 600000, compactThreshold: 700000, handoffThresholdRatio: ratio,
                },
            },
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

async function openAgentTab() {
    render(<SettingsDialog/>)
    await waitFor(() => expect(screen.getByRole('button', {name: /Agent 运行/})).toBeTruthy())
    fireEvent.click(screen.getByRole('button', {name: /Agent 运行/}))
    await waitFor(() => expect(screen.getByText('交接引导阈值 (%)')).toBeTruthy())
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
