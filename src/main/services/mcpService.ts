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

      // 先更新内存缓存（记录原条目：同 id 覆盖时失败回滚要还原它，而不是直接删掉）
      const previous = this.servers.get(server.id)
      this.servers.set(server.id, runtime)

        // 写入配置文件
        // ★ 必须检查写盘结果：失败时内存已是新值而磁盘未变，随后同值重试会被
        //   setEnabled 的幂等短路拦下 → 漂移固化、不自愈。故回滚内存并返回 false。
        //   用 `=== false` 而非 falsy 判断（test double / 将来签名返回 undefined 时不得误判）。
        if (writeMcpConfig(Array.from(this.servers.values())) === false) {
            // 回滚内存，保持与磁盘（仍是旧内容）一致
            if (previous) this.servers.set(server.id, previous)
            else this.servers.delete(server.id)
            logger.error('add', {success: false, error: 'writeMcpConfig failed', id: server.id})
            return false
        }
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
        const removed = this.servers.get(id)
        // 记录删除前的插入位置：Map 保留插入顺序，回滚时插回原索引，避免列表顺序漂移
        const removedIndex = removed ? Array.from(this.servers.keys()).indexOf(id) : -1
        this.servers.delete(id)
        // ★ 写盘失败必须回滚（同 add/setEnabled）：否则内存已删、磁盘仍有 → 漂移固化。
        if (writeMcpConfig(Array.from(this.servers.values())) === false) {
            if (removed) {
                const entries = Array.from(this.servers.entries())
                entries.splice(Math.max(0, removedIndex), 0, [id, removed])
                this.servers = new Map(entries)
            }
            logger.error('delete', {success: false, error: 'writeMcpConfig failed', id})
            return false
        }
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
            // 幂等短路：enabled 未变化时不再重复写盘与广播（一次点击会经两条 IPC 路径调用本方法）。
            // 注意：调用方仍会各自调用 syncConfigs()，启动/停止的语义不受影响。
            if (server.enabled === enabled) return true
            this.servers.set(id, {...server, enabled})
            // ★ 必须检查写盘结果：writeMcpConfig 失败时返回 false 而不抛。若忽略返回值，
            //   内存已是新值而磁盘未变，且随后的同值重试会被上面的幂等短路拦下，
            //   造成 UI 与 mcp.json 持续漂移（重启应用表现为「开关莫名回退」）。
            // ⚠️ 用 `=== false` 而非 falsy 判断：只有明确失败（返回 false）才回滚，
            //    避免测试替身或将来签名变化（返回 undefined）时被误判为写盘失败。
            if (writeMcpConfig(Array.from(this.servers.values())) === false) {
                this.servers.set(id, server)   // 回滚内存，保持与磁盘一致
                logger.error('setEnabled', {success: false, error: 'writeMcpConfig failed', id, enabled})
                return false
            }
            this.notify({type: 'list-changed', data: {servers: this.list()}})
        }
        return true
    } catch (err) {
      logger.error('setEnabled', {success: false, error: String(err)})
      return false
    }
  }

  /**
   * 更新单个 server 的配置字段（增量）
   * patch 只接受 McpServer 的配置字段；
   * runtime 字段（status / errorDetail / tools）以及未在 patch 中出现的配置字段（如 enabled）均保留原值。
   */
  update(id: string, patch: Partial<McpServer>): boolean {
    try {
        const server = this.servers.get(id)
        if (!server) {
            logger.error('update', {success: false, id, error: 'server-not-found'})
            return false
        }
        // ★ 保存改动前的对象引用（set 写入的是新对象，原对象未被就地修改），
        //   写盘失败时据此回滚 patch，保持内存与磁盘一致（同 add/delete/setEnabled）。
        const original = server
        this.servers.set(id, {...server, ...patch})
        if (writeMcpConfig(Array.from(this.servers.values())) === false) {
            this.servers.set(id, original)   // 回滚 patch
            logger.error('update', {success: false, error: 'writeMcpConfig failed', id})
            return false
        }
        this.notify({type: 'list-changed', data: {servers: this.list()}})
        return true
    } catch (err) {
      logger.error('update', {success: false, error: String(err)})
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
