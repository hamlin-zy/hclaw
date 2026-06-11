/**
 * 用户命令状态管理 Store
 *
 * 基于 zustand，管理与用户自定义命令相关的状态。
 */

import {create} from 'zustand'

export interface UserCommand {
    id: string
    name: string
    description?: string
    content: string
    args?: Array<{name: string; description?: string; required?: boolean; default?: string}>
    tags?: string[]
    enabled: boolean
    triggerType?: 'none' | 'skill' | 'agent'
    triggerTarget?: string
    createdAt: number
    updatedAt: number
}

interface UserCommandStore {
    commands: UserCommand[]
    loading: boolean
    initialized: boolean

    loadCommands: () => Promise<void>
    createCommand: (input: {
        name: string
        description?: string
        content: string
        args?: Array<{name: string; description?: string; required?: boolean; default?: string}>
        tags?: string[]
        enabled?: boolean
    }) => Promise<{success: boolean; command?: UserCommand; error?: string}>
    updateCommand: (id: string, updates: Partial<{
        name: string
        description: string
        content: string
        args: Array<{name: string; description?: string; required?: boolean; default?: string}>
        tags: string[]
        enabled: boolean
    }>) => Promise<{success: boolean; error?: string}>
    deleteCommand: (id: string) => Promise<{success: boolean; error?: string}>
    toggleCommand: (id: string, enabled: boolean) => Promise<{success: boolean; error?: string}>
    importCommands: (commands: any[]) => Promise<{success: boolean; imported?: number; skipped?: number; error?: string}>
    exportCommands: () => Promise<{success: boolean; commands?: any[]; error?: string}>
}

export const useUserCommandStore = create<UserCommandStore>((set) => ({
    commands: [],
    loading: false,
    initialized: false,

    loadCommands: async () => {
        set({loading: true})
        try {
            const result = await window.electronAPI?.command?.getUserCommands?.()
            if (result && (result as any).success) {
                set({commands: (result as any).data || [], initialized: true})
            } else if (Array.isArray(result)) {
                // 兼容旧格式
                set({commands: result as UserCommand[], initialized: true})
            }
        } catch {
            // silent
        } finally {
            set({loading: false})
        }
    },

    createCommand: async (input) => {
        try {
            const result = await window.electronAPI?.command?.create?.(input)
            if (result?.success) {
                // Reload
                const store = useUserCommandStore.getState()
                await store.loadCommands()
                return {success: true, command: (result as any).command}
            }
            return {success: false, error: result?.error || 'Failed to create command'}
        } catch (err: any) {
            return {success: false, error: err.message}
        }
    },

    updateCommand: async (id, updates) => {
        try {
            const result = await window.electronAPI?.command?.update?.(id, updates)
            if (result?.success) {
                const store = useUserCommandStore.getState()
                await store.loadCommands()
                return {success: true}
            }
            return {success: false, error: result?.error || 'Failed to update command'}
        } catch (err: any) {
            return {success: false, error: err.message}
        }
    },

    deleteCommand: async (id) => {
        try {
            const result = await window.electronAPI?.command?.delete?.(id)
            if (result?.success) {
                const store = useUserCommandStore.getState()
                await store.loadCommands()
                return {success: true}
            }
            return {success: false, error: result?.error || 'Failed to delete command'}
        } catch (err: any) {
            return {success: false, error: err.message}
        }
    },

    toggleCommand: async (id, enabled) => {
        try {
            const result = await window.electronAPI?.command?.toggle?.(id, enabled)
            if (result?.success) {
                const store = useUserCommandStore.getState()
                await store.loadCommands()
                return {success: true}
            }
            return {success: false, error: result?.error || 'Failed to toggle command'}
        } catch (err: any) {
            return {success: false, error: err.message}
        }
    },

    importCommands: async (commands) => {
        try {
            const result = await window.electronAPI?.command?.import?.(commands)
            if (result?.success) {
                const store = useUserCommandStore.getState()
                await store.loadCommands()
                return {success: true, imported: (result as any).imported, skipped: (result as any).skipped}
            }
            return {success: false, error: result?.error || 'Failed to import commands'}
        } catch (err: any) {
            return {success: false, error: err.message}
        }
    },

    exportCommands: async () => {
        try {
            const result = await window.electronAPI?.command?.export?.()
            if (result?.success) {
                return {success: true, commands: (result as any).commands}
            }
            return {success: false, error: result?.error || 'Failed to export commands'}
        } catch (err: any) {
            return {success: false, error: err.message}
        }
    },
}))
