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
