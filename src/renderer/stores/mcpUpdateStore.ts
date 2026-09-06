/**
 * mcpUpdateStore — MCP version update state store
 *
 * Data flow:
 *   main process McpVersionManager → IPC broadcast → onMcpStatusUpdate → setVersionMeta
 *   MCPDialog → refreshFromCache → pull from IPC cache
 *   MenuBar → useMcpUpdateStore selector for red dot
 */
import {createUpdateStore} from './createUpdateStore'

const api = (window as any).electronAPI

export const useMcpUpdateStore = createUpdateStore<{
  current: string | null
  latest: string | null
  hasUpdate: boolean | null
  sourceType: string
  lastChecked: number
  availableVersions?: string[]
  pkgName?: string
  pkgManager?: 'npm' | 'pip'
}>({
  getAllVersionMeta: () => api?.mcp?.getAllVersionMeta?.() ?? Promise.resolve({}),
  setMethodName: 'setMcpUpdates',
})
