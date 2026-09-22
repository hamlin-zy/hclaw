import {create} from 'zustand'
import type {SystemSettings} from '@shared/types'
import {DEFAULT_SETTINGS} from '@shared/settingsDefaults'
import {resolveAndApplyTheme, useThemeStore} from './themeStore'
import {useConversationStore, applyConvModesToAgentStore} from './conversationStore'

interface SettingsStore {
    settings: SystemSettings
    pendingSettings: SystemSettings | null
    isDirty: boolean
    /** 从磁盘加载已保存设置；返回是否成功（新壳据此进入 loaded / failed 态） */
    loadSettings: () => Promise<boolean>
    /** 仅更新本地待保存状态（不写入磁盘） */
    updatePending: <K extends keyof SystemSettings>(category: K, values: Partial<SystemSettings[K]>) => void
    /** 确认保存：将 pendingSettings 写入磁盘并同步到 Worker */
    saveSettings: () => Promise<void>
    /** 放弃修改：恢复为已保存状态 */
    discardChanges: () => void
    /** 直接更新设置并保存到磁盘（用于外部触发器如主题切换） */
    updateSettings: (updates: Partial<SystemSettings>) => Promise<void>
    /** 恢复指定字段路径为默认值（仅写入 pending，不落盘；spec §5.3 页面级重置） */
    resetFieldsToDefault: (paths: FieldPath[]) => void
    /** 恢复全部分类为默认值（仅写入 pending，不落盘） */
    resetAllToDefault: () => void
}

/** 设置字段路径：顶层键（如 `model`）或点号下钻路径（如 `model.defaultTemperature`） */
export type FieldPath = `${keyof SystemSettings}` | `${keyof SystemSettings}.${string}`

// 兼容既有引用（组件/测试从 settingsStore 导入 DEFAULT_SETTINGS）
export {DEFAULT_SETTINGS}

/** mergeSystemSettings 的 patch 形状：分类内允许部分字段（与逐分类浅合并语义一致）；顶层标量保持原类型 */
type SystemSettingsPatch = {[K in keyof SystemSettings]?: Partial<NonNullable<SystemSettings[K]>>}

/** 逐分类浅合并 + 顶层标量特例（spec §6.4；收敛 loadSettings/updateSettings/resetAllToDefault 三处重复） */
export function mergeSystemSettings(base: SystemSettings, patch: SystemSettingsPatch): SystemSettings {
    return {
        agent: {...base.agent, ...(patch.agent || {})},
        model: {...base.model, ...(patch.model || {})},
        ui: {...base.ui, ...(patch.ui || {})},
        subagent: {...base.subagent, ...(patch.subagent || {})} as typeof base.subagent,
        channels: {...base.channels, ...(patch.channels || {})} as typeof base.channels,
        linkOpening: {...base.linkOpening, ...(patch.linkOpening || {})} as typeof base.linkOpening,
        shortcuts: {...base.shortcuts, ...(patch.shortcuts || {})},
        language: {...base.language, ...(patch.language || {})} as typeof base.language,
        memory: {...base.memory, ...(patch.memory || {})} as typeof base.memory,
        // 标量特例：不能对象展开（{...true} 会得到 {}）；`??` 语义 = 旧实现逐字一致
        fullSkillDescriptions: patch.fullSkillDescriptions ?? base.fullSkillDescriptions,
    }
}

/** 点号路径逐级下钻赋值；中间层缺失时建空对象（仅用于 resetFieldsToDefault 的 JSON 克隆体） */
function setPathValue(target: Record<string, any>, path: string, value: unknown): void {
    const parts = path.split('.')
    let node = target
    for (let i = 0; i < parts.length - 1; i++) {
        const key = parts[i]
        if (node[key] === null || typeof node[key] !== 'object') node[key] = {}
        node = node[key]
    }
    node[parts[parts.length - 1]] = value
}

/** 交接阈值签名：比例 / 模式 / 固定 token 任一变化都视为阈值变更（用于恢复"不再提醒"抑制标记） */
function handoffThresholdSignature(agent: SystemSettings['agent'] | undefined): string {
    return `${agent?.handoffThresholdRatio ?? 0.5}|${agent?.handoffThresholdMode ?? 'ratio'}|${agent?.handoffThresholdTokens ?? 200_000}`
}

/**
 * 对账：全局权威键（system_settings.permission_mode / message-display-mode）
 * 必须与 settings 默认值一致——存量数据可能因旧版本保存守卫
 * （prev===new 时跳过同步）而未同步，新建会话固化默认时会读到陈旧值。
 *
 * 三块串行且有序（权限写库 → 会话回灌 → 显示键写库）；不触碰 store 状态，故置于模块作用域。
 */
async function reconcileGlobalAuthoritativeKeys(mergedSettings: SystemSettings): Promise<void> {
    try {
        const gp = await window.electronAPI?.agentGetPermissionMode?.()
        const targetPerm = mergedSettings.agent.defaultPermissionMode ?? 'safe'
        if (gp && gp !== targetPerm) {
            await window.electronAPI?.agentSetPermissionMode?.(targetPerm)
        }
    } catch { /* 静默：对账失败不阻断加载 */ }
    // 对账写库后回灌激活会话的顶层显示：冷启动时 loadConversations 的会话模式初始化
    // 与本次对账并发，若它在写库前读到陈旧全局默认，输入栏会停在旧值直到用户切会话。
    // applyConvModesToAgentStore 以会话 meta 优先、否则回退（已对账后的）全局默认，
    // 幂等且与 saveSettings 的处理对齐。
    const activeConvId = useConversationStore.getState().activeConversationId
    if (activeConvId) await applyConvModesToAgentStore(activeConvId)
    try {
        const cfg: any = await window.electronAPI?.configRead?.('message-display-mode')
        const mode = cfg?.mode
        const targetDisp = mergedSettings.agent.defaultDisplayMode ?? 'detailed'
        if (mode && mode !== targetDisp) {
            await window.electronAPI?.configWrite?.('message-display-mode', {mode: targetDisp})
        }
    } catch { /* 静默：对账失败不阻断加载 */ }
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
    settings: DEFAULT_SETTINGS,
    pendingSettings: null,
    isDirty: false,

    loadSettings: async (): Promise<boolean> => {
        try {
            const data: any = await window.electronAPI?.configRead('settings')
            if (data) {
                const mergedSettings = mergeSystemSettings(DEFAULT_SETTINGS, {
                    ...data,
                    // 归一化保留旧行为：缺省 = 关闭
                    fullSkillDescriptions: data.fullSkillDescriptions ?? false,
                })
                set({settings: mergedSettings})
                await reconcileGlobalAuthoritativeKeys(mergedSettings)

                // 自动同步主题到 themeStore
                resolveAndApplyTheme(mergedSettings.ui.theme)
            }
            return true
        } catch {
            // 读取失败：静默返回 false（新壳据此进入 failed 态，禁用保存以阻止以默认值覆盖写库）
            return false
        }
    },

    updatePending: (category, values) => {
        const {pendingSettings, settings} = get()
        const base = pendingSettings || settings
        // 标量类顶层字段（如 fullSkillDescriptions）不能走对象展开：{...true} 会得到 {}
        const prevValue = base[category]
        const merged = (prevValue !== null && typeof prevValue === 'object')
            ? {...prevValue as object, ...values}
            : values
        const updated = {
            ...base,
            [category]: merged
        }
        set({pendingSettings: updated, isDirty: true})
    },

    resetFieldsToDefault: (paths) => {
        const {pendingSettings, settings} = get()
        const base = pendingSettings || settings
        // JSON 深拷贝：settings 为纯 JSON 结构；避免写穿共享子树
        const updated = JSON.parse(JSON.stringify(base)) as SystemSettings
        for (const path of paths) {
            let defaultValue: unknown = DEFAULT_SETTINGS
            for (const part of path.split('.')) {
                defaultValue = (defaultValue as Record<string, unknown> | undefined)?.[part]
            }
            setPathValue(updated as Record<string, any>, path, defaultValue)
        }
        set({pendingSettings: updated, isDirty: true})
    },

    resetAllToDefault: () => {
        const {pendingSettings, settings} = get()
        const base = pendingSettings || settings
        const updated = mergeSystemSettings(base, DEFAULT_SETTINGS)
        // merge 的标量语义是 `patch ?? base`：缺省 undefined 的 fullSkillDescriptions 会保留旧值，故显式复位
        updated.fullSkillDescriptions = DEFAULT_SETTINGS.fullSkillDescriptions
        set({pendingSettings: updated, isDirty: true})
    },

    saveSettings: async () => {
        const {pendingSettings} = get()
        if (!pendingSettings) return

        try {
            // 1. 先写入数据库，成功后才更新本地状态
            const ok = await window.electronAPI?.configWrite('settings', pendingSettings)
            if (!ok) {
                throw new Error('数据库写入失败')
            }
            // 在 set({settings}) 之前捕获旧阈值（spec 3.2：仅阈值变更时恢复"不再提醒"抑制标记）
            const oldHandoffSig = handoffThresholdSignature(get().settings?.agent)

            // 2. 广播到运行中的 Agent
            const broadcastResult = await window.electronAPI?.settingsUpdate?.(pendingSettings as any)
            if (broadcastResult && !broadcastResult.success) {
                console.warn('[Settings] Agent 同步警告:', broadcastResult.error)
            }

            // 3. 输入栏显示漂移修正：全局权威键（permission_mode / message-display-mode）的写库与广播
            //    由主进程传播助手（propagateSystemSettings）统一落位（spec §6.2）；
            //    渲染端只保留激活会话的显示漂移修正（meta 覆盖 → 否则回退全局默认）。
            const newPermDefault = pendingSettings.agent?.defaultPermissionMode
            if (newPermDefault) {
                const activeConvId = useConversationStore.getState().activeConversationId
                if (activeConvId) await applyConvModesToAgentStore(activeConvId)
            }

            set({settings: pendingSettings})

            // 4. 同步主题到 themeStore（须放在 set({settings}) 之后：
            //    resolveAndApplyTheme 读取的 settings 是本次 pending（含背景启用状态），
            //    修正 "system + 本次启用背景" 被解析为 light 的角例）
            const prevTheme = useThemeStore.getState().theme
            resolveAndApplyTheme(pendingSettings.ui.theme)

            // 5. 广播主题变更：走既有 set-window-theme 权威通道（titleBarOverlay + 广播 theme-changed 给所有窗口）
            //    传 themeStore 解析后的值（上面 resolveAndApplyTheme 已把 'system' 解析为具体主题），
            //    避免 'system' 原值导致 titleBarOverlay 走浅色兜底、独立窗口 applyThemeClass 不解析。
            //    主题未变（resolve 前后同值）时跳过重广播。
            if (useThemeStore.getState().theme !== prevTheme) {
                window.electronAPI?.setWindowTheme?.(useThemeStore.getState().theme)?.catch(() => {})
            }

            // 阈值调整后恢复各会话的"不再提醒"抑制标记（spec 3.2：仅阈值变更时恢复）
            const newHandoffSig = handoffThresholdSignature(pendingSettings.agent)
            if (oldHandoffSig !== newHandoffSig) {
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
        const newSettings = mergeSystemSettings(currentSettings, updates)

        try {
            const ok = await window.electronAPI?.configWrite('settings', newSettings)
            if (!ok) {
                throw new Error('数据库写入失败')
            }
            set({settings: newSettings})

            // 快捷键 ↔ pending 镜像（spec §5.2）：仅当本次 updates 含 shortcuts 且 pending 非空时镜像写库后值。
            // 不做无条件镜像：主题切换等无关调用也走此路径，无条件镜像会误抹「键位恢复默认」结果。
            const {pendingSettings} = get()
            if (updates.shortcuts !== undefined && pendingSettings) {
                set({pendingSettings: {...pendingSettings, shortcuts: newSettings.shortcuts}})
            }

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
            if (broadcastResult && !broadcastResult.success) {
                console.warn('[Settings] Agent 同步警告:', broadcastResult.error)
            }
        } catch (err) {
            console.error('[Settings] 更新失败:', err)
            throw err
        }
    }
}))
