import {create} from 'zustand'
import {persist, type PersistStorage} from 'zustand/middleware'
import {sqliteStorage} from '../lib/sqliteStorage'
import {useLLMStore} from './llmStore'
import {useToolStore} from './toolStore'
import type {ModelRole, ModelScheme, ModelSchemeRole, ModelType} from '@shared/types'

// Re-export for consumers
export type {ModelScheme, ModelSchemeRole, ModelType, ModelRole}

// ─── 预设模板 ─────────────────────────────────────────────

export interface SchemePreset {
    id: string
    name: string
    description: string
    icon: string
    config: {
        primary: {enabled: boolean}
        lightweight: {enabled: boolean}
        reasoning: {enabled: boolean}
    }
}

/** 内置方案模板 */
export const SCHEME_PRESETS: SchemePreset[] = [
    {
        id: 'balanced',
        name: '平衡方案',
        description: '所有任务使用同一模型，简单配置',
        icon: '⚖️',
        config: {
            primary: {enabled: true},
            lightweight: {enabled: false},
            reasoning: {enabled: false},
        },
    },
    {
        id: 'economy',
        name: '经济方案',
        description: '主力用大模型，简单任务用小模型节省成本',
        icon: '💰',
        config: {
            primary: {enabled: true},
            lightweight: {enabled: true},
            reasoning: {enabled: false},
        },
    },
    {
        id: 'performance',
        name: '高性能方案',
        description: '主力 + 推理模型，复杂任务自动启用深度推理',
        icon: '🚀',
        config: {
            primary: {enabled: true},
            lightweight: {enabled: false},
            reasoning: {enabled: true},
        },
    },
    {
        id: 'full',
        name: '完整方案',
        description: '三种角色全启用，自动根据任务复杂度选择',
        icon: '🎯',
        config: {
            primary: {enabled: true},
            lightweight: {enabled: true},
            reasoning: {enabled: true},
        },
    },
]

// ─── Default Role Helper ─────────────────────────────────────

const createDefaultRole = (
    role: ModelRole,
    modelType: ModelType = 'text'
): ModelSchemeRole => ({
    id: crypto.randomUUID(),
    role,
    endpointId: '',
    modelId: '',
    modelType,
    enabled: role === 'primary',
    ...(role === 'reasoning' ? {thinkingEffort: 'auto' as const} : {}),
})

// ─── Store 类型定义 ─────────────────────────────────────────

interface ModelSchemeStore {
    /** 所有方案 */
    schemes: ModelScheme[]
    /** 当前激活的方案 ID */
    activeSchemeId: string | null
    /** 预设模板列表 */
    presetTemplates: SchemePreset[]
    /** 持久化是否已完成 */
    hasRehydrated: boolean

    // ─── 方案 CRUD ───────────────────────────────────────

    /** 添加方案 */
    addScheme: (scheme: Omit<ModelScheme, 'id'>) => string
    /** 更新方案 */
    updateScheme: (id: string, updates: Partial<ModelScheme>) => void
    /** 删除方案 */
    removeScheme: (id: string) => Promise<void>
    /** 复制方案 */
    duplicateScheme: (id: string) => string
    /** 设置激活方案 */
    setActiveScheme: (id: string | null) => void
    /** 从预设模板创建方案 */
    createFromPreset: (presetId: string) => string

    // ─── 角色配置 ─────────────────────────────────────────

    /** 更新某个角色的配置 */
    updateRoleConfig: (
        schemeId: string,
        role: string,
        config: Partial<Omit<ModelSchemeRole, 'id' | 'role'>>
    ) => void

    // ─── 运行时获取 ───────────────────────────────────────

    /** 获取激活的方案 */
    getActiveScheme: () => ModelScheme | null
    /** 获取某个角色的完整模型配置（解析 endpoint + model） */
    getModelConfigForRole: (role: ModelRole) => {
        provider: string
        model: string
        apiKey?: string
        baseUrl?: string
    } | null
}

// ─── Store 实现 ───────────────────────────────────────────

export const useModelSchemeStore = create<ModelSchemeStore>()(
    persist(
        (set, get) => ({
            schemes: [],
            activeSchemeId: null,
            presetTemplates: SCHEME_PRESETS,
            hasRehydrated: false,

            // ─── 方案 CRUD ─────────────────────────────────────

            addScheme: (scheme) => {
                const id = crypto.randomUUID()
                // Generate IDs for all roles that don't have them
                const rolesWithIds = scheme.roles.map((r) => ({
                    ...r,
                    id: r.id || crypto.randomUUID(),
                }))
                set((state) => ({
                    schemes: [...state.schemes, {...scheme, id, roles: rolesWithIds}],
                    // 如果是第一个方案，自动激活
                    activeSchemeId: state.activeSchemeId || id,
                }))
                return id
            },

            updateScheme: (id, updates) => {
                set((state) => ({
                    schemes: state.schemes.map((s) => {
                        if (s.id !== id) return s
                        // Generate IDs for new roles in updates.roles
                        const updatedRoles = updates.roles?.map((r) => ({
                            ...r,
                            id: r.id || crypto.randomUUID(),
                        }))
                        return {...s, ...updates, roles: updatedRoles ?? s.roles}
                    }),
                }))
            },

            removeScheme: async (id) => {
                // 先同步删除 SQLite（参考 promptSchemeStore 的实现）
                try {
                    if (typeof window !== 'undefined' && window.electronAPI?.modelScheme?.delete) {
                        const result = await window.electronAPI.modelScheme.delete(id)
                        if (!result?.success) {
                            console.error('[ModelSchemeStore] delete failed:', result?.error)
                        }
                    }
                } catch (err) {
                    console.error('[ModelSchemeStore] delete sync failed:', err)
                }
                // 再更新内存状态
                set((state) => {
                    const newSchemes = state.schemes.filter((s) => s.id !== id)
                    const wasActive = state.activeSchemeId === id

                    // 如果删除的是激活方案，选择第一个可用方案
                    let newActiveId = wasActive
                        ? newSchemes[0]?.id || null
                        : state.activeSchemeId

                    return {
                        schemes: newSchemes,
                        activeSchemeId: newActiveId,
                    }
                })
            },

            duplicateScheme: (id) => {
                const scheme = get().schemes.find((s) => s.id === id)
                if (!scheme) return ''

                const newId = crypto.randomUUID()
                // Deep copy with new IDs for all roles
                const newRoles = scheme.roles.map((r) => ({
                    ...r,
                    id: crypto.randomUUID(),
                }))
                const newScheme: ModelScheme = {
                    ...scheme,
                    id: newId,
                    name: `${scheme.name} (副本)`,
                    roles: newRoles,
                }

                set((state) => ({
                    schemes: [...state.schemes, newScheme],
                }))
                return newId
            },

            setActiveScheme: (id) => {
                set({activeSchemeId: id})
            },

            createFromPreset: (presetId) => {
                const preset = SCHEME_PRESETS.find((p) => p.id === presetId)
                if (!preset) return ''

                const id = crypto.randomUUID()
                // Create a scheme with ALL 10 roles
                const newScheme: ModelScheme = {
                    id,
                    name: preset.name,
                    description: preset.description,
                    roles: [
                        createDefaultRole('primary', 'text'),
                        preset.config.lightweight.enabled
                            ? createDefaultRole('lightweight', 'text')
                            : {...createDefaultRole('lightweight', 'text'), enabled: false},
                        preset.config.reasoning.enabled
                            ? createDefaultRole('reasoning', 'text')
                            : {...createDefaultRole('reasoning', 'text'), enabled: false},
                        createDefaultRole('image_understanding', 'image'),
                    ],
                    enabled: true,
                }

                set((state) => ({
                    schemes: [...state.schemes, newScheme],
                    activeSchemeId: state.activeSchemeId || id,
                }))
                return id
            },

            // ─── 角色配置 ───────────────────────────────────────

            updateRoleConfig: (schemeId, role, config) => {
                set((state) => ({
                    schemes: state.schemes.map((s) => {
                        if (s.id !== schemeId) return s
                        return {
                            ...s,
                            roles: s.roles.map((r) =>
                                r.role === role ? {...r, ...config} : r
                            ),
                        }
                    }),
                }))
            },

            // ─── 运行时获取 ─────────────────────────────────────

            getActiveScheme: () => {
                const state = get()
                return state.schemes.find((s) => s.id === state.activeSchemeId) || null
            },

            getModelConfigForRole: (role) => {
                const scheme = get().getActiveScheme()
                if (!scheme) return null

                // Find role by role field in roles[], fallback to primary if disabled
                let roleConfig = scheme.roles.find((r) => r.role === role)
                if (!roleConfig?.enabled && role !== 'primary') {
                    roleConfig = scheme.roles.find((r) => r.role === 'primary')
                }
                if (!roleConfig) return null

                // 从 llmStore 获取 endpoint 信息
                const llmState = useLLMStore.getState()
                const provider = llmState.providers.find(
                    (p) => p.id === roleConfig.endpointId
                )
                if (!provider) return null

                const model = provider.models.find((m) => m.id === roleConfig.modelId)
                if (!model) return null

                // 返回解析后的配置
                return {
                    provider: provider.type,
                    model: model.name,
                    apiKey: provider.credentials?.apiKey,
                    baseUrl: provider.baseUrl,
                }
            },
        }),
        {
            name: 'model-schemes',
            storage: sqliteStorage as PersistStorage<ModelSchemeStore>,
            version: 1,
            onRehydrateStorage: () => (state) => {
                state && (state.hasRehydrated = true)
            },
        }
    )
)

// ─── 辅助函数 ─────────────────────────────────────────────

/**
 * 初始化默认方案（首次启动时调用）
 * 使用当前 llmStore 的激活配置创建默认方案
 */
export async function initializeDefaultScheme(): Promise<void> {
    const store = useModelSchemeStore.getState()

    // 如果已有方案，跳过
    if (store.schemes.length > 0) return

    const llmState = useLLMStore.getState()
    const activeProvider = llmState.providers.find(
        (p) => p.id === llmState.activeProviderId
    )
    const activeModel = activeProvider?.models.find(
        (m) => m.id === llmState.activeModelId
    )

    if (!activeProvider || !activeModel) {
        return
    }

    // 创建默认方案，所有角色使用同一模型，但只有 primary 默认启用
    const defaultScheme: Omit<ModelScheme, 'id'> = {
        name: '默认方案',
        description: '所有任务使用同一模型',
        roles: [
            {
                id: crypto.randomUUID(),
                role: 'primary',
                endpointId: activeProvider.id,
                modelId: activeModel.id,
                modelType: 'text',
                enabled: true,
            },
            {
                id: crypto.randomUUID(),
                role: 'lightweight',
                endpointId: activeProvider.id,
                modelId: activeModel.id,
                modelType: 'text',
                enabled: false,
            },
            {
                id: crypto.randomUUID(),
                role: 'reasoning',
                endpointId: activeProvider.id,
                modelId: activeModel.id,
                modelType: 'text',
                enabled: false,
                thinkingEffort: 'auto',
            },
            {
                id: crypto.randomUUID(),
                role: 'image_understanding',
                endpointId: activeProvider.id,
                modelId: activeModel.id,
                modelType: 'image',
                enabled: false,
            },
        ],
        enabled: true,
    }

    store.addScheme(defaultScheme)
}

/**
 * 获取当前激活方案的显示名称
 */
export function getActiveSchemeName(): string {
    const scheme = useModelSchemeStore.getState().getActiveScheme()
    return scheme?.name || '未配置'
}

/**
 * 切换模型方案
 *
 * 更新渲染进程的方案状态，并通知主进程更新全局管理器。
 * 下次 LLM 调用时会自动使用新方案。
 *
 * 注意：此函数不会中断正在运行的 agent loop，
 * 方案变更会在当前 turn 结束后（下次 LLM 调用时）自动生效。
 *
 * @param id 方案 ID
 * @returns 切换结果
 */
export async function switchActiveScheme(id: string): Promise<{
    switched: boolean
    schemeName: string | null
    error?: string
}> {
    const store = useModelSchemeStore.getState()
    const currentSchemeId = store.activeSchemeId

    // 如果切换到相同方案，直接返回
    if (currentSchemeId === id) {
        return {switched: false, schemeName: null}
    }

    // 获取旧方案名称用于日志
    const oldScheme = store.getActiveScheme()
    const oldSchemeName = oldScheme?.name || 'unknown'

    // 更新渲染进程的方案状态
    store.setActiveScheme(id)

    // 获取新方案配置
    const newScheme = store.getActiveScheme()
    if (!newScheme) {
        const error = `Scheme not found after switch: ${id}`
        // 回滚：恢复旧方案
        store.setActiveScheme(currentSchemeId)
        return {switched: false, schemeName: null, error}
    }

    // 获取服务商列表并解密
    const llmState = useLLMStore.getState()
    const decryptedProviders = await llmState.getAllDecryptedProviders()

    // 通知主进程更新全局管理器
    // 主进程会在下次 LLM 调用时自动使用新方案
    try {
        if (
            typeof window !== 'undefined' &&
            window.electronAPI?.updateModelScheme
        ) {
            const result = await window.electronAPI.updateModelScheme({
                schemeId: newScheme.id,
                scheme: newScheme,
                providers: decryptedProviders,
            })

            // 检查主进程是否成功更新
            if (!result?.success) {
                const errorMsg = result?.error || 'Unknown error'
                // 回滚：恢复旧方案
                store.setActiveScheme(currentSchemeId)
                return {switched: false, schemeName: null, error: errorMsg}
            }
        }
    } catch (err: any) {
        const errorMsg = err?.message || String(err)
        // 回滚：恢复旧方案
        store.setActiveScheme(currentSchemeId)
        return {switched: false, schemeName: null, error: errorMsg}
    }

    // 方案切换后刷新工具列表（analyze_image 启用状态可能已同步改变）
    try {
        useToolStore.getState().loadTools()
    } catch { /* 安全兜底 */
    }

    return {switched: true, schemeName: newScheme.name}
}
