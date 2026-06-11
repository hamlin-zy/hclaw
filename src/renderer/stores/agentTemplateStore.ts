import {create} from 'zustand'
import type {AgentTemplate} from '@shared/types'

/**
 * Agent 模版 Store
 *
 * 管理预设和自定义的 Agent 模版（提示词、工具集、关联技能等）。
 */

interface AgentTemplateStore {
    templates: AgentTemplate[]
    loadErrors: Array<{ filePath: string; agentName?: string; error: string; timestamp: number }>
    loading: boolean
    initialized: boolean

    // CRUD 操作
    addTemplate: (template: Omit<AgentTemplate, 'id' | 'createdAt' | 'updatedAt'>) => Promise<string | undefined>
    updateTemplate: (id: string, updates: Partial<Omit<AgentTemplate, 'id' | 'createdAt' | 'updatedAt'>>) => Promise<void>
    removeTemplate: (id: string) => Promise<void>
    toggleTemplate: (id: string) => Promise<void>
    toggleTemplateBatch: (templateIds: string[], enabled: boolean) => Promise<void>
    getTemplate: (id: string) => AgentTemplate | undefined

    // 同步操作
    syncFromDisk: () => Promise<{ success: boolean; count?: number; error?: string }>
    updateTemplateDescription: (id: string, whenToUse: string) => Promise<{ success: boolean; error?: string }>

    // 初始化
    init: () => Promise<void>
}

/** 读取 agents 扫描结果到 store */
function applyScanResult(
    set: (fn: Partial<AgentTemplateStore> | ((state: AgentTemplateStore) => Partial<AgentTemplateStore>)) => void,
    result: {success: boolean; templates?: AgentTemplate[]; loadErrors?: Array<any>; error?: string},
): boolean {
    if (result?.success) {
        set({templates: result.templates || [], loadErrors: result.loadErrors || [], loading: false})
        return true
    }
    return false
}

export const useAgentTemplateStore = create<AgentTemplateStore>()(
    (set, get) => ({
        templates: [],
        loadErrors: [],
        loading: false,
        initialized: false,

        addTemplate: async (input) => {
            set({loading: true})
            try {
                const result = await window.electronAPI?.agentsCreate?.(input)
                if (result?.success) {
                    const scanResult = await window.electronAPI?.agentsScan?.() ?? {success: false}
                    if (scanResult.success) {
                        applyScanResult(set, scanResult)
                        return scanResult.templates?.find(t => t.name === input.name)?.id
                    }
                }
                set({loading: false})
                throw new Error(result?.error || 'Failed to create template')
            } catch (err: any) {
                set({loading: false})
                throw err
            }
        },

        updateTemplate: async (id, updates) => {
            set({loading: true})
            try {
                const result = await window.electronAPI?.agentsUpdate?.(id, updates)
                if (result?.success) {
                    set(state => ({
                        templates: state.templates.map(t =>
                            t.id === id ? {...t, ...updates, updatedAt: Date.now()} : t,
                        ),
                        loading: false,
                    }))
                }
            } catch (err: any) {
                set({loading: false})
                throw err
            }
        },

        removeTemplate: async (id) => {
            set({loading: true})
            try {
                const result = await window.electronAPI?.agentsDelete?.(id)
                if (result?.success) {
                    set(state => ({templates: state.templates.filter(t => t.id !== id), loading: false}))
                } else {
                    set({loading: false})
                    throw new Error(result?.error || 'Failed to delete template')
                }
            } catch (err: any) {
                set({loading: false})
                throw err
            }
        },

        toggleTemplate: async (id) => {
            const template = get().templates.find(t => t.id === id)
            if (!template) return
            const newEnabled = !template.enabled
            set(state => ({
                templates: state.templates.map(t =>
                    t.id === id ? {...t, enabled: newEnabled, updatedAt: Date.now()} : t,
                ),
            }))
            try {
                await window.electronAPI?.agentsUpdate?.(id, {enabled: newEnabled})
            } catch {
                set(state => ({
                    templates: state.templates.map(t =>
                        t.id === id ? {...t, enabled: template.enabled, updatedAt: template.updatedAt} : t,
                    ),
                }))
            }
        },

        toggleTemplateBatch: async (templateIds, enabled) => {
            if (templateIds.length === 0) return
            const prev = get().templates
            set(state => ({
                templates: state.templates.map(t =>
                    templateIds.includes(t.id) ? {...t, enabled, updatedAt: Date.now()} : t,
                ),
            }))
            try {
                const result = await window.electronAPI?.agentsToggleBatch?.({templateIds, enabled})
                if (result?.templates) {
                    set({templates: result.templates})
                }
            } catch {
                set({templates: prev})
            }
        },

        getTemplate: (id) => get().templates.find(t => t.id === id),

        syncFromDisk: async () => {
            set({loading: true})
            try {
                const result = await window.electronAPI?.agentsScan?.(true)
                if (result?.success && result.templates) {
                    set({templates: result.templates, loadErrors: result.loadErrors || [], loading: false})
                    return {success: true, count: result.templates.length}
                }
                set({loading: false})
                return {success: false, error: result?.error || 'Unknown error'}
            } catch (err: any) {
                set({loading: false})
                return {success: false, error: err.message}
            }
        },

        updateTemplateDescription: async (id, whenToUse) => {
            set({loading: true})
            try {
                const result = await window.electronAPI?.agentsUpdate?.(id, {whenToUse})
                if (result?.success) {
                    set(state => ({
                        templates: state.templates.map(t =>
                            t.id === id ? {...t, whenToUse, updatedAt: Date.now()} : t,
                        ),
                        loading: false,
                    }))
                    return {success: true}
                }
                set({loading: false})
                return {success: false, error: result?.error || 'Failed to update'}
            } catch (err: any) {
                set({loading: false})
                return {success: false, error: err.message}
            }
        },

        init: async () => {
            if (get().initialized) return
            set({loading: true})
            try {
                const result = await window.electronAPI?.agentsScan?.()
                if (result?.success) {
                    set({templates: result.templates || [], loadErrors: result.loadErrors || []})
                }
            } catch {
                // 静默处理错误，使用空模板
            }
            set({loading: false, initialized: true})
        },
    }),
)
