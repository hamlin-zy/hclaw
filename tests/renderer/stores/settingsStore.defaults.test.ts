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
