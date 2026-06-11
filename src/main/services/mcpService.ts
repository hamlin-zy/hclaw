// src/main/services/mcpService.ts

import type {McpServer} from '../../shared/types/mcp'
import {readMcpConfig, writeMcpConfig} from '../config/mcpConfig'
import {createLogger} from '../agent/logger'

export type MCPServerStatus = 'stopped' | 'connecting' | 'connected' | 'stopping' | 'error' | 'reconnecting'

/** Runtime MCP server with transient state (not persisted) */
export interface RuntimeMcpServer extends McpServer {
  status: MCPServerStatus
  errorDetail: string
  tools: unknown[]
}

export interface MCPServerEvent {
  type: 'list-changed' | 'status-changed'
  data: MCPServerStatusChangedData | MCPServerListChangedData
}

export interface MCPServerStatusChangedData {
  serverId: string
  status: MCPServerStatus
  error?: string
  tools?: unknown[]
}

export interface MCPServerListChangedData {
  servers: RuntimeMcpServer[]
}

type ServiceListener = (event: MCPServerEvent) => void

const logger = createLogger('mcp-service')

/**
 * MCPServerService — MCP 服务器业务逻辑层
 *
 * 职责：
 * 1. 维护内存中的 server 列表缓存
 * 2. 提供 CRUD 操作，增量更新缓存而非每次查 SQLite
 * 3. 监听 MCPClient 状态变化并转发为 Service 事件
 * 4. 供 IPC Handler 和 Bootstrap 调用
 */
export class MCPServerService {
  /** 内存缓存: id → RuntimeMcpServer (带运行时状态) */
  private servers: Map<string, RuntimeMcpServer> = new Map()

  /** Service 事件监听器 */
  private listeners: Set<ServiceListener> = new Set()

  /** 是否已初始化 */
  private initialized = false

  /**
   * 初始化：从 SQLite 加载所有 server 到内存缓存，
   * 并自动启动所有 enabled=true 的服务器
   */
  async initialize(): Promise<void> {
    // 立即标记为已初始化，防止多次调用时重复初始化
    if (this.initialized) return
    this.initialized = true

      const list = readMcpConfig()
    logger.info('init', {servers: list.map(s => ({id: s.id, name: s.name, enabled: s.enabled}))})
    for (const server of list) {
      // 内存中 status 初始为 stopped（runtime 状态不持久化）
      this.servers.set(server.id, {
        ...server,
        status: 'stopped',
        errorDetail: '',
        tools: [],
      })
    }
    logger.info('init', {serverCount: this.servers.size})
    // Phase 2: 服务器连接由 MCP Worker (mcpWorkerManager) 统一管理，
    // mcpService.initialize() 只负责加载配置到内存缓存
  }

  /**
   * 获取所有 server（从缓存）
   */
  list(): RuntimeMcpServer[] {
    return Array.from(this.servers.values()).sort((a, b) =>
      a.name.localeCompare(b.name)
    )
  }

  /**
   * 获取单个 server
   */
  get(id: string): RuntimeMcpServer | undefined {
    return this.servers.get(id)
  }

  /**
   * 新增单个 server（增量）
   */
  add(server: McpServer): boolean {
    try {
      const runtime: RuntimeMcpServer = {
        ...server,
        status: 'stopped',
        errorDetail: '',
        tools: [],
        enabled: server.enabled ?? true,
      }

      // 先更新内存缓存
      this.servers.set(server.id, runtime)

        // 写入配置文件
        writeMcpConfig(Array.from(this.servers.values()))
        this.notify({type: 'list-changed', data: {servers: this.list()}})
        return true
    } catch (err) {
      logger.error('add', {success: false, error: String(err)})
      return false
    }
  }

    /**
     * 插件服务器：只更新缓存，不写入文件（配置在插件目录）
     */
    addPluginServer(server: McpServer): void {
        const existing = this.servers.get(server.id)
        this.servers.set(server.id, {
            ...server,
            status: existing?.status || 'stopped',
            errorDetail: existing?.errorDetail || '',
            tools: existing?.tools || [],
            enabled: server.enabled,
        })
        this.notify({type: 'list-changed', data: {servers: this.list()}})
    }

  /**
   * 删除单个 server（增量）
   */
  delete(id: string): boolean {
    try {
        this.servers.delete(id)
        writeMcpConfig(Array.from(this.servers.values()))
        this.notify({type: 'list-changed', data: {servers: this.list()}})
        return true
    } catch (err) {
      logger.error('delete', {success: false, error: String(err)})
      return false
    }
  }

  /**
   * 更新 enabled 状态
   */
  setEnabled(id: string, enabled: boolean): boolean {
    try {
        const server = this.servers.get(id)
        if (server) {
            this.servers.set(id, {...server, enabled})
            writeMcpConfig(Array.from(this.servers.values()))
            this.notify({type: 'list-changed', data: {servers: this.list()}})
        }
        return true
    } catch (err) {
      logger.error('setEnabled', {success: false, error: String(err)})
      return false
    }
  }

    /**
     * 从文件重新加载配置到内存缓存（保留 runtime 状态）
     * 由 mcpWatcher 在检测到文件外部变更时调用，
     * 防止 UI/缓存用旧数据覆盖文件。
     */
    reloadServers(servers: McpServer[]): void {
        const newIds = new Set(servers.map(s => s.id))

        // 删除已不在文件中的服务器（跳过插件 MCP，由插件系统管理生命周期）
        for (const [id] of this.servers) {
            if (id.startsWith('plugin:')) continue
            if (!newIds.has(id)) {
                this.servers.delete(id)
            }
        }

        // 新增或更新配置（保留已有 runtime 状态）
        for (const server of servers) {
            const existing = this.servers.get(server.id)
            this.servers.set(server.id, {
                ...server,
                status: existing?.status || 'stopped',
                errorDetail: existing?.errorDetail || '',
                tools: existing?.tools || [],
            })
        }

        this.notify({type: 'list-changed', data: {servers: this.list()}})
        logger.info('reloadServers', {count: servers.length})
    }

  /**
   * 更新 runtime 状态（仅内存，不写 SQLite）
   * 由 MCPClient 在状态变化时调用
   */
  updateStatus(
    id: string,
    status: MCPServerStatus,
    error?: string,
    tools?: unknown[]
  ): void {
    logger.debug('updateStatus', {id, status, error})
    const server = this.servers.get(id)
    if (!server) {
      logger.debug('updateStatus', {id, error: 'server-not-found'})
      return
    }

      // 未传 tools 时保留现有缓存，避免零星 updateStatus 调用清空工具列表
      const mergedTools = tools !== undefined ? tools : server.tools

    this.servers.set(id, {
      ...server,
      status,
        errorDetail: error ?? server.errorDetail,
        tools: mergedTools,
    })

    this.notify({
      type: 'status-changed',
        data: {serverId: id, status, error, tools: mergedTools},
    })
  }

  /**
   * 批量更新 runtime 状态
   */
  updateStatuses(
    updates: Array<{id: string; status: MCPServerStatus; error?: string; tools?: unknown[]}>
  ): void {
    for (const u of updates) {
      const server = this.servers.get(u.id)
      if (!server) continue
        const mergedTools = u.tools !== undefined ? u.tools : server.tools
      this.servers.set(u.id, {
        ...server,
        status: u.status,
          errorDetail: u.error ?? server.errorDetail,
          tools: mergedTools,
      })
    }
    // 合并通知，避免多次 IPC
    for (const u of updates) {
        const server = this.servers.get(u.id)
        const mergedTools = u.tools !== undefined ? u.tools : server?.tools
      this.notify({
        type: 'status-changed',
          data: {serverId: u.id, status: u.status, error: u.error, tools: mergedTools},
      })
    }
  }

  // ─── 事件监听 ───────────────────────────────────────

  onEvent(listener: ServiceListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(event: MCPServerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (err) {
        logger.error('notify', {success: false, error: String(err)})
      }
    }
  }
}

/** 全局单例 */
export const mcpService = new MCPServerService()
