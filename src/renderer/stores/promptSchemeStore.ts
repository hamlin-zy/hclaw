import {create} from 'zustand'
import {persist, type PersistStorage} from 'zustand/middleware'
import {sqliteStorage} from '../lib/sqliteStorage'
import type {PromptNodeKey, PromptScheme} from '@shared/types'

// Re-export for consumers
export type {PromptScheme}

// ─── Store 类型定义 ─────────────────────────────────────────

interface PromptSchemeStore {
    /** 所有方案 */
    schemes: PromptScheme[]
    /** 当前激活的提示词方案 ID */
    activePromptSchemeId: string | null
    /** 持久化是否已完成 */
    hasRehydrated: boolean

    // ─── 方案 CRUD ───────────────────────────────────────

    /** 添加方案 */
    addScheme: (scheme: Omit<PromptScheme, 'id'>) => string
    /** 更新方案 */
    updateScheme: (id: string, updates: Partial<PromptScheme>) => void
    /** 删除方案 */
    removeScheme: (id: string) => void
    /** 复制方案 */
    duplicateScheme: (id: string) => string
    /** 设置激活方案 */
    setActiveScheme: (id: string | null) => Promise<void>

    // ─── 节点编辑 ─────────────────────────────────────────

    /** 设置某个节点的覆盖内容 */
    setNode: (schemeId: string, key: PromptNodeKey, value: string) => void
    /** 重置某个节点（删除覆盖） */
    resetNode: (schemeId: string, key: PromptNodeKey) => void
    /** 重置方案的所有节点 */
    resetAllNodes: (schemeId: string) => void

    // ─── 运行时获取 ───────────────────────────────────────

    /** 获取激活的方案 */
    getActiveScheme: () => PromptScheme | null
    /** 根据 ID 获取方案 */
    getSchemeById: (id: string) => PromptScheme | undefined
}

// ─── Store 实现 ───────────────────────────────────────────

export const usePromptSchemeStore = create<PromptSchemeStore>()(
    persist(
        (set, get) => ({
            schemes: [],
            activePromptSchemeId: null,
            hasRehydrated: false,

            // ─── 方案 CRUD ─────────────────────────────────────

            addScheme: (scheme) => {
                const id = crypto.randomUUID()
                set((state) => ({
                    schemes: [...state.schemes, {...scheme, id}],
                    activePromptSchemeId: state.activePromptSchemeId || id,
                }))
                return id
            },

            updateScheme: (id, updates) => {
                set((state) => ({
                    schemes: state.schemes.map((s) =>
                        s.id === id ? {...s, ...updates} : s
                    ),
                }))
            },

            removeScheme: async (id) => {
                // 先同步删除 SQLite
                try {
                    if (typeof window !== 'undefined' && window.electronAPI?.promptScheme?.delete) {
                        const result = await window.electronAPI.promptScheme.delete(id)
                        if (!result?.success) {
                            console.error('[PromptSchemeStore] delete failed:', result?.error)
                        }
                    }
                } catch (err) {
                    console.error('[PromptSchemeStore] delete sync failed:', err)
                }
                // 再更新内存状态
                set((state) => {
                    const newSchemes = state.schemes.filter((s) => s.id !== id)
                    const wasActive = state.activePromptSchemeId === id
                    const newActiveId = wasActive
                        ? newSchemes[0]?.id || null
                        : state.activePromptSchemeId
                    return {
                        schemes: newSchemes,
                        activePromptSchemeId: newActiveId,
                    }
                })
            },

            duplicateScheme: (id) => {
                const scheme = get().schemes.find((s) => s.id === id)
                if (!scheme) return ''

                const newId = crypto.randomUUID()
                const newScheme: PromptScheme = {
                    ...scheme,
                    id: newId,
                    name: `${scheme.name} (副本)`,
                    nodes: {...scheme.nodes},
                }

                set((state) => ({
                    schemes: [...state.schemes, newScheme],
                }))
                return newId
            },

            setActiveScheme: async (id) => {
                set({activePromptSchemeId: id})
                // 同步主进程的 PromptResolver
                try {
                    if (typeof window !== 'undefined' && window.electronAPI?.updatePromptScheme) {
                        await window.electronAPI.updatePromptScheme(id)
                    }
                } catch (err) {
                    console.error('[PromptSchemeStore] setActiveScheme sync failed:', err)
                }
            },

            // ─── 节点编辑 ───────────────────────────────────────

            setNode: (schemeId, key, value) => {
                set((state) => ({
                    schemes: state.schemes.map((s) => {
                        if (s.id !== schemeId) return s
                        return {
                            ...s,
                            nodes: {...s.nodes, [key]: value},
                        }
                    }),
                }))
            },

            resetNode: (schemeId, key) => {
                set((state) => ({
                    schemes: state.schemes.map((s) => {
                        if (s.id !== schemeId) return s
                        const {[key]: _, ...rest} = s.nodes
                        return {...s, nodes: rest as Partial<Record<PromptNodeKey, string>>}
                    }),
                }))
            },

            resetAllNodes: (schemeId) => {
                set((state) => ({
                    schemes: state.schemes.map((s) =>
                        s.id === schemeId ? {...s, nodes: {}} : s
                    ),
                }))
            },

            // ─── 运行时获取 ─────────────────────────────────────

            getActiveScheme: () => {
                const state = get()
                return state.schemes.find((s) => s.id === state.activePromptSchemeId) || null
            },

            getSchemeById: (id) => {
                return get().schemes.find((s) => s.id === id)
            },
        }),
        {
            name: 'prompt-schemes',
            storage: sqliteStorage as PersistStorage<PromptSchemeStore>,
            version: 1,
            onRehydrateStorage: () => (state) => {
                state && (state.hasRehydrated = true)
            },
        }
    )
)
