import {create} from 'zustand'
import {persist, type PersistStorage} from 'zustand/middleware'
import {sqliteStorage} from '../lib/sqliteStorage'
import {buildCrudSlice} from '../lib/createCrudStore'
import {toSlug} from '../lib/format'
import type {MCPServer} from '@shared/types'

interface McpStore {
  mcpServers: MCPServer[]
    /** 持久化是否已完成（从 SQLite 加载） */
    hasRehydrated: boolean
    addMCPServer: (server: Omit<MCPServer, 'id' | 'status' | 'tools'>) => MCPServer
  removeMCPServer: (id: string) => void
    updateMCPServer: (id: string, updates: Partial<MCPServer>) => void
    toggleMCPServer: (id: string) => void
    setServerStatus: (id: string, status: MCPServer['status'], tools?: MCPServer['tools'], errorDetail?: string, extra?: Partial<MCPServer>) => void
    /** 批量更新服务器状态（单次 set，避免多次 persist） */
    setServerStatusesBatch: (updates: Array<{
        id: string;
        status: MCPServer['status'];
        tools?: MCPServer['tools'];
        errorDetail?: string;
        extra?: Partial<MCPServer>
    }>) => void
}

const crud = buildCrudSlice<MCPServer, McpStore>({
  itemsKey: 'mcpServers',
  addMethodName: 'addMCPServer',
  removeMethodName: 'removeMCPServer',
  defaults: () => ({
      status: 'stopped' as const,
    tools: [],
      enabled: true,
  }),
})

/**
 * ★ 在模块顶层同步注册 IPC 监听器（不等 Zustand hydration 完成）
 *
 * 背景：onRehydrateStorage 回调在 SQLite 加载完成后才执行，但 MCP Worker
 * 在应用启动时立刻就开始连接服务器并发送 status_batch 事件。如果监听器
 * 注册在 onRehydrateStorage 中，这段时间内的 'connecting' 状态事件会全部丢失。
 */
function registerMcpIpcListeners(): void {
    if (typeof window === 'undefined') return

    // ── 状态变化监听 ──
    window.electronAPI?.mcp?.onStatusChanged?.((payload: any) => {
        console.log(`[mcpStore] onStatusChanged: serverId=${payload.serverId} status=${payload.status}`)
        useMcpStore.setState((s: any) => {
            const existingServer = s.mcpServers.find((srv: any) => srv.id === payload.serverId)
            // ★ 未知 server（如延迟发现的插件 MCP）→ 追加到 store
            if (!existingServer) {
                console.log(`[mcpStore] onStatusChanged: new server ${payload.serverId}, adding to store`)
                return {
                    mcpServers: [...s.mcpServers, {
                        id: payload.serverId,
                        name: payload.serverId,
                        transport: 'stdio',
                        status: payload.status,
                        tools: payload.tools || [],
                        errorDetail: payload.error || '',
                        enabled: true,
                        command: '', args: [], env: {}, url: '', headers: {},
                        cwd: '', timeout: 60000, autoApprove: [], denyList: [],
                        userDescription: '',
                    }]
                }
            }
            // 防止降级：已 connected 的不应回到 connecting
            if (existingServer.status === 'connected' && payload.status === 'connecting') {
                console.log(`[mcpStore] SKIP connecting for ${payload.serverId} (already connected)`)
                return s
            }
            console.log(`[mcpStore] updating ${payload.serverId} ${existingServer.status} -> ${payload.status}`)
            return {
                mcpServers: s.mcpServers.map((srv: any) => {
                    if (srv.id !== payload.serverId) return srv
                    return {
                        ...srv,
                        status: payload.status,
                        errorDetail: payload.error || '',
                        tools: payload.tools || srv.tools || [],
                    }
                }),
            }
        })
    })

    // ── 列表变化监听（mcp.json 外部修改 / 插件增删 / toggle enabled） ──
    window.electronAPI?.mcp?.onListChanged?.(() => {
        console.log('[mcpStore] onListChanged: reloading servers from backend')
        window.electronAPI?.mcp?.list?.().then((result: any) => {
            if (result?.success) {
                const currentStore = useMcpStore.getState()
                const currentMap = new Map(currentStore.mcpServers.map((s: any) => [s.id, s]))

                const servers = (result.data || []).map((s: any) => {
                    const existing = currentMap.get(s.id)
                    // ★ 保留 store 中的 runtime 状态（status, tools, errorDetail）
                    // onListChanged 只负责同步配置（名称/命令/启用状态等），
                    // 运行时状态由 onStatusChanged 权威管理，不在列表拉取时覆盖
                    return {
                        id: s.id,
                        name: s.name,
                        transport: s.transport || 'stdio',
                        command: s.command || '',
                        args: s.args || [],
                        env: s.env || {},
                        url: s.url || '',
                        headers: s.headers || {},
                        cwd: s.cwd || '',
                        timeout: s.timeout ?? 60000,
                        autoApprove: s.autoApprove || [],
                        denyList: s.denyList || [],
                        userDescription: s.userDescription || '',
                        enabled: s.enabled ?? true,
                        // 运行时状态：优先用 store 已存在的，否则用 mcp:list 返回的（首次加载兜底）
                        status: existing?.status || s.status || 'stopped',
                        tools: existing?.tools || s.tools || [],
                        errorDetail: existing?.errorDetail || s.errorDetail || '',
                    }
                })
                useMcpStore.setState({ mcpServers: servers })
            }
        })
    })
}

// ★ 模块加载时立即注册（不等 Zustand hydration）
registerMcpIpcListeners()

export const useMcpStore = create<McpStore>()(
  persist(
      (set, get) => ({
          ...crud(set),
          hasRehydrated: false,
          removeMCPServer: async (id: string): Promise<void> => {
              set((state: McpStore) => ({
                  mcpServers: state.mcpServers.filter((s: MCPServer) => s.id !== id)
              }))
              window.electronAPI?.mcp?.delete?.(id)
          },
          addMCPServer: (server: Omit<MCPServer, 'id' | 'status' | 'tools'>): MCPServer => {
              const state = get()
              let finalId = toSlug(server.name || 'server')

              let counter = 1
              const originalId = finalId
              while (state.mcpServers.some((s: MCPServer) => s.id === finalId)) {
                  finalId = `${originalId}-${counter}`
                  counter++
              }

              const newServer: MCPServer = {
                  ...server,
                  id: finalId,
                  status: 'stopped',
                  tools: [],
                  enabled: true,
                  cwd: server.cwd,
                  timeout: server.timeout ?? 60000,
                  autoApprove: server.autoApprove ?? [],
                  denyList: server.denyList ?? [],
              }
              set((state: McpStore) => ({mcpServers: [...state.mcpServers, newServer]}))
              window.electronAPI?.mcp?.saveServer?.(newServer)
              return newServer
          },
          updateMCPServer: (id: string, updates: Partial<MCPServer>) => {
              set((state: McpStore) => ({
                  mcpServers: state.mcpServers.map((s: MCPServer) => s.id === id ? {...s, ...updates} : s)
              }))
              const server = get().mcpServers.find((s: MCPServer) => s.id === id)
              if (server) {
                  window.electronAPI?.mcp?.saveServer?.(server)
              }
          },
          toggleMCPServer: (id: string) => {
              set((state: McpStore) => ({
                  mcpServers: state.mcpServers.map((s: MCPServer) => s.id === id ? {...s, enabled: !s.enabled} : s)
              }))
              const server = get().mcpServers.find((s: MCPServer) => s.id === id)
              if (server) {
                  window.electronAPI?.mcp?.saveServer?.(server)
              }
          },
          setServerStatus: (id: string, status: MCPServer['status'], tools?: MCPServer['tools'], errorDetail?: string, extra?: Partial<MCPServer>) => {
              set((state: McpStore) => ({
                  mcpServers: state.mcpServers.map((s: MCPServer) => s.id === id ? {
                      ...s,
                      status,
                      ...(tools !== undefined ? {tools} : {}),
                      ...(errorDetail !== undefined ? {errorDetail} : {}),
                      ...(extra || {})
                  } : s)
              }))
              const server = get().mcpServers.find((s: MCPServer) => s.id === id)
              if (server) {
                  window.electronAPI?.mcp?.saveServer?.(server)
              }
          },
          setServerStatusesBatch: (updates: Array<{
              id: string;
              status: MCPServer['status'];
              tools?: MCPServer['tools'];
              errorDetail?: string;
              extra?: Partial<MCPServer>
          }>) => set((state: McpStore) => {
              const updateMap = new Map(updates.map((u: typeof updates[0]) => [u.id, u]))
              return {
                  mcpServers: state.mcpServers.map((s: MCPServer) => {
                      const u = updateMap.get(s.id)
                      if (!u) return s
                      return {
                          ...s,
                          status: u.status,
                          ...(u.tools !== undefined ? {tools: u.tools} : {}),
                          ...(u.errorDetail !== undefined ? {errorDetail: u.errorDetail} : {}),
                          ...(u.extra || {}),
                      }
                  })
              }
          }),
      }),
      {
          name: 'mcp',
          storage: sqliteStorage as PersistStorage<McpStore>,
          version: 1,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onRehydrateStorage: () => {
              return (state: any) => {
                  if (state) {
                      state.hasRehydrated = true
                  }
                  console.log('[mcpStore] rehydration complete')
                  // ★ 注意：IPC 监听器已在模块顶层 registerMcpIpcListeners() 中注册，
                  // 不在此处重复注册，避免 hydration 延迟导致丢失 Worker 的初始状态事件
              }
          },
      }
  )
)
