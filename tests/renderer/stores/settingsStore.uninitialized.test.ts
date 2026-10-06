/**
 * 回归测试：独立窗口（未 loadSettings）调用 updateSettings 不应覆盖用户真实配置
 *
 * 场景：定时任务管理页面是独立 BrowserWindow，ConfigDialogWindow 不调 loadSettings。
 * 用户在该窗口禁用系统任务 → handleConfirmDisable 调 updateSettings({memory:{enabled:false}})。
 * 修复前：updateSettings 读 get().settings（= DEFAULT_SETTINGS）作为 base，
 *         合并后 configWrite 把默认值写库，覆盖用户真实配置 → "整个系统设置被重置"。
 * 修复后：updateSettings 入口守卫 _settingsLoaded，未加载时先 loadSettings 再合并。
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {DEFAULT_SETTINGS, useSettingsStore} from '../../../src/renderer/stores/settingsStore'

describe('updateSettings 在未加载真实设置的独立窗口中', () => {
    beforeEach(() => {
        // 模拟独立窗口：settingsStore 未初始化（仍是 DEFAULT_SETTINGS, _settingsLoaded=false）
        useSettingsStore.setState({
            settings: DEFAULT_SETTINGS,
            pendingSettings: null,
            isDirty: false,
            _settingsLoaded: false,
        })
    })

    it('应先 loadSettings 再合并，保留数据库中的用户配置（不覆盖）', async () => {
        const configWriteMock = vi.fn(async () => true)
        ;(globalThis as any).window = {
            electronAPI: {
                configRead: vi.fn(async (key: string) =>
                    key === 'settings'
                        ? {agent: {maxTurns: 20}} // 用户真实配置（默认 500）
                        : undefined,
                ),
                configWrite: configWriteMock,
                settingsUpdate: vi.fn(async () => ({success: true})),
                setWindowTheme: vi.fn(async () => undefined),
                agentGetPermissionMode: vi.fn(async () => 'safe'),
                agentSetPermissionMode: vi.fn(async () => true),
            },
        }

        // 模拟 handleConfirmDisable 的调用路径：未 loadSettings 直接 updateSettings
        await useSettingsStore.getState().updateSettings({memory: {enabled: false}})

        const calls = configWriteMock.mock.calls as any[]
        const writtenSettings = calls[0]?.[1]
        // 用户配置应保留（bug 时为 DEFAULT_SETTINGS.agent.maxTurns = 500）
        expect(writtenSettings.agent.maxTurns).toBe(20)
        // memory.enabled 应为 false
        expect(writtenSettings.memory.enabled).toBe(false)
    })
})
