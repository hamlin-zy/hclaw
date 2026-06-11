import {create} from 'zustand'
import type {SystemSettings} from '@shared/types'
import {resolveAndApplyTheme} from './themeStore'

interface SettingsStore {
    settings: SystemSettings
    pendingSettings: SystemSettings | null
    isDirty: boolean
    loadSettings: () => Promise<void>
    /** 仅更新本地待保存状态（不写入磁盘） */
    updatePending: <K extends keyof SystemSettings>(category: K, values: Partial<SystemSettings[K]>) => void
    /** 确认保存：将 pendingSettings 写入磁盘并同步到 Worker */
    saveSettings: () => Promise<void>
    /** 放弃修改：恢复为已保存状态 */
    discardChanges: () => void
    /** 直接更新设置并保存到磁盘（用于外部触发器如主题切换） */
    updateSettings: (updates: Partial<SystemSettings>) => Promise<void>
}

const DEFAULT_SETTINGS: SystemSettings = {
    agent: {
        maxTurns: 500,
        retryCount: 10,
        initialRetryDelay: 5000,
        maxRetryDelay: 120000,
        llmTimeout: 600000,
        compactThreshold: 700000,
    },
    model: {
        defaultMaxTokens: 8000,
        defaultTemperature: 0,
    },
    mcp: {
        mcpTestTimeout: 15000,
    },
    ui: {
        language: 'zh-CN',
        theme: 'system',
    },
    subagent: {
        maxConcurrency: 3,
        defaultTimeout: 15 * 60 * 1000,
        retryAttempts: 0,
        priorityEnabled: false,
    },
    channels: {
        sendGreeting: true,
        connectionTimeout: 30,
    },
    linkOpening: {
        mode: 'ask',
    },
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
    settings: DEFAULT_SETTINGS,
    pendingSettings: null,
    isDirty: false,

    loadSettings: async () => {
        try {
            const data: any = await window.electronAPI?.configRead('settings')
            if (data) {
                const mergedSettings: SystemSettings = {
                    agent: {...DEFAULT_SETTINGS.agent, ...(data.agent || {})},
                    model: {...DEFAULT_SETTINGS.model, ...(data.model || {})},
                    mcp: {...DEFAULT_SETTINGS.mcp, ...(data.mcp || {})},
                    ui: {...DEFAULT_SETTINGS.ui, ...(data.ui || {})},
                    subagent: {...DEFAULT_SETTINGS.subagent, ...(data.subagent || {})},
                    channels: {...DEFAULT_SETTINGS.channels, ...(data.channels || {})},
                    linkOpening: {...DEFAULT_SETTINGS.linkOpening, ...(data.linkOpening || {})},
                }
                set({settings: mergedSettings})

                // 自动同步主题到 themeStore
                resolveAndApplyTheme(mergedSettings.ui.theme)
            }
        } catch (err) {
            // 静默处理错误
        }
    },

    updatePending: (category, values) => {
        const {pendingSettings, settings} = get()
        const base = pendingSettings || settings
        const updated = {
            ...base,
            [category]: {...base[category], ...values}
        }
        set({pendingSettings: updated, isDirty: true})
    },

    saveSettings: async () => {
        const {pendingSettings} = get()
        if (!pendingSettings) return

        // 同步主题到 themeStore
        resolveAndApplyTheme(pendingSettings.ui.theme)

        try {
            // 1. 先写入数据库，成功后才更新本地状态
            const ok = await window.electronAPI?.configWrite('settings', pendingSettings as any)
            if (!ok) {
                throw new Error('数据库写入失败')
            }
            set({settings: pendingSettings})

            // 2. 广播到运行中的 Agent
            const broadcastResult = await window.electronAPI?.settingsUpdate?.(pendingSettings as any)
            if (broadcastResult && !(broadcastResult as any).success) {
                console.warn('[Settings] Agent 同步警告:', (broadcastResult as any).error)
            }

            // 全部成功后清除待保存状态
            set({pendingSettings: null, isDirty: false})
        } catch (err) {
            console.error('[Settings] 保存失败:', err)
            // 不清除 pendingSettings，用户可重试
            throw err
        }
    },

    discardChanges: () => {
        set({pendingSettings: null, isDirty: false})
    },

    updateSettings: async (updates: Partial<SystemSettings>) => {
        const currentSettings = get().settings
        const newSettings: SystemSettings = {
            agent: {...currentSettings.agent, ...(updates.agent || {})},
            model: {...currentSettings.model, ...(updates.model || {})},
            mcp: {...currentSettings.mcp, ...(updates.mcp || {})},
            ui: {...currentSettings.ui, ...(updates.ui || {})},
            subagent: {...currentSettings.subagent, ...(updates.subagent || {})} as typeof currentSettings.subagent,
            channels: {...currentSettings.channels, ...(updates.channels || {})} as typeof currentSettings.channels,
        }

        try {
            const ok = await window.electronAPI?.configWrite('settings', newSettings as any)
            if (!ok) {
                throw new Error('数据库写入失败')
            }
            set({settings: newSettings})

            const broadcastResult = await window.electronAPI?.settingsUpdate?.(newSettings as any)
            if (broadcastResult && !(broadcastResult as any).success) {
                console.warn('[Settings] Agent 同步警告:', (broadcastResult as any).error)
            }
        } catch (err) {
            console.error('[Settings] 更新失败:', err)
            throw err
        }
    }
}))
