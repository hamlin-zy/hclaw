import {create} from 'zustand'
import type {SystemSettings} from '@shared/types'
import {DEFAULT_MAX_TOKENS} from '@shared/types'
import {resolveAndApplyTheme, useThemeStore} from './themeStore'
import {useConversationStore} from './conversationStore'

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
    /** 恢复指定分类为默认值（仅写入 pending，不落盘） */
    resetCategoryToDefault: (category: keyof SystemSettings) => void
    /** 恢复全部分类为默认值（仅写入 pending，不落盘） */
    resetAllToDefault: () => void
}

export const DEFAULT_SETTINGS: SystemSettings = {
    agent: {
        maxTurns: 500,
        retryCount: 10,
        initialRetryDelay: 5000,
        maxRetryDelay: 120000,
        llmTimeout: 600000,
        handoffThresholdRatio: 0.5,
        midLoopOverflowMode: 'auto-handoff',
    },
    model: {
        defaultMaxTokens: DEFAULT_MAX_TOKENS,
        defaultTemperature: 0,
    },
    mcp: {
        mcpTestTimeout: 15000,
    },
    ui: {
        theme: 'system',
        background: {enabled: false, imagePath: '', overlay: 50, blur: 16},
    },
    subagent: {
        maxConcurrency: 3,
        defaultTimeout: 15 * 60 * 1000,
        retryAttempts: 0,
        priorityEnabled: false,
        maxDepth: 3,
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
        } catch {
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

    resetCategoryToDefault: (category) => {
        get().updatePending(category, DEFAULT_SETTINGS[category])
    },

    resetAllToDefault: () => {
        const {pendingSettings, settings} = get()
        const base = pendingSettings || settings
        const updated: SystemSettings = {
            ...base,
            agent: DEFAULT_SETTINGS.agent,
            model: DEFAULT_SETTINGS.model,
            mcp: DEFAULT_SETTINGS.mcp,
            ui: DEFAULT_SETTINGS.ui,
            subagent: DEFAULT_SETTINGS.subagent,
            channels: DEFAULT_SETTINGS.channels,
            linkOpening: DEFAULT_SETTINGS.linkOpening,
        }
        set({pendingSettings: updated, isDirty: true})
    },

    saveSettings: async () => {
        const {pendingSettings} = get()
        if (!pendingSettings) return

        try {
            // 1. 先写入数据库，成功后才更新本地状态
            const ok = await window.electronAPI?.configWrite('settings', pendingSettings as any)
            if (!ok) {
                throw new Error('数据库写入失败')
            }
            // 在 set({settings}) 之前捕获旧阈值（spec 3.2：仅阈值变更时恢复"不再提醒"抑制标记）
            const oldThresholdRatio = get().settings?.agent?.handoffThresholdRatio ?? 0.5
            set({settings: pendingSettings})

            // 2. 同步主题到 themeStore（须放在 set({settings}) 之后：
            //    resolveAndApplyTheme 读取的 settings 是本次 pending（含背景启用状态），
            //    修正 "system + 本次启用背景" 被解析为 light 的角例）
            const prevTheme = useThemeStore.getState().theme
            resolveAndApplyTheme(pendingSettings.ui.theme)

            // 3. 广播主题变更：走既有 set-window-theme 权威通道（titleBarOverlay + 广播 theme-changed 给所有窗口）
            //    传 themeStore 解析后的值（上面 resolveAndApplyTheme 已把 'system' 解析为具体主题），
            //    避免 'system' 原值导致 titleBarOverlay 走浅色兜底、独立窗口 applyThemeClass 不解析。
            //    主题未变（resolve 前后同值）时跳过重广播。
            if (useThemeStore.getState().theme !== prevTheme) {
                window.electronAPI?.setWindowTheme?.(useThemeStore.getState().theme)?.catch(() => {})
            }

            // 4. 广播到运行中的 Agent
            const broadcastResult = await window.electronAPI?.settingsUpdate?.(pendingSettings as any)
            if (broadcastResult && !(broadcastResult as any).success) {
                console.warn('[Settings] Agent 同步警告:', (broadcastResult as any).error)
            }

            // 阈值调整后恢复各会话的"不再提醒"抑制标记（spec 3.2：仅阈值变更时恢复）
            const newThresholdRatio = pendingSettings.agent?.handoffThresholdRatio ?? 0.5
            if (oldThresholdRatio !== newThresholdRatio) {
                useConversationStore.getState().clearHandoffDismissals()
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

            // 广播主题变更：镜像 saveSettings 顺序（resolve → setWindowTheme → settingsUpdate）
            //    先 resolveAndApplyTheme 消除"依赖调用方预置 themeStore"的隐式耦合；
            //    再走既有 set-window-theme 权威通道，传解析后的值（避免 'system' 原值广播）；
            //    主题未变（resolve 前后同值）时跳过重广播。
            const prevTheme = useThemeStore.getState().theme
            resolveAndApplyTheme(newSettings.ui.theme)
            if (useThemeStore.getState().theme !== prevTheme) {
                window.electronAPI?.setWindowTheme?.(useThemeStore.getState().theme)?.catch(() => {})
            }

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
