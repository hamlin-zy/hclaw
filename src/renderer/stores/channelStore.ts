import {create} from 'zustand'
import type {ChannelConfig, ChannelType} from '@shared/types'

export interface ChannelUI extends ChannelConfig {}

function toUI(r: any): ChannelUI {
    return {
        id: r.id, name: r.name, type: r.type, enabled: r.enabled,
        config: r.config || {}, status: r.status || 'disconnected',
        statusMessage: r.statusMessage || '',
        lastConnectedAt: r.lastConnectedAt || null,
        errorCount: r.errorCount || 0, createdAt: r.createdAt, updatedAt: r.updatedAt,
    }
}

type ApiResult = { success: boolean; id?: string; error?: string }

const api = () => (window as any).electronAPI?.channel

export const useChannelStore = create<{
    channels: ChannelUI[]
    loading: boolean
    loadChannels: () => Promise<void>
    create: (type: ChannelType, name: string, config: Record<string, unknown>) => Promise<ApiResult>
    update: (id: string, updates: Partial<ChannelUI>) => Promise<ApiResult>
    remove: (id: string) => Promise<ApiResult>
    login: (id: string) => Promise<ApiResult>
}>((set, get) => {
    const reload = () => get().loadChannels()

    // 监听主进程推送的渠道状态变更
    if (typeof window !== 'undefined') {
        const api = (window as any).electronAPI?.channel
        const cleanup = api?.onStatusChanged?.(() => reload())
        // 注意：此 store 是持久化的，cleanup 在 HMR 时不会调用
        // 但单页应用中组件卸载时会自动清理
    }

    return {
        channels: [], loading: false,

        loadChannels: async () => {
            set({loading: true})
            try {
                const list = (await api()?.list?.()) || []
                set({channels: list.map(toUI)})
            } finally {
                set({loading: false})
            }
        },

        create: async (type, name, config) => {
            const r = await api()?.create?.({type, name, config})
            if (r?.success) await reload()
            return r || {success: false}
        },

        update: async (id, updates) => {
            const r = await api()?.update?.(id, updates)
            if (r?.success) await reload()
            return r || {success: false}
        },

        remove: async (id) => {
            const r = await api()?.delete?.(id)
            if (r?.success) await reload()
            return r || {success: false}
        },

        login: async (id) => {
            return (await api()?.login?.(id)) || {success: false}
        },
    }
})
