/**
 * repoUpdateStore — skills/agents 仓库更新状态全局 store
 *
 * Refactored to use createUpdateStore factory.
 * Public API is identical to the previous hand-written version:
 *   setRepoUpdates, setVersionMeta, refreshFromCache, clear
 */
import {createUpdateStore} from './createUpdateStore'

const api = (window as any).electronAPI

export const useRepoUpdateStore = createUpdateStore<{
  current: string
  latest: string
  hasUpdate: boolean
}>({
  getAllVersionMeta: () => api?.repo?.getAllVersionMeta?.() ?? Promise.resolve({}),
  setMethodName: 'setRepoUpdates',
})
