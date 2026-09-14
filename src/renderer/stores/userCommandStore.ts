/**
 * 用户命令状态管理 Store
 *
 * 基于 zustand，管理与用户自定义命令相关的状态。
 *
 * 写操作统一走 applyOptimistic：先乐观改写内存 → 持久化 → 失败回滚，
 * 错误统一规范化为字符串，不再「每次变更全量 loadCommands()」。
 */

import {create} from 'zustand'
import {applyOptimistic} from './applyOptimistic'

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

export const useUserCommandStore = create<UserCommandStore>((set, get) => ({
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
            // 读取失败保持旧数据（可由上层页面轮询/刷新兜底）
        } finally {
            set({loading: false})
        }
    },

    createCommand: async (input) => {
        const now = Date.now()
        const tempId = `optimistic:${now}`
        const optimistic: UserCommand = {
            id: tempId,
            name: input.name,
            description: input.description,
            content: input.content,
            args: input.args,
            tags: input.tags,
            enabled: input.enabled ?? true,
            createdAt: now,
            updatedAt: now,
        }

        const prev = get().commands
        const result = await applyOptimistic<UserCommand[], {success: boolean; command?: UserCommand}>({
            snapshot: () => set({commands: prev}),
            mutate: () => set((s) => ({commands: [...s.commands, optimistic]})),
            persist: async () => {
                const r = await window.electronAPI?.command?.create?.(input)
                if (!r?.success) throw new Error(r?.error || 'Failed to create command')
                return r as {success: boolean; command?: UserCommand}
            },
        })

        if (!result.ok) return {success: false, error: result.error}

        // 成功：用服务端返回的真实命令替换乐观占位（无返回时保留乐观项）
        const created = result.data?.command
        if (created) {
            set((s) => ({commands: s.commands.map((c) => (c.id === tempId ? created : c))}))
        }
        return {success: true, command: created ?? optimistic}
    },

    updateCommand: async (id, updates) => {
        const prev = get().commands
        const result = await applyOptimistic<UserCommand[], {success: boolean}>({
            snapshot: () => set({commands: prev}),
            mutate: () => set((s) => ({
                commands: s.commands.map((c) => (c.id === id ? {...c, ...updates, updatedAt: Date.now()} : c)),
            })),
            persist: async () => {
                const r = await window.electronAPI?.command?.update?.(id, updates)
                if (!r?.success) throw new Error(r?.error || 'Failed to update command')
                return r
            },
        })
        return result.ok ? {success: true} : {success: false, error: result.error}
    },

    deleteCommand: async (id) => {
        const prev = get().commands
        const result = await applyOptimistic<UserCommand[], {success: boolean}>({
            snapshot: () => set({commands: prev}),
            mutate: () => set((s) => ({commands: s.commands.filter((c) => c.id !== id)})),
            persist: async () => {
                const r = await window.electronAPI?.command?.delete?.(id)
                if (!r?.success) throw new Error(r?.error || 'Failed to delete command')
                return r
            },
        })
        return result.ok ? {success: true} : {success: false, error: result.error}
    },

    toggleCommand: async (id, enabled) => {
        const prev = get().commands
        const result = await applyOptimistic<UserCommand[], {success: boolean}>({
            snapshot: () => set({commands: prev}),
            mutate: () => set((s) => ({
                commands: s.commands.map((c) => (c.id === id ? {...c, enabled} : c)),
            })),
            persist: async () => {
                const r = await window.electronAPI?.command?.toggle?.(id, enabled)
                if (!r?.success) throw new Error(r?.error || 'Failed to toggle command')
                return r
            },
        })
        return result.ok ? {success: true} : {success: false, error: result.error}
    },

    importCommands: async (commands) => {
        const now = Date.now()
        const optimistic: UserCommand[] = commands.map((c, i) => ({
            id: `optimistic:${now}:${i}`,
            name: c.name,
            description: c.description,
            content: c.content,
            args: c.args,
            enabled: c.enabled ?? true,
            createdAt: now,
            updatedAt: now,
        }))

        const prev = get().commands
        const result = await applyOptimistic<UserCommand[], {success: boolean; imported?: number; skipped?: number}>({
            snapshot: () => set({commands: prev}),
            mutate: () => set((s) => ({commands: [...s.commands, ...optimistic]})),
            persist: async () => {
                const r = await window.electronAPI?.command?.import?.(commands)
                if (!r?.success) throw new Error(r?.error || 'Failed to import commands')
                return r as {success: boolean; imported?: number; skipped?: number}
            },
        })

        if (!result.ok) return {success: false, error: result.error}

        // 导入含去重/跳过语义，服务端结果为权威：成功后全量校对一次
        await get().loadCommands()
        return {success: true, imported: result.data?.imported, skipped: result.data?.skipped}
    },

    exportCommands: async () => {
        try {
            const result = await window.electronAPI?.command?.export?.()
            if (result?.success) {
                return {success: true, commands: (result as any).commands}
            }
            return {success: false, error: result?.error || 'Failed to export commands'}
        } catch (err: any) {
            return {success: false, error: err?.message || String(err)}
        }
    },
}))
