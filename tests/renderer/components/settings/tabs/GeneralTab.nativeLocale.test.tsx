// @vitest-environment jsdom
/**
 * 母语下拉（系统设置 → 语言）：选项收敛为「跟随系统(简体中文) / 简体中文 / 英语」
 *
 * 契约（用户拍板）：
 * - 下拉恰好 3 项，缺省 mode 即「跟随系统」；
 * - 标签格式 `跟随系统(${系统语言})`，系统语言取自主进程经窗口 argv 传入的 systemLocale，
 *   取不到时回退 nativeLocale 快照；
 * - 切回「跟随系统」时同步把 nativeLocale 对齐系统语言（否则本次会话母语停留在被放弃的旧值）；
 * - 手选写 mode='manual' + locale，跟随写 mode='system'。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, waitFor} from '@testing-library/react'
import {mockZustandStore} from '../../../helpers/settingsStoreMock'
import GeneralTab from '../../../../../src/renderer/components/settings/tabs/GeneralTab'

const {mockSettingsState, makeSettingsState} = vi.hoisted(() => {
    function makeSettingsState(language: Record<string, unknown> = {}) {
        const settings = {
            ui: {},
            language,
            agent: {defaultPermissionMode: 'safe' as const, defaultDisplayMode: 'detailed' as const},
            linkOpening: {mode: 'ask' as const},
            shortcuts: {overrides: {}},
        }
        return {
            settings,
            pendingSettings: null as typeof settings | null,
            isDirty: false,
            updatePending: vi.fn(),
            updateSettings: vi.fn(),
            saveSettings: vi.fn().mockResolvedValue(undefined),
            discardChanges: vi.fn(),
            resetFieldsToDefault: vi.fn(),
            resetAllToDefault: vi.fn(),
        }
    }
    let state = makeSettingsState()
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

/** window.electronAPI stub：systemLocale 模拟主进程 argv 传入的系统语言（缺省为空串 = 未就绪） */
function stubAPI(systemLocale?: string) {
    vi.stubGlobal('electronAPI', {
        configGetHclawDir: vi.fn().mockResolvedValue(''),
        systemLocale,
    })
}

beforeEach(() => {
    mockSettingsState.set(makeSettingsState())
    stubAPI('zh-CN')
})

afterEach(() => {
    vi.unstubAllGlobals()
})

async function renderTab() {
    render(<GeneralTab/>)
    await waitFor(() => expect(screen.getByRole('button', {name: '母语'})).toBeTruthy())
}

function triggerText(): string {
    return screen.getByRole('button', {name: '母语'}).textContent ?? ''
}

function openDropdown() {
    fireEvent.click(screen.getByRole('button', {name: '母语'}))
}

function optionLabels(): string[] {
    return screen.getAllByRole('option').map(o => o.textContent ?? '')
}

// 精确匹配优先：'简体中文' 不能被「跟随系统(简体中文)」用 includes 抢先命中
function clickOption(label: string) {
    const opts = screen.getAllByRole('option')
    const target = opts.find(o => (o.textContent ?? '') === label)
        ?? opts.find(o => (o.textContent ?? '').includes(label))
    if (!target) throw new Error(`未找到选项：${label}，实际为 ${JSON.stringify(optionLabels())}`)
    fireEvent.click(target)
}

describe('GeneralTab：母语下拉', () => {
    it('缺省（无 nativeLocaleMode）→ 显示「跟随系统(简体中文)」，恰好 3 个选项', async () => {
        await renderTab()
        expect(triggerText()).toContain('跟随系统(简体中文)')
        openDropdown()
        expect(optionLabels()).toEqual(['跟随系统(简体中文)', '简体中文', 'English'])
    })

    it('systemLocale 不可得（app 未 ready）→ 回退 nativeLocale 快照，不渲染 (undefined)', async () => {
        stubAPI(undefined)
        mockSettingsState.set(makeSettingsState({nativeLocale: 'ja-JP'}))
        await renderTab()
        expect(triggerText()).toContain('跟随系统(日本語)')
    })

    it('系统语言表外（fr-FR）→ 标签用原始 locale 串兜底', async () => {
        stubAPI('fr-FR')
        await renderTab()
        expect(triggerText()).toContain('跟随系统(Français)')
    })

    it('手选（manual）→ 显示所选语言本身，而非「跟随系统」', async () => {
        mockSettingsState.set(makeSettingsState({nativeLocaleMode: 'manual', nativeLocale: 'en'}))
        await renderTab()
        expect(triggerText()).toContain('English')
        expect(triggerText()).not.toContain('跟随系统')
    })

    it('切回「跟随系统」→ 同时写 mode=system 与 nativeLocale=系统语言（本会话立即生效）', async () => {
        mockSettingsState.set(makeSettingsState({nativeLocaleMode: 'manual', nativeLocale: 'en'}))
        await renderTab()
        openDropdown()
        clickOption('跟随系统')
        expect(mockSettingsState.current.updatePending).toHaveBeenCalledWith(
            'language', {nativeLocaleMode: 'system', nativeLocale: 'zh-CN'},
        )
    })

    it('系统语言不可得时切回跟随 → 只写 mode，不写入空 locale', async () => {
        stubAPI(undefined)
        mockSettingsState.set(makeSettingsState({nativeLocaleMode: 'manual', nativeLocale: 'en'}))
        await renderTab()
        openDropdown()
        clickOption('跟随系统')
        expect(mockSettingsState.current.updatePending).toHaveBeenCalledWith(
            'language', {nativeLocaleMode: 'system'},
        )
    })

    it('手选简体中文 → 写 mode=manual + nativeLocale=zh-CN', async () => {
        await renderTab()
        openDropdown()
        clickOption('简体中文')
        expect(mockSettingsState.current.updatePending).toHaveBeenCalledWith(
            'language', {nativeLocaleMode: 'manual', nativeLocale: 'zh-CN'},
        )
    })

    it('手选到表外 locale（老数据 ja）→ 动态追加保留该项，避免下拉无匹配项显示空白', async () => {
        mockSettingsState.set(makeSettingsState({nativeLocaleMode: 'manual', nativeLocale: 'ja'}))
        await renderTab()
        openDropdown()
        expect(optionLabels()).toEqual(['跟随系统(简体中文)', '简体中文', 'English', '日本語'])
    })
})
