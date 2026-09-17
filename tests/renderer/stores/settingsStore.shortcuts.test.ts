import {describe, it, expect, vi, beforeEach} from 'vitest'
import {DEFAULT_SETTINGS, useSettingsStore} from '../../../src/renderer/stores/settingsStore'

describe('loadSettings 合并 shortcuts 覆盖项', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      settings: DEFAULT_SETTINGS,
      pendingSettings: null,
      isDirty: false,
    })
  })

  it('配置中的 shortcuts.overrides 经 loadSettings 后保留在 store', async () => {
    const overrides = {
      ...DEFAULT_SETTINGS.shortcuts?.overrides,
      newSession: 'CommandOrControl+Shift+J',
    }
    ;(globalThis as any).window = {
      electronAPI: {
        configRead: vi.fn(async (key: string) =>
          key === 'settings'
            ? {shortcuts: {...DEFAULT_SETTINGS.shortcuts, overrides}}
            : undefined
        ),
        agentGetPermissionMode: vi.fn(async () => 'safe'),
        agentSetPermissionMode: vi.fn(async () => true),
        configWrite: vi.fn(async () => true),
      },
    }
    await useSettingsStore.getState().loadSettings()
    expect(useSettingsStore.getState().settings.shortcuts?.overrides?.newSession).toBe('CommandOrControl+Shift+J')
  })
})

describe('updateSettings 快捷键 ↔ pending 条件镜像（spec §5.2）', () => {
    beforeEach(() => {
        useSettingsStore.setState({settings: DEFAULT_SETTINGS, pendingSettings: null, isDirty: false})
        ;(globalThis as any).window = {
            electronAPI: {
                configWrite: vi.fn(async () => true),
                settingsUpdate: vi.fn(async () => ({success: true})),
                setWindowTheme: vi.fn(async () => undefined),
            },
        }
    })

    it('pending 存在 + 改键：pending.shortcuts 镜像为写库后值；随后保存不回退键位', async () => {
        const configWriteMock = vi.fn(async () => true)
        ;(globalThis as any).window = {
            electronAPI: {
                configWrite: configWriteMock,
                settingsUpdate: vi.fn(async () => ({success: true})),
                setWindowTheme: vi.fn(async () => undefined),
            },
        }
        useSettingsStore.getState().updatePending('agent', {maxTurns: 1}) // 制造 pending
        await useSettingsStore.getState().updateSettings({shortcuts: {overrides: {newSession: 'CommandOrControl+Shift+J'}}})
        const p = useSettingsStore.getState().pendingSettings!
        expect(p.shortcuts!.overrides).toEqual({newSession: 'CommandOrControl+Shift+J'})
        expect(p.agent.maxTurns).toBe(1) // 其余 pending 不丢
        // 端到端：保存写库的 pending 携带新键位（改键后点保存不回退——spec §5.2 回归场景）
        await useSettingsStore.getState().saveSettings()
        expect(configWriteMock).toHaveBeenCalledWith('settings', expect.objectContaining({
            shortcuts: {overrides: {newSession: 'CommandOrControl+Shift+J'}},
        }))
    })

    it('键位恢复默认后，无关调用（主题切换，与 themeStore.toggleTheme 同路径）不抹掉空覆盖', async () => {
        // 判别性前提：库内已有绑定（settings.shortcuts.overrides 非空）⇒
        // 重置后的 pending（{}）与 settings（既有绑定）此刻必须不同，
        // 否则「无关调用不抹掉重置」在无实现时也成立（弱断言，无守护力）。
        useSettingsStore.setState({
            settings: {...DEFAULT_SETTINGS, shortcuts: {overrides: {newSession: 'Ctrl+Shift+J'}}},
            pendingSettings: null,
            isDirty: false,
        })
        useSettingsStore.getState().updatePending('agent', {maxTurns: 1}) // 制造无关 pending
        useSettingsStore.getState().resetFieldsToDefault(['shortcuts.overrides']) // 页面级重置进 pending，尚未保存
        const pre = useSettingsStore.getState()
        expect(pre.pendingSettings!.shortcuts!.overrides).toEqual({})
        expect(pre.settings.shortcuts!.overrides).toEqual({newSession: 'Ctrl+Shift+J'}) // 判别性锚点：两者此刻不同

        await useSettingsStore.getState().updateSettings({ui: {theme: 'dark'}}) // 无关调用

        const p = useSettingsStore.getState().pendingSettings!
        expect(p.shortcuts!.overrides).toEqual({}) // 关键回归：不得回弹为 settings 中的既有绑定
        expect(p.agent.maxTurns).toBe(1)           // 其余 pending 不丢
    })

    it('pending 为空：改键不产生 pending', async () => {
        await useSettingsStore.getState().updateSettings({shortcuts: {overrides: {newSession: 'Ctrl+Shift+K'}}})
        expect(useSettingsStore.getState().pendingSettings).toBeNull()
    })
})
