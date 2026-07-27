/**
 * pluginUpdateStore — 插件更新状态全局 store
 *
 * 数据流：
 *   main process PluginVersionManager → IPC 推送 → onPluginStatusUpdate → setPluginUpdates
 *   MenuBar / PluginDialog → usePluginUpdateStore selector 订阅红点状态
 *
 * 会话级状态（不持久化，重启后自动重置）
 */

import {create} from 'zustand'

/** Derive updateMap + hasUpdate from versionMeta */
function resolveVersionMeta(versionMeta: Record<string, { current: string; latest: string; hasUpdate: boolean }>) {
    const updateMap: Record<string, boolean> = {}
    for (const [name, meta] of Object.entries(versionMeta)) {
        updateMap[name] = meta.hasUpdate
    }
    const hasUpdate = Object.values(updateMap).some(Boolean)
    return {versionMeta, updateMap, hasUpdate}
}

interface PluginUpdateState {
  /** 是否有任何插件有可用更新（任何一个 true 即为 true） */
  hasUpdate: boolean
  /** 每个插件的更新状态: pluginName → hasUpdate */
  updateMap: Record<string, boolean>
  /** 插件版本元数据: pluginName → { current, latest } */
  versionMeta: Record<string, { current: string; latest: string; hasUpdate: boolean }>

  setPluginUpdates: (updateMap: Record<string, boolean>) => void
  setVersionMeta: (meta: Record<string, { current: string; latest: string; hasUpdate: boolean }>) => void
  /** 从 IPC 缓存拉取红点状态（用于页面打开后即时同步，不重新 fetch） */
  refreshFromCache: () => Promise<void>
  clear: () => void
}

export const usePluginUpdateStore = create<PluginUpdateState>((set) => ({
  hasUpdate: false,
  updateMap: {},
  versionMeta: {},

  setPluginUpdates: (updateMap) => {
    const hasUpdate = Object.values(updateMap).some(Boolean)
    set({updateMap, hasUpdate})
  },

  setVersionMeta: (versionMeta) => {
    const resolved = resolveVersionMeta(versionMeta)
    set(resolved)
  },

  /** 从 IPC 拉取主进程缓存的版本元数据，无需重新 fetch */
  refreshFromCache: async () => {
    try {
      const api = (window as any).electronAPI
      if (!api?.plugin?.getAllVersionMeta) return
      const meta = await api.plugin.getAllVersionMeta()
      if (meta && typeof meta === 'object') {
        const resolved = resolveVersionMeta(meta as any)
        set(resolved)
      }
    } catch {
      // Silently ignore
    }
  },

  clear: () => set({hasUpdate: false, updateMap: {}, versionMeta: {}}),
}))
