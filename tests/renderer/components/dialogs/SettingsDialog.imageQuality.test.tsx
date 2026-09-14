// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, waitFor} from '@testing-library/react'
import SettingsDialog from '../../../../src/renderer/components/dialogs/SettingsDialog'

// 验证：模型参数 tab 提供「图片压缩质量」滑杆 + 数字框，onChange 走 updatePending('model', …)。
const {mockSettingsState, makeSettingsState} = vi.hoisted(() => {
    function makeSettingsState(imageCompressQuality: number) {
        const model = {defaultMaxTokens: 50000, defaultTemperature: 0, imageCompressQuality}
        const agent = {defaultPermissionMode: 'safe', defaultDisplayMode: 'detailed'}
        return {
            settings: {ui: {}, model, agent},
            pendingSettings: {ui: {}, model: {...model}, agent: {...agent}},
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
    let state = makeSettingsState(85)
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
    mockSettingsState.set(makeSettingsState(85))
    vi.stubGlobal('electronAPI', {
        configGetHclawDir: vi.fn().mockResolvedValue(''),
        backgroundList: vi.fn().mockResolvedValue([]),
        applyThemeClass: vi.fn(),
    })
})

afterEach(() => {
    vi.unstubAllGlobals()
})

async function openModelTab() {
    render(<SettingsDialog/>)
    await waitFor(() => expect(screen.getByRole('button', {name: /模型参数/})).toBeTruthy())
    fireEvent.click(screen.getByRole('button', {name: /模型参数/}))
    await waitFor(() => expect(screen.getByText('图片压缩质量 (imageCompressQuality)')).toBeTruthy())
}

function getQualityRange(): HTMLInputElement {
    const label = screen.getByText('图片压缩质量 (imageCompressQuality)')
    return label.parentElement!.querySelector('input[type="range"]') as HTMLInputElement
}

describe('SettingsDialog：图片压缩质量', () => {
    it('控件存在：滑杆+数字框，范围 1-100、步长 1、默认 85', async () => {
        await openModelTab()
        const range = getQualityRange()
        expect(range.value).toBe('85')
        expect(range.min).toBe('1')
        expect(range.max).toBe('100')
        expect(range.step).toBe('1')
    })

    it('拖动滑杆 → updatePending("model", {imageCompressQuality})', async () => {
        await openModelTab()
        fireEvent.change(getQualityRange(), {target: {value: '40'}})
        expect(mockSettingsState.current.updatePending).toHaveBeenCalledWith(
            'model', expect.objectContaining({imageCompressQuality: 40}),
        )
    })

    it('数字框输入超界 → clamp 到 100', async () => {
        await openModelTab()
        const label = screen.getByText('图片压缩质量 (imageCompressQuality)')
        const number = label.parentElement!.querySelector('input[type="number"]') as HTMLInputElement
        fireEvent.change(number, {target: {value: '150'}})
        expect(mockSettingsState.current.updatePending).toHaveBeenCalledWith(
            'model', expect.objectContaining({imageCompressQuality: 100}),
        )
    })
})
