/**
 * pluginUpdateStore — 插件更新状态全局 store
 *
 * Refactored to use createUpdateStore factory.
 * Public API is identical to the previous hand-written version:
 *   setPluginUpdates, setVersionMeta, refreshFromCache, clear
 *
 * Data flow unchanged:
 *   main process PluginVersionManager → IPC push → onPluginStatusUpdate → setVersionMeta
 *   MenuBar / PluginDialog → usePluginUpdateStore selector
 */
import {createUpdateStore} from './createUpdateStore'

const api = (window as any).electronAPI

export const usePluginUpdateStore = createUpdateStore<{
  current: string
  latest: string
  hasUpdate: boolean
}>({
  getAllVersionMeta: () => api?.plugin?.getAllVersionMeta?.() ?? Promise.resolve({}),
  setMethodName: 'setPluginUpdates',
})
