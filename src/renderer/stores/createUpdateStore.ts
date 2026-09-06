/**
 * createUpdateStore — generic factory for version update state stores.
 *
 * Extracts the shared pattern from pluginUpdateStore and repoUpdateStore:
 *   - versionMeta: full version metadata map
 *   - updateMap: derived per-id hasUpdate flag
 *   - hasUpdate: aggregate (any true → true)
 *   - setVersionMeta: set full version metadata (derives updateMap + hasUpdate)
 *   - [setMethodName]: domain-specific alias for setUpdateMap (compat with existing callers)
 *   - refreshFromCache: pull from IPC cache (no network)
 *   - clear: reset all state
 *
 * Factory does NOT register IPC listeners — the component layer does that
 * via useEffect + window.electronAPI.xxx.onXxxStatusUpdate.
 */
import {create, type StoreApi, type UseBoundStore} from 'zustand'

export interface VersionMetaBase {
  current: string | null
  latest: string | null
  hasUpdate: boolean | null
}

export function createUpdateStore<T extends VersionMetaBase, const M extends string = string>(options: {
  getAllVersionMeta: () => Promise<Record<string, T>>
  setMethodName: M
}) {
  const {getAllVersionMeta, setMethodName} = options

  function resolveVersionMeta(versionMeta: Record<string, T>) {
    const updateMap: Record<string, boolean | null> = {}
    for (const [id, meta] of Object.entries(versionMeta)) {
      updateMap[id] = meta.hasUpdate
    }
    // some(Boolean) treats null as false — correct for aggregate "any update available"
    const hasUpdate = Object.values(updateMap).some(Boolean)
    return {versionMeta, updateMap, hasUpdate}
  }

  type SetUpdateMap = (updateMap: Record<string, boolean | null>) => void

  interface StoreState {
    hasUpdate: boolean
    updateMap: Record<string, boolean | null>
    versionMeta: Record<string, T>
    setVersionMeta: (meta: Record<string, T>) => void
    refreshFromCache: () => Promise<void>
    clear: () => void
  }

  const store = create<StoreState>((set) => ({
    hasUpdate: false,
    updateMap: {},
    versionMeta: {},

    setVersionMeta: (versionMeta) => {
      set(resolveVersionMeta(versionMeta))
    },

    [setMethodName]: (updateMap: Record<string, boolean | null>) => {
      const hasUpdate = Object.values(updateMap).some(Boolean)
      set({updateMap, hasUpdate})
    },

    refreshFromCache: async () => {
      try {
        const meta = await getAllVersionMeta()
        if (meta && typeof meta === 'object') {
          set(resolveVersionMeta(meta as Record<string, T>))
        }
      } catch {
        // Silently ignore
      }
    },

    clear: () => set({hasUpdate: false, updateMap: {}, versionMeta: {}}),
  }))

  // 别名方法以运行时键 [setMethodName] 存在，补齐静态类型：state 上含 Record<M, SetUpdateMap>
  return store as unknown as UseBoundStore<StoreApi<StoreState & Record<M, SetUpdateMap>>>
}
