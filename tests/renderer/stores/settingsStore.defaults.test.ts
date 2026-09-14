import {describe, it, expect, vi, beforeEach} from 'vitest'
import {DEFAULT_SETTINGS, useSettingsStore} from '../../../src/renderer/stores/settingsStore'

describe('DEFAULT_SETTINGS.agent 交接引导配置', () => {
  it('handoffThresholdRatio 默认 0.5', () => {
    expect(DEFAULT_SETTINGS.agent.handoffThresholdRatio).toBe(0.5)
  })
  it('midLoopOverflowMode 默认 auto-handoff', () => {
    expect(DEFAULT_SETTINGS.agent.midLoopOverflowMode).toBe('auto-handoff')
  })
})

describe('新会话默认安全/显示模式', () => {
  beforeEach(() => {
    ;(globalThis as any).window = {
      electronAPI: {
        configWrite: vi.fn(async () => true),
        settingsUpdate: vi.fn(async () => ({success: true})),
        agentSetPermissionMode: vi.fn(async () => true),
      },
    }
    // 重置 store 到默认已保存状态，保证测试间隔离
    useSettingsStore.setState({
      settings: DEFAULT_SETTINGS,
      pendingSettings: null,
      isDirty: false,
    })
  })

  it('DEFAULT_SETTINGS 含默认权限/显示模式字段', () => {
    expect(DEFAULT_SETTINGS.agent.defaultPermissionMode).toBeDefined()
    expect(DEFAULT_SETTINGS.agent.defaultDisplayMode).toBeDefined()
  })

  it('saveSettings 持久化后同步全局链路（defaultPermissionMode → agent-set-permission-mode）', async () => {
    const agentSetMock = vi.fn(async () => true)
    const configWriteMock = vi.fn(async () => true)
    ;(globalThis as any).window = {
      electronAPI: {
        configWrite: configWriteMock,
        settingsUpdate: vi.fn(async () => ({success: true})),
        agentSetPermissionMode: agentSetMock,
      },
    }
    // 经 store 更新 pending 后保存
    useSettingsStore.getState().updatePending('agent', {defaultPermissionMode: 'auto'})
    await useSettingsStore.getState().saveSettings()
    expect(agentSetMock).toHaveBeenCalledWith('auto')
  })
})

describe('图片压缩质量设置（imageCompressQuality）', () => {
  beforeEach(() => {
    useSettingsStore.setState({settings: DEFAULT_SETTINGS, pendingSettings: null, isDirty: false})
  })

  it('DEFAULT_SETTINGS.model.imageCompressQuality 默认 85', () => {
    expect(DEFAULT_SETTINGS.model.imageCompressQuality).toBe(85)
  })

  it('老数据（settings 无 model.imageCompressQuality）加载后回落默认 85', async () => {
    ;(globalThis as any).window = {
      electronAPI: {
        configRead: vi.fn(async (key: string) => (key === 'settings' ? {model: {defaultTemperature: 0.5}} : null)),
        configWrite: vi.fn(async () => true),
        settingsUpdate: vi.fn(async () => ({success: true})),
        agentGetPermissionMode: vi.fn(async () => null),
        agentSetPermissionMode: vi.fn(async () => true),
      },
    }
    await useSettingsStore.getState().loadSettings()
    expect(useSettingsStore.getState().settings.model.imageCompressQuality).toBe(85)
    // 既有字段保留（浅合并不丢数据）
    expect(useSettingsStore.getState().settings.model.defaultTemperature).toBe(0.5)
  })

  it('已保存的自定义质量在加载后保留', async () => {
    ;(globalThis as any).window = {
      electronAPI: {
        configRead: vi.fn(async (key: string) => (key === 'settings' ? {model: {imageCompressQuality: 40}} : null)),
        configWrite: vi.fn(async () => true),
        settingsUpdate: vi.fn(async () => ({success: true})),
        agentGetPermissionMode: vi.fn(async () => null),
        agentSetPermissionMode: vi.fn(async () => true),
      },
    }
    await useSettingsStore.getState().loadSettings()
    expect(useSettingsStore.getState().settings.model.imageCompressQuality).toBe(40)
  })
})
