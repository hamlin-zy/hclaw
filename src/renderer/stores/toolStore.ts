import {create} from 'zustand'
import {persist, type PersistStorage} from 'zustand/middleware'
import {sqliteStorage} from '../lib/sqliteStorage'
import {ALWAYS_ON_TOOLS} from '../../shared/alwaysOnTools'

export interface ToolState {
    id: string
    name: string
    description: string
    enabled: boolean
    /** 超时时间（毫秒），null 表示使用默认值 */
    timeout: number | null
}

interface ToolStore {
    tools: ToolState[]
    hasRehydrated: boolean
    isLoading: boolean
    toggleTool: (id: string) => void
    setToolEnabled: (id: string, enabled: boolean) => void
    setToolTimeout: (id: string, timeout: number | null) => void
    setTools: (tools: ToolState[]) => void
    setLoading: (isLoading: boolean) => void
    loadTools: () => Promise<void>
}

export const useToolStore = create<ToolStore>()(
    persist(
        (set, get) => ({
            tools: [],
            hasRehydrated: false,
            isLoading: false,
            toggleTool: (id: string) => {
                // ★ 能力驱动工具：不可手动切换（no-op，UI 已移除开关，防御旧调用）
                if (ALWAYS_ON_TOOLS.has(id)) return
                set((state: Pick<ToolStore, 'tools'>) => ({
                    tools: state.tools.map((t: ToolState) => 
                        t.id === id ? {...t, enabled: !t.enabled} : t
                    )
                }))
                const tool = get().tools.find((t: ToolState) => t.id === id)
                if (tool) {
                    window.electronAPI?.tool?.setEnabled?.(id, tool.enabled)
                }
            },
            setToolEnabled: (id: string, enabled: boolean) => {
                // ★ 能力驱动工具：不可手动切换（no-op，UI 已移除开关，防御旧调用）
                if (ALWAYS_ON_TOOLS.has(id)) return
                set((state: Pick<ToolStore, 'tools'>) => ({
                    tools: state.tools.map((t: ToolState) => 
                        t.id === id ? {...t, enabled} : t
                    )
                }))
                window.electronAPI?.tool?.setEnabled?.(id, enabled)
            },
            setToolTimeout: (id: string, timeout: number | null) => {
                set((state: Pick<ToolStore, 'tools'>) => ({
                    tools: state.tools.map((t: ToolState) => 
                        t.id === id ? {...t, timeout} : t
                    )
                }))
                window.electronAPI?.tool?.setTimeout?.(id, timeout)
            },
            setTools: (tools: ToolState[]) => set({tools}),
            setLoading: (isLoading: boolean) => set({isLoading}),
            loadTools: async function loadTools() {
                if (get().isLoading) return
                get().setLoading(true)
                try {
                    const result = await window.electronAPI?.tool?.list?.()
                    if (result?.success && result.data) {
                        get().setTools(result.data)
                    }
                } catch (err) {
                    console.error('[toolStore] loadTools failed:', err)
                } finally {
                    get().setLoading(false)
                }
            },
        }),
        {
            name: 'tools',
            storage: sqliteStorage as PersistStorage<ToolStore>,
            version: 2, // 版本升级以适应新的字段
            onRehydrateStorage: () => {
                return (state: any) => {
                    if (state) {
                        state.hasRehydrated = true
                    }
                    // 从后端加载工具列表
                    state.loadTools()
                }
            },
        }
    )
)
