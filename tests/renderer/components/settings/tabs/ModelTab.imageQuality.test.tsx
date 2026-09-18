// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, waitFor} from '@testing-library/react'
// 必须置于被测组件 import 之前：vi.mock 工厂在组件模块图求值时执行，
// 工厂内引用的 mockZustandStore 需已完成初始化（vitest 按 import 顺序求值）。
import {mockZustandStore, stubElectronAPI} from '../../../helpers/settingsStoreMock'
import ModelTab from '../../../../../src/renderer/components/settings/tabs/ModelTab'

// 验证：模型参数 tab 提供「图片压缩质量」滑杆 + 数字框，onChange 走 updatePending('model', …)。
// T20 迁移自 dialogs/SettingsDialog.imageQuality.test.tsx（旧壳 → 新 tabs/ModelTab 直渲染）。
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
            resetFieldsToDefault: vi.fn(),
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

vi.mock('../../../../../src/renderer/stores/settingsStore', () => ({
    useSettingsStore: mockZustandStore(() => mockSettingsState.current),
}))
vi.mock('../../../../../src/renderer/stores/themeStore', () => ({
    useThemeStore: mockZustandStore(() => ({theme: 'light'})),
}))

beforeEach(() => {
    mockSettingsState.set(makeSettingsState(85))
    stubElectronAPI()
})

afterEach(() => {
    vi.unstubAllGlobals()
})

// 新壳下 Tab 已拆为独立组件，直接渲染 ModelTab（无侧栏 Tab 点击步骤）
async function renderModelTab() {
    render(<ModelTab/>)
    await waitFor(() => expect(screen.getByText('图片压缩质量')).toBeTruthy())
}

// 导航保持 label.parentElement 定位：新 ModelTab 该组 label 无 htmlFor，且 range/number
// 双控件共用同一 aria-label「图片压缩质量」，getByLabelText 会歧义命中两个元素（T20 已核验）。
function getQualityRange(): HTMLInputElement {
    const label = screen.getByText('图片压缩质量')
    return label.parentElement!.querySelector('input[type="range"]') as HTMLInputElement
}

function getQualityNumber(): HTMLInputElement {
    const label = screen.getByText('图片压缩质量')
    return label.parentElement!.querySelector('input[type="number"]') as HTMLInputElement
}

describe('ModelTab：图片压缩质量', () => {
    it('控件存在：滑杆+数字框，范围 1-100、步长 1、默认 85', async () => {
        await renderModelTab()
        const range = getQualityRange()
        expect(range.value).toBe('85')
        expect(range.min).toBe('1')
        expect(range.max).toBe('100')
        expect(range.step).toBe('1')
    })

    it('拖动滑杆 → updatePending("model", {imageCompressQuality})', async () => {
        await renderModelTab()
        fireEvent.change(getQualityRange(), {target: {value: '40'}})
        expect(mockSettingsState.current.updatePending).toHaveBeenCalledWith(
            'model', expect.objectContaining({imageCompressQuality: 40}),
        )
    })

    it('数字框输入超界 → clamp 到 100', async () => {
        await renderModelTab()
        fireEvent.change(getQualityNumber(), {target: {value: '150'}})
        expect(mockSettingsState.current.updatePending).toHaveBeenCalledWith(
            'model', expect.objectContaining({imageCompressQuality: 100}),
        )
    })
})
