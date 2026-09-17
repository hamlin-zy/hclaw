// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, waitFor} from '@testing-library/react'
// 必须置于被测组件 import 之前：vi.mock 工厂在组件模块图求值时执行，
// 工厂内引用的 mockZustandStore 需已完成初始化（vitest 按 import 顺序求值）。
import {mockZustandStore, stubElectronAPI} from '../../../helpers/settingsStoreMock'
import AgentTab from '../../../../../src/renderer/components/settings/tabs/AgentTab'

// ── 依赖 mock ──────────────────────────────────────────
// 沿用 ScheduleEditModal.capability.test.tsx 的 mockZustandStore 模式。
// 验证点：交接引导阈值提供显式「关闭」开关（ratio=0 = 关闭引导），
// 关闭时数值输入禁用，重新开启恢复默认 50%。
// T20 迁移自 dialogs/SettingsDialog.handoffToggle.test.tsx（旧壳 → 新 tabs/AgentTab 直渲染）。

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
            resetFieldsToDefault: vi.fn(),
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

vi.mock('../../../../../src/renderer/stores/settingsStore', () => ({
    useSettingsStore: mockZustandStore(() => mockSettingsState.current),
}))
vi.mock('../../../../../src/renderer/stores/themeStore', () => ({
    useThemeStore: mockZustandStore(() => ({theme: 'light'})),
}))

beforeEach(() => {
    mockSettingsState.set(makeSettingsState(0.5))
    stubElectronAPI()
})

afterEach(() => {
    vi.unstubAllGlobals()
})

// 新壳下 Tab 已拆为独立组件，直接渲染 AgentTab（无侧栏 Tab 点击步骤）
async function renderAgentTab(expectLabel = '交接引导阈值') {
    render(<AgentTab/>)
    await waitFor(() => expect(screen.getByText(expectLabel)).toBeTruthy())
}

// 交接阈值两字段均为 NumberField（label htmlFor + useId 关联），用 getByLabelText 定位输入框。
// 注：label 内容含 InfoTip 的 sr-only 说明文本，精确串匹配会落空（T20 已实测），故用锚定正则；
// 锚定是必需的——非锚定的 /交接引导/ 会连带命中 FormRow 的「交接引导」开关（aria-label）。
function getHandoffInput(): HTMLInputElement {
    return screen.getByLabelText(/^交接引导阈值/) as HTMLInputElement
}

function getTokenInput(): HTMLInputElement {
    return screen.getByLabelText(/^交接阈值大小/) as HTMLInputElement
}

describe('AgentTab：交接引导阈值关闭开关', () => {
    it('默认启用：开关为开，数值输入可用', async () => {
        await renderAgentTab()
        const sw = screen.getByRole('switch', {name: /交接引导/}) as HTMLButtonElement
        expect(sw.getAttribute('aria-checked')).toBe('true')
        expect(getHandoffInput().disabled).toBe(false)
    })

    it('点击关闭 → updatePending 写入 0（关闭引导），数值输入禁用', async () => {
        await renderAgentTab()
        const sw = screen.getByRole('switch', {name: /交接引导/})
        fireEvent.click(sw)
        expect(mockSettingsState.current.updatePending).toHaveBeenCalledWith(
            'agent', expect.objectContaining({handoffThresholdRatio: 0}),
        )
        // 关闭态的输入禁用由 test 3（ratio=0 初始渲染）覆盖
    })

    it('已关闭状态（ratio=0）：开关为关、输入禁用；点击开启恢复 50%', async () => {
        mockSettingsState.set(makeSettingsState(0))
        await renderAgentTab()
        const sw = screen.getByRole('switch', {name: /交接引导/}) as HTMLButtonElement
        expect(sw.getAttribute('aria-checked')).toBe('false')
        expect(getHandoffInput().disabled).toBe(true)

        fireEvent.click(sw)
        expect(mockSettingsState.current.updatePending).toHaveBeenCalledWith(
            'agent', expect.objectContaining({handoffThresholdRatio: 0.5}),
        )
    })
})

describe('AgentTab：交接阈值模式（按比例 / 按窗口大小）', () => {
    it('默认按比例：显示百分比输入，隐藏 K 输入', async () => {
        await renderAgentTab()
        expect(screen.getByText('交接引导阈值')).toBeTruthy()
        expect(screen.queryByText('交接阈值大小')).toBeNull()
    })

    it('按窗口大小：显示 K 输入（默认 200K，min=50），隐藏百分比输入', async () => {
        mockSettingsState.set(makeSettingsState(0.5, {handoffThresholdMode: 'tokens'}))
        await renderAgentTab('交接阈值大小')
        const input = getTokenInput()
        expect(input.value).toBe('200')
        expect(input.min).toBe('50')
        expect(input.disabled).toBe(false)
        expect(screen.queryByText('交接引导阈值')).toBeNull()
    })

    it('按窗口大小：低于 50 的输入兜底为 50K', async () => {
        mockSettingsState.set(makeSettingsState(0.5, {handoffThresholdMode: 'tokens'}))
        await renderAgentTab('交接阈值大小')
        fireEvent.change(getTokenInput(), {target: {value: '10'}})
        expect(mockSettingsState.current.updatePending).toHaveBeenCalledWith(
            'agent', expect.objectContaining({handoffThresholdTokens: 50_000}),
        )
    })

    it('按窗口大小模式：总开关关闭（ratio=0）时 K 输入禁用', async () => {
        mockSettingsState.set(makeSettingsState(0, {handoffThresholdMode: 'tokens'}))
        await renderAgentTab('交接阈值大小')
        expect(getTokenInput().disabled).toBe(true)
    })
})
