/**
 * 备忘录渲染层 zustand store（Task 5）
 *
 * - 所有 IPC 返回包装 {ok:true,data} | {ok:false,error}，此处统一解包
 * - 低频操作：create/updateItem/remove 成功后全量刷新（load）
 * - createSession 失败仅置 error 并返回 null，不 throw 出 store 边界
 * - subscribeMemoChanged：memo_changed 推送按 workspacePath 相等才 reload，
 *   由 MemoPanel 挂载时调用一次（Task 8）
 */
import {create} from 'zustand'
import type {MemoItem, MemoAttachment, MemoCapability} from '@shared/types/memo'

interface MemoStoreState {
    memos: MemoItem[]
    loading: boolean
    error: string | null
    load: (workspacePath: string) => Promise<void>
    create: (input: {workspacePath: string; title: string; content: string; capability?: MemoCapability; attachments?: MemoAttachment[]}) => Promise<MemoItem | null>
    updateItem: (id: string, patch: Partial<MemoItem>) => Promise<void>
    remove: (id: string) => Promise<void>
    createSession: (id: string) => Promise<{convId: string} | null>
}

const unwrap = <T,>(res?: {ok: boolean; data?: T; error?: string}): T | null => {
    if (res && res.ok) return res.data ?? null
    return null
}

export const useMemoStore = create<MemoStoreState>((set, get) => ({
    memos: [],
    loading: false,
    error: null,

    load: async (workspacePath: string) => {
        set({loading: true})
        try {
            const res = await window.electronAPI?.memo.list(workspacePath)
            const data = unwrap<MemoItem[]>(res)
            if (data) {
                set({memos: data, error: null})
            } else {
                set({memos: [], error: res?.error || '加载备忘录失败'})
            }
        } finally {
            set({loading: false})
        }
    },

    create: async (input) => {
        const res = await window.electronAPI?.memo.create(input)
        const data = unwrap<MemoItem>(res)
        if (data) {
            await get().load(input.workspacePath)
            return data
        }
        set({error: res?.error || '创建备忘录失败'})
        return null
    },

    updateItem: async (id: string, patch: Partial<MemoItem>) => {
        const res = await window.electronAPI?.memo.update(id, patch)
        if (!unwrap(res)) {
            set({error: res?.error || '更新备忘录失败'})
            return
        }
        const current = get().memos.find((m) => m.id === id)
        await get().load(current?.workspacePath ?? (patch as {workspacePath?: string}).workspacePath ?? '')
    },

    remove: async (id: string) => {
        const current = get().memos.find((m) => m.id === id)
        const res = await window.electronAPI?.memo.remove(id)
        if (!unwrap(res)) {
            set({error: res?.error || '删除备忘录失败'})
            return
        }
        if (current) await get().load(current.workspacePath)
    },

    createSession: async (id: string) => {
        const res = await window.electronAPI?.memo.createSession(id)
        const data = unwrap<{convId: string}>(res)
        if (data) {
            set({error: null})
            return data
        }
        set({error: res?.error || '创建会话失败'})
        return null
    },
}))

/**
 * 订阅 memo_changed 推送：仅当推送的 workspacePath 与当前工作区一致时重新 load。
 * 返回取消订阅函数。由 MemoPanel useEffect 挂载时调用一次。
 */
export function subscribeMemoChanged(getWorkspacePath: () => string): () => void {
    return window.electronAPI?.onMemoChanged(({workspacePath}) => {
        if (workspacePath === getWorkspacePath()) {
            void useMemoStore.getState().load(workspacePath)
        }
    }) ?? (() => {})
}
