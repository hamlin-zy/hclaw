// @vitest-environment jsdom
/**
 * S4 强制深色路径的 ui 合并保留（F4 护栏）。
 *
 * `SettingsDialog.test.tsx` 以**文件级 `vi.mock`** 整体替换 `useSettingsStore`（mockHook），
 * 其 S4 用例只能断言 `updatePending('ui', {theme:'dark'})` 的**调用参数**；
 * 「真实 store 的合并语义是否把同一 `ui` 分类里的其余字段（background.enabled / imagePath /
 * overlay / blur）吞掉」此前只由阅读 `settingsStore.updatePending` 确认，无测试看守。
 * 本文件走**真实 store**，断言最终**写库载荷**（`configWrite('settings', …)`），
 * 即「强制深色」只增量改写 theme，不整块替换 `ui`。
 *
 * 与 `SettingsDialog.test.tsx` 的一致处 / 差异（有意为之）：
 * - 六个 Tab 仍以占位组件 mock：被测逻辑在壳层 `handleSave` + `store.updatePending`，Tab 内容无关；
 * - `settingsStore` / `themeStore` 均**不 mock**（取真实模块）——这正是被测对象与合并基座所在。
 *
 * 状态注入取「①让真实加载链路带入」：`configRead('settings')` 返回带哨兵的定制 settings，
 * 挂载时的真实 `loadSettings` 把它合并进 store；`pendingSettings` 保持 null，
 * 因此 `handleSave` 的 `base = pendingSettings ?? settings` 走的是 **settings 基座**分支
 * （该分支在 mock 版用例里不可达，见 SettingsDialog.tsx:143 注释）。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, cleanup, waitFor, act} from '@testing-library/react'
import {DEFAULT_SETTINGS} from '@shared/settingsDefaults'

vi.mock('../../../../src/renderer/components/settings/tabs/GeneralTab', () => ({default: () => <div>GENERAL_TAB</div>}))
vi.mock('../../../../src/renderer/components/settings/tabs/AppearanceTab', () => ({default: () => <div>APPEARANCE_TAB</div>}))
vi.mock('../../../../src/renderer/components/settings/tabs/AgentTab', () => ({default: () => <div>AGENT_TAB</div>}))
vi.mock('../../../../src/renderer/components/settings/tabs/ModelTab', () => ({default: () => <div>MODEL_TAB</div>}))
vi.mock('../../../../src/renderer/components/settings/tabs/ChannelsTab', () => ({default: () => <div>CHANNELS_TAB</div>}))
vi.mock('../../../../src/renderer/components/settings/tabs/ShortcutsTab', () => ({default: () => <div>SHORTCUTS_TAB</div>}))

import {useSettingsStore} from '../../../../src/renderer/stores/settingsStore'
import SettingsDialog from '../../../../src/renderer/components/settings/SettingsDialog'

/** 加载链路带入的「原 ui」：浅色 + 背景启用（触发强制深色）+ 3 个可辨识哨兵字段 */
const ORIGINAL_UI = {
    ...DEFAULT_SETTINGS.ui,
    theme: 'light' as const,
    background: {
        ...DEFAULT_SETTINGS.ui.background,
        enabled: true,
        imagePath: 'E:\\sentinels\\bg.png',
        overlay: 77,
        blur: 23,
    },
}
type UiPayload = {theme: string; background: {enabled: boolean; imagePath: string; overlay: number; blur: number}}

/** 模块单例 store：用例前后复位，避免本文件内互相污染（Vitest 默认按文件隔离模块图） */
const resetStore = () => useSettingsStore.setState({settings: DEFAULT_SETTINGS, pendingSettings: null, isDirty: false})

beforeEach(() => {
    cleanup()
    resetStore()
    // 只补 electronAPI，不整体替换 window（同 tabs.render.test.tsx / SettingsDialog.test.tsx 惯例）
    ;(globalThis as any).window.electronAPI = {
        configRead: vi.fn(async () => null),
        configWrite: vi.fn(async () => true),
        settingsUpdate: vi.fn(async () => ({success: true})),
        setWindowTheme: vi.fn(async () => {}),
    }
})

afterEach(() => {
    cleanup()
    resetStore()
})

/** 等加载门闩打开（loading → loaded；加载期保存按钮 disabled，fireEvent 不触发 onClick） */
const waitLoaded = () => waitFor(() => expect(screen.queryByText('加载中...')).toBeNull())

describe('SettingsDialog 强制深色（真实 store）', () => {
    it('S4 合并保留：写库 ui = 原 ui 字段（哨兵）+ theme dark', async () => {
        const configWrite = vi.fn(async (_key: string, _data: unknown) => true)
        ;(globalThis as any).window.electronAPI = {
            configRead: vi.fn(async (key: string) => (key === 'settings' ? {ui: ORIGINAL_UI} : null)),
            configWrite,
            settingsUpdate: vi.fn(async () => ({success: true})),
            setWindowTheme: vi.fn(async () => {}),
        }

        render(<SettingsDialog/>)
        await waitLoaded()

        // 前置条件自检：哨兵经真实加载链路落位，且无 pending（否则后续断言的基座不是「原 ui」）
        expect(useSettingsStore.getState().settings.ui.theme).toBe('light')
        expect(useSettingsStore.getState().settings.ui.background).toEqual(ORIGINAL_UI.background)
        expect(useSettingsStore.getState().pendingSettings).toBeNull()

        await act(async () => { useSettingsStore.setState({isDirty: true}) })   // 仅开门闩，不建 pending
        await act(async () => { fireEvent.click(screen.getByText('保存')) })

        const saved = configWrite.mock.calls.find(([key]) => key === 'settings')
        expect(saved).toBeTruthy()
        const payload = saved![1] as {ui: UiPayload}

        // 强制深色生效
        expect(payload.ui.theme).toBe('dark')
        // 哨兵逐字段保留（防「以 {theme:'dark'} 整块替换 ui」/「吞掉 background」的回归）
        expect(payload.ui.background).toEqual(ORIGINAL_UI.background)
        expect(payload.ui.background.enabled).toBe(true)
        expect(payload.ui.background.imagePath).toBe('E:\\sentinels\\bg.png')
        expect(payload.ui.background.overlay).toBe(77)
        expect(payload.ui.background.blur).toBe(23)
    })
})
