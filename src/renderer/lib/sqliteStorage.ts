import type {PersistStorage, StorageValue} from 'zustand/middleware'
import {refreshToolStore, syncSchemeToBackend} from '../stores/schemeSync'

/**
 * Zustand persist storage adapter that reads/writes data
 * in SQLite via Electron IPC.
 *
 * 供 llmStore 等需要 SQLite 持久化的 store 使用
 */

// rehydration 完成标记：在 getItem 返回数据后设为 true，setItem 在此之前跳过写入
const rehydratedStores = new Set<string>()

export function markRehydrated(name: string): void {
    rehydratedStores.add(name)
}

export function isRehydrated(name: string): boolean {
    return rehydratedStores.has(name)
}

// ─── Store 处理器配置 ────────────────────────────────────

const STORE_HANDLERS: Record<string, {
    getItem: () => Promise<StorageValue<unknown> | null>
    setItem: (state: any) => Promise<void>
    removeItem?: () => void
}> = {
    llm: {
        getItem: async () => {
            const result = await window.electronAPI?.provider?.listWithModels?.()
            if (!result?.success) {
                console.error('[sqliteStorage] listWithModels failed:', result?.error)
                return null
            }

            const providers = (result.data || []).map((p: any) => ({
                ...p,
                models: (p.models || []).map((m: any) => ({
                    id: m.id,
                    name: m.modelName,
                    modelType: m.modelType || 'text',
                    enabled: m.enabled,
                })),
            }))
            const activeProviderId = providers.find((p: any) => p.enabled)?.id || null
            const activeProvider = providers.find((p: any) => p.id === activeProviderId)
            const activeModelId = activeProvider?.models
                ? (activeProvider.models.find((m: any) => m.enabled)?.id || activeProvider.models[0]?.id || null)
                : null

            return {state: {providers, activeProviderId, activeModelId}, version: 1} as StorageValue<unknown>
        },
        setItem: async (state: any) => {
            if (!state?.providers) return
            const saveResult = await window.electronAPI?.provider?.saveAll?.(state.providers)
            if (!saveResult?.success) {
                console.error('[sqliteStorage] saveAll failed:', saveResult?.error)
                return
            }
            for (const provider of state.providers) {
                const models = (provider.models || []).map((m: any) => ({
                    id: m.id, providerId: provider.id, modelName: m.name,
                    modelType: m.modelType || 'text', enabled: m.enabled,
                }))
                await window.electronAPI?.providerModel?.saveByProvider?.(provider.id, models)
            }

            // ★ 服务商变更后同步到主进程 RuntimeConfigManager，使 API Key 修改立即生效
            try {
                const {useModelSchemeStore} = await import('../stores/modelSchemeStore')
                const schemeState = useModelSchemeStore.getState()
                if (schemeState.activeSchemeId && schemeState.schemes.length > 0) {
                    const activeScheme = schemeState.schemes.find(s => s.id === schemeState.activeSchemeId)
                    if (activeScheme) {
                        const {syncSchemeToBackend} = await import('../stores/schemeSync')
                        await syncSchemeToBackend(activeScheme.id, activeScheme)
                    }
                }
            } catch { /* 安全兜底，不影响主流程 */ }
        },
        removeItem: () => {
            window.electronAPI?.provider?.saveAll?.([])
        },
    },

    'model-schemes': {
        getItem: async () => {
            const [listResult, activeIdResult] = await Promise.all([
                window.electronAPI?.modelScheme?.list?.(),
                window.electronAPI?.modelScheme?.getActiveId?.()
            ])
            if (!listResult?.success) {
                console.error('[sqliteStorage] modelScheme.list failed:', listResult?.error)
                return null
            }
            return {
                state: {
                    schemes: listResult.data || [],
                    activeSchemeId: activeIdResult?.success ? (activeIdResult.data || null) : null
                }, version: 1
            } as StorageValue<unknown>
        },
        setItem: async (state: any) => {
            if (!state?.schemes) return
            await Promise.all(state.schemes.map((scheme: any) =>
                window.electronAPI?.modelScheme?.save?.(scheme).then(r => {
                    if (!r?.success) console.error('[sqliteStorage] modelScheme.save failed for scheme:', scheme.id, r?.error)
                })
            ))
            if (state.activeSchemeId) {
                await window.electronAPI?.modelScheme?.setActive?.(state.activeSchemeId)
                // 同步 runtimeConfigManager（使 analyze_image 工具能读到最新方案中的 image_understanding 配置）
                try {
                    const activeScheme = state.schemes.find((s: any) => s.id === state.activeSchemeId)
                    if (activeScheme) {
                        await syncSchemeToBackend(activeScheme.id, activeScheme)
                    }
                } catch { /* 安全兜底 */
                }
            }
            // 刷新工具列表（analyze_image 启用状态可能在 setActive 中已同步改变）
            refreshToolStore()
        },
    },

    'prompt-schemes': {
        getItem: async () => {
            const [listResult, activeIdResult] = await Promise.all([
                window.electronAPI?.promptScheme?.list?.(),
                window.electronAPI?.promptScheme?.getActiveId?.()
            ])
            if (!listResult?.success) {
                console.error('[sqliteStorage] promptScheme.list failed:', listResult?.error)
                return null
            }
            return {
                state: {
                    schemes: listResult.data || [],
                    activePromptSchemeId: activeIdResult?.success ? (activeIdResult.data || null) : null
                }, version: 1
            } as StorageValue<unknown>
        },
        setItem: async (state: any) => {
            if (!state?.schemes) return
            await Promise.all(state.schemes.map((scheme: any) =>
                window.electronAPI?.promptScheme?.save?.(scheme).then(r => {
                    if (!r?.success) console.error('[sqliteStorage] promptScheme.save failed for scheme:', scheme.id, r?.error)
                })
            ))
        },
    },

    mcp: {
        getItem: async () => {
            console.log('[sqliteStorage] getItem mcp: calling list')
            const result = await window.electronAPI?.mcp?.list?.()
            if (!result?.success) {
                console.error('[sqliteStorage] mcp.list failed:', result?.error)
                return null
            }
            const servers = (result.data || []).map((s: any) => ({
                id: s.id, name: s.name, transport: s.transport || 'stdio',
                command: s.command || '', args: s.args || [], env: s.env || {},
                url: s.url || '', headers: s.headers || {},
                cwd: s.cwd || '', timeout: s.timeout ?? 60000,
                autoApprove: s.autoApprove || [], denyList: s.denyList || [],
                userDescription: s.userDescription || '', enabled: s.enabled ?? true,
                // ★ Runtime 状态也参与 hydration（避免首次加载显示 undefined status）
                // mcp:list 返回 mcpService.list()，已包含 Worker 回传的最新状态
                status: s.status || 'stopped',
                tools: s.tools || [],
                errorDetail: s.errorDetail || '',
            }))
            markRehydrated('mcp')
            console.log('[sqliteStorage] getItem mcp: rehydrated with', servers.length, 'servers')
            return {state: {mcpServers: servers}, version: 1} as StorageValue<unknown>
        },
        setItem: async () => { /* mcp 持久化由 mcpStore.saveServer() 增量处理 */
        },
    },
}

export const sqliteStorage: PersistStorage<unknown> = {
    getItem: async (name: string): Promise<StorageValue<unknown> | null> => {
        try {
            const handler = STORE_HANDLERS[name]
            if (!handler) {
                console.warn('[sqliteStorage] getItem: unsupported store:', name)
                return null
            }
            return handler.getItem()
    } catch (err) {
      console.error('[sqliteStorage] getItem failed:', err)
      return null
    }
  },

  setItem: async (name: string, value: StorageValue<unknown>): Promise<void> => {
    try {
        const handler = STORE_HANDLERS[name]
        if (!handler) {
            console.warn('[sqliteStorage] setItem: unsupported store:', name)
            return
        }
        await handler.setItem(value.state)
    } catch (err) {
      console.error('[sqliteStorage] setItem failed:', err)
    }
  },

  removeItem: (name: string): void => {
    try {
        STORE_HANDLERS[name]?.removeItem?.()
    } catch (err) {
      console.error('[sqliteStorage] removeItem failed:', err)
    }
  },
}
