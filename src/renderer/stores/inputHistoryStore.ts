import {create} from 'zustand'

const MAX_HISTORY = 100
const STORAGE_KEY = 'hclaw-input-history'

interface InputHistoryStore {
    history: string[]
    pushEntry: (text: string) => void
    clearHistory: () => void
}

function loadHistory(): string[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY)
        return raw ? JSON.parse(raw) : []
    } catch {
        return []
    }
}

function saveHistory(history: string[]) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(history))
    } catch {
        // localStorage 满时静默失败
    }
}

export const useInputHistoryStore = create<InputHistoryStore>((set, get) => ({
    history: loadHistory(),

    pushEntry: (text: string) => {
        const trimmed = text.trim()
        if (!trimmed) return

        const {history} = get()
        // 去重：与最后一条相同则不重复添加
        if (history.length > 0 && history[history.length - 1] === trimmed) return

        const updated = [...history, trimmed]
        // 只保留最近 MAX_HISTORY 条
        const pruned = updated.length > MAX_HISTORY ? updated.slice(updated.length - MAX_HISTORY) : updated

        set({history: pruned})
        saveHistory(pruned)
    },

    clearHistory: () => {
        set({history: []})
        saveHistory([])
    },
}))
