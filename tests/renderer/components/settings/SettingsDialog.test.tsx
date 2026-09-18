// @vitest-environment jsdom
/**
 * 新设置壳（T18）：六 Tab 切换 / 键盘导航 / 加载三态 / 侧栏重置唯一入口 / 保存反馈。
 * 六个 Tab 以占位组件 mock（本文件只测壳）。
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {render, screen, fireEvent, cleanup, waitFor, act} from '@testing-library/react'

const {mockState, mockHook} = vi.hoisted(() => {
    const state: any = {}
    const hook: any = (selector?: any) => (typeof selector === 'function' ? selector(state) : state)
    hook.getState = () => state
    hook.setState = (patch: any) => Object.assign(state, patch)
    return {mockState: state, mockHook: hook}
})

vi.mock('../../../../src/renderer/stores/settingsStore', async (importOriginal) => ({
    ...(await importOriginal<any>()),
    useSettingsStore: mockHook,
}))
vi.mock('../../../../src/renderer/stores/themeStore', async (importOriginal) => ({
    ...(await importOriginal<any>()),
    applyThemeClass: vi.fn(),
    useThemeStore: {getState: () => ({theme: 'dark'})},
}))

vi.mock('../../../../src/renderer/components/settings/tabs/GeneralTab', () => ({default: () => <div>GENERAL_TAB</div>}))
vi.mock('../../../../src/renderer/components/settings/tabs/AppearanceTab', () => ({default: () => <div>APPEARANCE_TAB</div>}))
vi.mock('../../../../src/renderer/components/settings/tabs/AgentTab', () => ({default: () => <div>AGENT_TAB</div>}))
vi.mock('../../../../src/renderer/components/settings/tabs/ModelTab', () => ({default: () => <div>MODEL_TAB</div>}))
vi.mock('../../../../src/renderer/components/settings/tabs/ChannelsTab', () => ({default: () => <div>CHANNELS_TAB</div>}))
vi.mock('../../../../src/renderer/components/settings/tabs/ShortcutsTab', () => ({default: () => <div>SHORTCUTS_TAB</div>}))

import SettingsDialog from '../../../../src/renderer/components/settings/SettingsDialog'

beforeEach(() => {
    cleanup()
    Object.assign(mockState, {
        settings: null, pendingSettings: null, isDirty: false,
        loadSettings: vi.fn(async () => true),
        saveSettings: vi.fn(async () => {}),
        discardChanges: vi.fn(),
        updatePending: vi.fn(), updateSettings: vi.fn(async () => {}),
        resetFieldsToDefault: vi.fn(), resetAllToDefault: vi.fn(),
    })
    // 偏差（环境）：brief 原稿整体替换 window（`window = {electronAPI: {}}`），
    // 但 RTL 的 waitFor 默认容器取自 `window.document`（getDocument()），整体替换会让
    // 裸 waitFor 抛 "Expected container to be an Element ... but got undefined"。
    // 故只补 electronAPI（同 tests/renderer/components/settings/tabs/tabs.render.test.tsx 的惯例）。
    ;(globalThis as any).window.electronAPI = {}
})

/**
 * 等加载门闩落位（loading → loaded）。
 * 偏差（时序）：brief 原稿在 render() 后同步点击/断言；但 render() 之后 loadSettings 的
 * 微任务尚未落位，此时「保存」仍处于 disabled（spec §4.5 要求加载期禁用），
 * fireEvent 对 disabled 按钮不触发 onClick；且用例同步结束会让落位 setState 落在 act 之外
 * （act 警告污染输出）。故在需要交互/结束用例前先等门闩打开。
 */
const waitLoaded = () => waitFor(() => expect(screen.queryByText('加载中...')).toBeNull())

describe('SettingsDialog（新壳）', () => {
    it('六 Tab 渲染、默认选中「通用」、tabpanel 显示 GeneralTab', async () => {
        render(<SettingsDialog/>)
        for (const name of ['通用', '外观与显示', 'Agent 运行', '模型参数', 'IM 配置', '快捷键']) {
            expect(screen.getByRole('tab', {name})).toBeTruthy()
        }
        expect(screen.getByRole('tab', {name: '通用'}).getAttribute('aria-selected')).toBe('true')
        expect(await screen.findByText('GENERAL_TAB')).toBeTruthy()
    })

    it('键盘：↑↓ / Home / End 切换选中（roving tabindex 同步焦点）', async () => {
        render(<SettingsDialog/>)
        await waitLoaded()
        const tablist = screen.getByRole('tablist')
        fireEvent.keyDown(tablist, {key: 'ArrowDown'})
        expect(screen.getByRole('tab', {name: '外观与显示'}).getAttribute('aria-selected')).toBe('true')
        fireEvent.keyDown(tablist, {key: 'End'})
        expect(screen.getByRole('tab', {name: '快捷键'}).getAttribute('aria-selected')).toBe('true')
        fireEvent.keyDown(tablist, {key: 'Home'})
        expect(screen.getByRole('tab', {name: '通用'}).getAttribute('aria-selected')).toBe('true')
    })

    it('加载失败：banner + 重试可恢复；保存保持禁用', async () => {
        mockState.loadSettings = vi.fn(async () => false)
        render(<SettingsDialog/>)
        const banner = await screen.findByRole('alert')
        expect(banner.textContent).toContain('设置加载失败')
        expect((screen.getByText('保存') as HTMLButtonElement).disabled).toBe(true)
        // 加载门闩未打开时侧栏「恢复全部默认」同样不可点：否则 resetAllToDefault 会以
        // DEFAULT_SETTINGS 为基座生成「全默认」pending，重试成功后保存把全默认覆盖写库
        // （spec §4.5 括号预防的竞态）。
        const resetAll = screen.getByRole('button', {name: '恢复全部默认'}) as HTMLButtonElement
        expect(resetAll.disabled).toBe(true)
        // 重试（第二次成功）
        mockState.loadSettings = vi.fn(async () => true)
        fireEvent.click(screen.getByText('重试'))
        await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
        expect(screen.getByText('GENERAL_TAB')).toBeTruthy()
        // 门闩打开后恢复可用
        await waitFor(() => {
            expect((screen.getByRole('button', {name: '恢复全部默认'}) as HTMLButtonElement).disabled).toBe(false)
        })
    })

    it('侧栏「恢复全部默认」为唯一入口，点击调用 resetAllToDefault', async () => {
        render(<SettingsDialog/>)
        await waitLoaded()
        const all = screen.getAllByText('恢复全部默认')
        expect(all.length).toBe(1)
        fireEvent.click(all[0])
        expect(mockState.resetAllToDefault).toHaveBeenCalled()
    })

    it('保存成功显示「已保存」反馈', async () => {
        mockState.isDirty = true
        mockState.pendingSettings = {agent: {}}
        render(<SettingsDialog/>)
        // 等加载门闩打开（保存按钮可用）后再点击——断言语义与 brief 一致
        await waitLoaded()
        await act(async () => { fireEvent.click(screen.getByText('保存')) })
        expect(mockState.saveSettings).toHaveBeenCalled()
        await waitFor(() => expect(screen.getByText(/已保存/)).toBeTruthy())
    })

    it('保存失败显示「保存失败」且 pending 保留（footer 不消失）', async () => {
        mockState.isDirty = true
        mockState.pendingSettings = {agent: {}}
        mockState.saveSettings = vi.fn(async () => { throw new Error('boom') })
        render(<SettingsDialog/>)
        // 同上：等加载门闩打开后再点击
        await waitLoaded()
        await act(async () => { fireEvent.click(screen.getByText('保存')) })
        await waitFor(() => expect(screen.getByText(/保存失败/)).toBeTruthy())
        expect(screen.getByText('保存')).toBeTruthy() // footer 可见（pending 未清）
    })

    it('背景启用 + 浅色系主题：保存前经 updatePending 强制切深色', async () => {
        mockState.isDirty = true
        mockState.pendingSettings = {ui: {theme: 'light', background: {enabled: true}}}
        render(<SettingsDialog/>)
        await waitLoaded()
        await act(async () => { fireEvent.click(screen.getByText('保存')) })
        expect(mockState.updatePending).toHaveBeenCalledWith('ui', {theme: 'dark'})
        expect(mockState.saveSettings).toHaveBeenCalled()
    })

    it('背景启用 + 已是深色系：不动 pending，直接保存', async () => {
        mockState.isDirty = true
        mockState.pendingSettings = {ui: {theme: 'dark', background: {enabled: true}}}
        render(<SettingsDialog/>)
        await waitLoaded()
        await act(async () => { fireEvent.click(screen.getByText('保存')) })
        expect(mockState.updatePending).not.toHaveBeenCalled()
        expect(mockState.saveSettings).toHaveBeenCalled()
    })
})
