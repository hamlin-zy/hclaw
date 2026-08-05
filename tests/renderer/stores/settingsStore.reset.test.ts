/**
 * settingsStore 恢复默认行为单元测试
 *
 * 覆盖 spec「设置页恢复默认按钮」：
 * - resetCategoryToDefault: 分类恢复 → pending 对应分类 === DEFAULT_SETTINGS[category]
 * - resetAllToDefault: 全部恢复 → pending 7 分类全部 === 默认值
 * - 恢复动作不触发 configWrite（进 pending 不写盘，spec 决策 B）
 *
 * 隔离：mock window.electronAPI，不触碰真实 IPC / SQLite
 */
import {describe, expect, it, beforeEach, vi} from 'vitest'
import {useSettingsStore, DEFAULT_SETTINGS} from '../../../src/renderer/stores/settingsStore'

const CATEGORIES = Object.keys(DEFAULT_SETTINGS) as Array<keyof typeof DEFAULT_SETTINGS>

beforeEach(() => {
    ;(globalThis as any).window = {
        electronAPI: {
            configWrite: vi.fn(async () => true),
            settingsUpdate: vi.fn(async () => ({success: true})),
        },
    }
    // 重置 store 为「已保存的自定义设置」状态
    useSettingsStore.setState({
        settings: {
            agent: {maxTurns: 999, retryCount: 99, initialRetryDelay: 9000, maxRetryDelay: 90000, llmTimeout: 900000},
            model: {defaultMaxTokens: 12345, defaultTemperature: 1.5},
            mcp: {mcpTestTimeout: 9999},
            ui: {theme: 'dark', background: {enabled: true, imagePath: '/tmp/x.png', overlay: 80, blur: 30}},
            subagent: {maxConcurrency: 9, defaultTimeout: 60000, retryAttempts: 5, priorityEnabled: true, maxDepth: 9},
            channels: {sendGreeting: false, connectionTimeout: 90},
            linkOpening: {mode: 'builtin'},
        },
        pendingSettings: null,
        isDirty: false,
    })
})

describe('resetCategoryToDefault', () => {
    it('恢复分类后 pending 对应分类等于 DEFAULT_SETTINGS[category]', () => {
        const {resetCategoryToDefault} = useSettingsStore.getState()
        resetCategoryToDefault('agent')
        const state = useSettingsStore.getState()
        expect(state.pendingSettings?.agent).toEqual(DEFAULT_SETTINGS.agent)
        expect(state.isDirty).toBe(true)
        // 其他分类不受影响
        expect(state.pendingSettings?.model).toEqual({defaultMaxTokens: 12345, defaultTemperature: 1.5})
    })

    it('ui 分类恢复包含 background 默认值（enabled:false, imagePath:"", overlay:50, blur:16）', () => {
        const {resetCategoryToDefault} = useSettingsStore.getState()
        resetCategoryToDefault('ui')
        const state = useSettingsStore.getState()
        expect(state.pendingSettings?.ui).toEqual(DEFAULT_SETTINGS.ui)
        expect(state.pendingSettings?.ui.background).toEqual({enabled: false, imagePath: '', overlay: 50, blur: 16})
    })
})

describe('resetAllToDefault', () => {
    it('恢复后 7 个分类全部等于默认值', () => {
        const {resetAllToDefault} = useSettingsStore.getState()
        resetAllToDefault()
        const state = useSettingsStore.getState()
        for (const cat of CATEGORIES) {
            expect(state.pendingSettings?.[cat]).toEqual(DEFAULT_SETTINGS[cat])
        }
        expect(state.isDirty).toBe(true)
    })
})

describe('恢复动作不触发写盘', () => {
    it('resetCategoryToDefault / resetAllToDefault 均不调用 configWrite', () => {
        const {resetCategoryToDefault, resetAllToDefault} = useSettingsStore.getState()
        resetCategoryToDefault('agent')
        resetAllToDefault()
        const configWrite = (globalThis as any).window.electronAPI.configWrite
        expect(configWrite).not.toHaveBeenCalled()
    })
})
