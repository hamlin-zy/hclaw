// src/renderer/stores/repoUpdateStore.ts
import {create} from 'zustand'

function resolveVersionMeta(versionMeta: Record<string, { current: string; latest: string; hasUpdate: boolean }>) {
  const updateMap: Record<string, boolean> = {}
  for (const [id, meta] of Object.entries(versionMeta)) {
    updateMap[id] = meta.hasUpdate
  }
  const hasUpdate = Object.values(updateMap).some(Boolean)
  return {versionMeta, updateMap, hasUpdate}
}

interface RepoUpdateState {
  hasUpdate: boolean
  updateMap: Record<string, boolean>
  versionMeta: Record<string, { current: string; latest: string; hasUpdate: boolean }>
  setRepoUpdates: (updateMap: Record<string, boolean>) => void
  setVersionMeta: (meta: Record<string, { current: string; latest: string; hasUpdate: boolean }>) => void
  refreshFromCache: () => Promise<void>
  clear: () => void
}

export const useRepoUpdateStore = create<RepoUpdateState>((set) => ({
  hasUpdate: false,
  updateMap: {},
  versionMeta: {},

  setRepoUpdates: (updateMap) => {
    const hasUpdate = Object.values(updateMap).some(Boolean)
    set({updateMap, hasUpdate})
  },

  setVersionMeta: (versionMeta) => {
    const resolved = resolveVersionMeta(versionMeta)
    set(resolved)
  },

  refreshFromCache: async () => {
    try {
      const api = (window as any).electronAPI
      if (!api?.repo?.getAllVersionMeta) return
      const meta = await api.repo.getAllVersionMeta()
      if (meta && typeof meta === 'object') {
        set(resolveVersionMeta(meta as any))
      }
    } catch {
      // Silently ignore
    }
  },

  clear: () => set({hasUpdate: false, updateMap: {}, versionMeta: {}}),
}))
