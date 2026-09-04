import {create} from 'zustand'
import type {PhraseItem} from '@shared/types/phrase'

interface PhraseStoreState {
    phrases: PhraseItem[]
    loading: boolean
    error: string | null
    load: () => Promise<void>
    create: (input: {content: string}) => Promise<PhraseItem | null>
    updateItem: (id: string, content: string) => Promise<void>
    remove: (id: string) => Promise<void>
    touch: (id: string) => Promise<void>
}

const unwrap = <T>(res?: {ok: boolean; data?: T; error?: string}): T | null =>
    res?.ok ? (res.data ?? null) : null

export const usePhraseStore = create<PhraseStoreState>((set, get) => ({
    phrases: [],
    loading: false,
    error: null,

    load: async () => {
        set({loading: true})
        try {
            const res = await window.electronAPI?.phrase.list()
            const data = unwrap<PhraseItem[]>(res)
            if (data) set({phrases: data, error: null})
            else set({phrases: [], error: res?.error || '加载快捷短语失败'})
        } finally {
            set({loading: false})
        }
    },

    create: async (input) => {
        const res = await window.electronAPI?.phrase.create(input)
        const data = unwrap<PhraseItem>(res)
        if (data) {
            await get().load()
            return data
        }
        set({error: res?.error || '创建快捷短语失败'})
        return null
    },

    updateItem: async (id, content) => {
        const res = await window.electronAPI?.phrase.update(id, content)
        if (!unwrap(res)) {
            set({error: res?.error || '更新快捷短语失败'})
            return
        }
        await get().load()
    },

    remove: async (id) => {
        const res = await window.electronAPI?.phrase.remove(id)
        if (!unwrap(res)) {
            set({error: res?.error || '删除快捷短语失败'})
            return
        }
        await get().load()
    },

    touch: async (id) => {
        const res = await window.electronAPI?.phrase.touch(id)
        const data = unwrap<PhraseItem>(res)
        if (data) {
            set((s) => ({phrases: s.phrases.map(p => p.id === id ? {...p, lastUsedAt: data.lastUsedAt} : p)}))
        }
    },
}))

/** 订阅 phrase_changed：任意窗口写操作后重新 load（低频，全量刷新） */
export function subscribePhraseChanged(): () => void {
    return window.electronAPI?.onPhraseChanged(() => {
        void usePhraseStore.getState().load()
    }) ?? (() => {})
}
