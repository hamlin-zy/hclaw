/**
 * mergeSystemSettings 收敛测试（spec §6.4）：
 * 逐分类浅合并 + 顶层标量特例；loadSettings / updateSettings / resetAllToDefault 共用。
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {mergeSystemSettings, useSettingsStore, DEFAULT_SETTINGS} from '../../../src/renderer/stores/settingsStore'

describe('mergeSystemSettings', () => {
    it('对象分类浅合并不丢未覆盖键', () => {
        const merged = mergeSystemSettings(DEFAULT_SETTINGS, {
            agent: {maxTurns: 42},
            ui: {theme: 'dark'},
        })
        expect(merged.agent.maxTurns).toBe(42)
        expect(merged.agent.retryCount).toBe(DEFAULT_SETTINGS.agent.retryCount) // 未覆盖键保留
        expect(merged.ui.theme).toBe('dark')
        expect(merged.ui.background).toEqual(DEFAULT_SETTINGS.ui.background)
        expect(merged.model).toEqual(DEFAULT_SETTINGS.model)
    })

    it('顶层标量 fullSkillDescriptions：提供值优先（含 false），未提供保留 base', () => {
        expect(mergeSystemSettings(DEFAULT_SETTINGS, {fullSkillDescriptions: true}).fullSkillDescriptions).toBe(true)
        expect(mergeSystemSettings(DEFAULT_SETTINGS, {fullSkillDescriptions: false}).fullSkillDescriptions).toBe(false)
        expect(mergeSystemSettings({...DEFAULT_SETTINGS, fullSkillDescriptions: true}, {}).fullSkillDescriptions).toBe(true)
    })

    it('legacy mcp 键不进入结果（只拾取已知分类）', () => {
        const merged = mergeSystemSettings(DEFAULT_SETTINGS, {mcp: {mcpTestTimeout: 1}} as any)
        expect('mcp' in merged).toBe(false)
    })
})

describe('loadSettings 经 merge 行为不变', () => {
    beforeEach(() => {
        useSettingsStore.setState({settings: DEFAULT_SETTINGS, pendingSettings: null, isDirty: false})
    })

    it('部分数据合并：fullSkillDescriptions 归一 false、其余沿用默认', async () => {
        vi.stubGlobal('window', {
            electronAPI: {
                configRead: vi.fn(async (key: string) => (key === 'settings' ? {model: {defaultTemperature: 0.5}} : null)),
                agentGetPermissionMode: vi.fn(async () => null),
                conversationReadMeta: vi.fn(async () => null),
            },
        })
        await useSettingsStore.getState().loadSettings()
        const s = useSettingsStore.getState().settings
        expect(s.fullSkillDescriptions).toBe(false)
        expect(s.model.defaultTemperature).toBe(0.5)
        expect(s.model.defaultMaxTokens).toBe(50000)
        expect(s.agent.maxTurns).toBe(500)
    })
})
