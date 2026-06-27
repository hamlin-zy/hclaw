/**
 * MCPClient — 管理 MCP 服务器连接、工具发现和调用
 *
 * 职责：
 * 1. 管理多个 MCP Server 连接
 * 2. 发现远程工具并注册到 ToolRegistry
 * 3. 转发工具调用到对应的 MCP Server
 * 4. 资源访问
 */

import {logger} from '../logger'
import {HCLAW_VERSION} from '../../../shared/types'
import type {
    MCPResource,
    MCPResourceContent,
    MCPServerConfig,
    MCPServerInfo,
    MCPServerState,
    MCPToolCallResult,
    MCPToolDefinition,
} from './types'
import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js'
import {ToolListChangedNotificationSchema} from '@modelcontextprotocol/sdk/types.js'
import type {MCPTransportOptions} from './transport/transport'
import {createStdioTransport, killProcessTree} from './transport/stdio'
import {isProcessRunning, waitForProcessExit} from './transport/processUtils'
import {SSEClientTransport} from '@modelcontextprotocol/sdk/client/sse.js'
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {WebSocketClientTransport} from '@modelcontextprotocol/sdk/client/websocket.js'
import {toMcpToolDefinition, toMcpToolCallResult} from './sdkAdapter'

import path from 'path'
import fs from 'fs'
import {PluginRegistry} from '../../plugin/registry'

/** 内部状态：包含不可序列化的 transport 实例 */
interface InternalServerState {
  config: MCPServerConfig
  status: 'disconnected' | 'connecting' | 'connected' | 'error' | 'stopped' | 'reconnecting'
  serverInfo?: MCPServerInfo
  tools: MCPToolDefinition[]
  resources: MCPResource[]
  error?: string
  /** SDK Client 实例（协议层） */
  sdkClient?: Client
  /** SDK Transport 实例（传输层 — stdio/sse/streamableHttp/websocket） */
  sdkTransport?: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport | WebSocketClientTransport
  /** 重连尝试计数器 */
  reconnectAttempts?: number
  /** 最近一次错误时间戳 */
  lastErrorTime?: number
  /** 进入 stopped 状态的时间戳（用于 5 分钟后清理） */
  stoppedTime?: number
  /** 持久化的子进程 PID，跨 transport 生命周期追踪 */
  lastPid?: number
}

export class MCPClient {
  /** serverId → InternalServerState */
  private servers: Map<string, InternalServerState> = new Map()

  /** 状态变化监听器: serverId → Set<回调> */
  private statusListeners: Map<string, Set<(state: MCPServerState) => void>> = new Map()

  /** Phase 2: 日志适配器（MCP Worker 上下文传入隔离的 logger） */
  private log: {
    info: (...args: any[]) => void;
    error: (...args: any[]) => void;
    warn: (...args: any[]) => void;
    debug: (...args: any[]) => void
  }

  constructor(options?: { logger?: { info?: Function; error?: Function; warn?: Function; debug?: Function } }) {
    const l = options?.logger
    // 统一使用项目 logger，避免降级到裸 console 绕过日志审计
    const levels = ['info', 'error', 'warn', 'debug'] as const
    this.log = Object.fromEntries(
      levels.map(level => [
        level,
        (...args: unknown[]) => {
          if (l?.[level]) (l[level] as Function)(...args)
          else if (args[0]) logger[level](String(args[0]), args.length > 1 ? { extra: args.slice(1) } : undefined)
        },
      ])
    ) as MCPClient['log']
  }

  /**
   * 启动服务器
   * @param config MCP 服务器配置
   * @param maxRetries 连接失败后的最大重试次数（默认 5，传 0 表示仅尝试一次不重试）
   */
  async startServer(config: MCPServerConfig, maxRetries = 5): Promise<void> {
    return this.connect(config, maxRetries)
  }

  /**
   * 从插件目录加载 MCP 服务器配置
     *
     * 插件 MCP 配置位置：
     * ~/.hclaw/plugins/{pluginName}/mcp/servers.json
     *
     * 格式：
     * {
     *   "mcpServers": {
     *     "server-name": {
     *       "command": "...",
     *       "args": [...],
     *       "env": {...},
     *       "cwd": "..."
     *     }
     *   }
     * }
     */
    async loadPluginServers(): Promise<void> {
        const registry = PluginRegistry.getInstance()
        const enabledPlugins = registry.getEnabled()

        for (const plugin of enabledPlugins) {
            const mcpPath = path.join(plugin.path, 'mcp', 'servers.json')

            if (!fs.existsSync(mcpPath)) {
                continue
            }

            try {
                const content = fs.readFileSync(mcpPath, 'utf-8')
                const serversData = JSON.parse(content)

                if (!serversData || typeof serversData !== 'object') {
                                        continue
                }

                const mcpServers = serversData.mcpServers as Record<string, {
                    command?: string
                    args?: string[]
                    env?: Record<string, string>
                    cwd?: string
                }> | undefined

                if (!mcpServers || typeof mcpServers !== 'object') {
                    continue
                }

                // 设置插件根目录环境变量
                const pluginRoot = path.dirname(path.dirname(mcpPath)) // .../plugins/{pluginName}

                for (const [serverName, serverConfig] of Object.entries(mcpServers)) {
                    const serverId = `mcp_${plugin.name}_${serverName}`

                    // 合并环境变量，注入 CLAUDE_PLUGIN_ROOT
                    const env = {
                        ...serverConfig.env,
                        CLAUDE_PLUGIN_ROOT: pluginRoot,
                    }

                    const config: MCPServerConfig = {
                        id: serverId,
                        name: serverName,
                        transport: 'stdio',
                        command: serverConfig.command,
                        args: serverConfig.args,
                        env,
                        enabled: true,
                    }

                    try {
                        await this.startServer(config)
                    } catch (err) {
                        logger.error('[MCPClient] startServer failed', {error: err})
                    }
                }
            } catch (err) {
                logger.error('[MCPClient] loadMcpConfig failed', {error: err})
            }
        }
    }

    /** 停止服务器 */
    async stopServer(serverId: string): Promise<void> {
        const state = this.servers.get(serverId)
        if (!state) return

        // ★ 先标记为 stopped，让正在运行的 doConnect 循环立即检测到并中止
        state.status = 'stopped'
        state.tools = []
        state.resources = []

        // SDK close → stdin.end() → 2s SIGTERM → 2s SIGKILL
        if (state.sdkClient) {
            try { await state.sdkClient.close() } catch {}
        }

        // ★ taskkill 兜底（Windows 进程树杀，清理 npx 的孙进程）
        if (state.lastPid) {
            killProcessTree(state.lastPid)
            await waitForProcessExit(state.lastPid)
        }

        state.sdkClient = undefined
        state.sdkTransport = undefined
        state.stoppedTime = Date.now()
    }

    /** 测试连接（沙盒化流程） — 使用 SDK Client */
    async testConnection(config: MCPServerConfig): Promise<{
        success: boolean;
        tools?: MCPToolDefinition[];
        error?: string
    }> {
        let sdkClient: Client | undefined
        try {
            const transportOptions = this.getTransportOptions(config)
            const sdkTransport = this.createTransport(config)

            sdkClient = new Client(
                { name: 'HClaw', version: HCLAW_VERSION },
                { capabilities: {} },
            )

            const testTimeout = transportOptions.connectTimeout ?? 60_000
            const connectPromise = sdkClient.connect(sdkTransport)
            const timeout = new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`测试连接超时 (${Math.round(testTimeout / 1000)}s)`)), testTimeout)
            )
            await Promise.race([connectPromise, timeout])

            const { tools } = await sdkClient.listTools()
            return { success: true, tools: tools.map(toMcpToolDefinition) }
        } catch (err: any) {
            return { success: false, error: err.message }
        } finally {
            try { await sdkClient?.close() } catch {}
        }
    }

    /** 连接服务器（带指数退避重连） */
    /**
     * 连接服务器
     * @param config MCP 服务器配置
     * @param maxRetries 失败后的最大重试次数（默认 5，传 0 表示仅尝试一次不重试）
     */
  async connect(config: MCPServerConfig, maxRetries = 5): Promise<void> {
    // ★ PID 闭环：取出旧 state 的 PID，确认旧进程已退出后再启动新进程
    const oldState = this.servers.get(config.id)
    const oldPid = oldState?.lastPid
    if (oldPid && isProcessRunning(oldPid)) {
        // 旧进程仍在运行（可能的上次异常退出未清理干净），强制杀掉并确认
        try {
            killProcessTree(oldPid)
        } catch {}
        await waitForProcessExit(oldPid)
    }

    if (this.servers.has(config.id)) {
      await this.disconnect(config.id)
    }

    const state: InternalServerState = {
      config,
      status: 'connecting',
      tools: [],
      resources: [],
        reconnectAttempts: 0,
        // 继承旧 PID 作为兜底（如果 doConnect 捕获了新 PID 会覆盖）
        lastPid: oldPid,
    }
    this.servers.set(config.id, state)

        // ★ 立即通知 UI：状态变为 connecting
        this.emitStatusChange(config.id, this.getServer(config.id)!)

        const INITIAL_DELAY_MS = 1000
        const MAX_DELAY_MS = 30000

        await this.doConnect(state, maxRetries, INITIAL_DELAY_MS, MAX_DELAY_MS)
    }

    /**
     * 执行连接，内部实现指数退避重连
     */
    private async doConnect(
        state: InternalServerState,
        maxRetries: number,
        initialDelayMs: number,
        maxDelayMs: number,
    ): Promise<void> {
        let lastError: Error | undefined

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            // ★ 中止检查
            if (state.status === 'stopped') {
                state.error = 'Cancelled by external stop'
                this.emitStatusChange(state.config.id, this.getServer(state.config.id)!)
                return
            }

            state.reconnectAttempts = attempt

            if (attempt > 0) {
                const delay = Math.min(initialDelayMs * Math.pow(2, attempt - 1), maxDelayMs)
                state.status = 'reconnecting'
                this.emitStatusChange(state.config.id, this.getServer(state.config.id)!)
                await this.sleep(delay)
                if ((state.status as string) === 'stopped') {
                    state.error = 'Cancelled by external stop'
                    this.emitStatusChange(state.config.id, this.getServer(state.config.id)!)
                    return
                }
            }

            try {
                state.sdkTransport = this.createTransport(state.config)

                // ★ 创建 SDK Client
                const sdkClient = new Client(
                    { name: 'HClaw', version: HCLAW_VERSION },
                    { capabilities: {} },
                )
                state.sdkClient = sdkClient

                // ★ SDK 一键握手（initialize + initialized）
                await sdkClient.connect(state.sdkTransport!)

                // ★ PID 捕获（仅 stdio 有子进程）
                if (state.sdkTransport instanceof StdioClientTransport) {
                    const pid = state.sdkTransport.pid
                    if (pid) state.lastPid = pid
                }

                // ★ transport 已启动，立即通知状态（确保 PID 被追踪，UI 可看到进度）
                this.emitStatusChange(state.config.id, this.getServer(state.config.id)!)

                // ★ 连接成功，记录服务器信息
                const serverCapabilities = sdkClient.getServerCapabilities()
                const serverVersion = sdkClient.getServerVersion()
                state.serverInfo = {
                    name: serverVersion?.name ?? state.config.name,
                    version: serverVersion?.version ?? 'unknown',
                    capabilities: serverCapabilities as MCPServerInfo['capabilities'],
                }
                state.status = 'connected'
                state.reconnectAttempts = 0
                state.lastErrorTime = undefined

                // ★ 通过 SDK 发现工具
                if (serverCapabilities?.tools) {
                    const { tools } = await sdkClient.listTools()
                    state.tools = tools.map(toMcpToolDefinition)
                }

                // ★ 注册 tool list changed 通知
                if (serverCapabilities?.tools?.listChanged) {
                    sdkClient.setNotificationHandler(
                        ToolListChangedNotificationSchema,
                        async () => {
                            try {
                                const { tools } = await sdkClient.listTools()
                                state.tools = tools.map(toMcpToolDefinition)
                                this.emitStatusChange(state.config.id, this.getServer(state.config.id)!)
                            } catch {
                                // 重新拉取工具列表失败，忽略（保持旧列表）
                            }
                        },
                    )
                }

                // 工具发现完成后通知
                this.emitStatusChange(state.config.id, this.getServer(state.config.id)!)
                this.log.info('[MCP] Connected:', state.config.name)
                return

            } catch (err: any) {
                lastError = err
                state.status = 'error'
                state.error = err.message

                this.log.error(
                    `[MCP] Connection attempt ${attempt}/${maxRetries} failed for "${state.config.name}": ${err.message}`,
                )

                // 通知状态变化（单次失败）
                this.emitStatusChange(state.config.id, this.getServer(state.config.id)!)

                // ★ 捕获 PID → 关闭 transport → taskkill 兜底清理进程树
                try {
                    if (state.sdkTransport instanceof StdioClientTransport) {
                        state.lastPid = state.sdkTransport.pid ?? undefined
                    }
                    await state.sdkTransport?.close()
                    if (state.lastPid) {
                        killProcessTree(state.lastPid)
                        await waitForProcessExit(state.lastPid)
                    }
                } catch {}
                state.sdkTransport = undefined
                state.sdkClient = undefined
            }
        }

        // 所有重试都失败
        state.status = 'error'
        state.error = lastError?.message || 'Connection failed'
        state.lastErrorTime = Date.now()
        this.emitStatusChange(state.config.id, this.getServer(state.config.id)!)
        this.log.info('[MCP] Connection failed:', state.config.name, '-', lastError?.message)
        throw lastError || new Error('MCP server connection failed')
    }

    /** 工具方法：sleep */
    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /** 断开连接 */
  async disconnect(serverId: string): Promise<void> {
    const state = this.servers.get(serverId)
    if (!state) return

    // 断开 SDK 连接
    if (state.sdkClient) {
        try { await state.sdkClient.close() } catch {}
    }

    // 确保进程已终止——如果 SDK close 未能清理，强制杀死
    if (state.lastPid && isProcessRunning(state.lastPid)) {
        killProcessTree(state.lastPid)
        await waitForProcessExit(state.lastPid)
    }

    // 设置为 stopped 状态后再通知
    state.status = 'stopped'
    this.log.info('[MCP] Disconnected:', serverId)

    // 触发状态变化通知
    this.emitStatusChange(serverId, this.getServer(serverId)!)

    // 清理监听器
    this.statusListeners.delete(serverId)

    // 从 Map 中移除
    this.servers.delete(serverId)
  }

  /** 断开所有 */
  async disconnectAll(): Promise<void> {
    const ids = Array.from(this.servers.keys())
    await Promise.all(ids.map((id) => this.disconnect(id)))
  }

  /**
   * 清理已停止的服务器状态
   * 用于定期回收不再需要的内存
   */
  cleanupStoppedServers(): number {
    const toRemove: string[] = []
    const FIVE_MINUTES_MS = 5 * 60 * 1000

    for (const [id, state] of this.servers) {
      // 保留正在连接/已连接/重连中的服务器
      if (['connecting', 'connected', 'reconnecting'].includes(state.status)) {
        continue
      }
      // 清理已停止超过 5 分钟的服务器
      if (state.status === 'stopped') {
        const stoppedTime = state.stoppedTime
        if (stoppedTime && Date.now() - stoppedTime >= FIVE_MINUTES_MS) {
          toRemove.push(id)
        }
      }
    }

    for (const id of toRemove) {
      this.servers.delete(id)
      this.statusListeners.delete(id)
    }

    return toRemove.length
  }

  /** 调用 MCP 工具 */
  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<MCPToolCallResult> {
    const state = this.servers.get(serverId)
    if (!state || state.status !== 'connected' || !state.sdkClient) {
      throw new Error(`MCP 服务器 "${serverId}" 未连接`)
    }

    const result = await state.sdkClient.callTool({
      name: toolName,
      arguments: args,
    })

    // 类型窄化：SDK callTool 返回联合类型（正常 / task），
    // 不传 resultSchema 时始终返回 CallToolResult 形状（有 content + isError）
    return toMcpToolCallResult(
      result as Parameters<typeof toMcpToolCallResult>[0],
    )
  }

    /**
     * 检查工具是否在 autoApprove 列表中（调用时无需用户确认）
     */
    isToolAutoApproved(serverId: string, toolName: string): boolean {
        const state = this.servers.get(serverId)
        if (!state?.config.autoApprove?.length) return false
        return state.config.autoApprove.some(
            name => name === toolName || name === '*' // * 通配符表示全部自动批准
        )
    }

    /**
     * 获取指定服务器的 denyList
     */
    getDeniedToolNames(serverId: string): string[] {
        const state = this.servers.get(serverId)
        return state?.config.denyList ?? []
    }

    /**
     * 检查工具是否被 denyList 禁止
     */
    isToolDenied(serverId: string, toolName: string): boolean {
        const denied = this.getDeniedToolNames(serverId)
        return denied.some(
            name => name === toolName || name === '*' // * 通配符表示全部拒绝
        )
    }

    /**
     * 获取服务器的有效工具列表（已过滤 denyList）
     */
    getEffectiveTools(serverId: string): MCPToolDefinition[] {
        const state = this.servers.get(serverId)
        if (!state) return []
        const denied = this.getDeniedToolNames(serverId)
        if (!denied.length) return state.tools
        return state.tools.filter(t => !this.isToolDenied(serverId, t.name))
    }

  /** 读取资源 */
  async readResource(serverId: string, uri: string): Promise<MCPResourceContent> {
    const state = this.servers.get(serverId)
    if (!state || state.status !== 'connected' || !state.sdkClient) {
      throw new Error(`MCP 服务器 "${serverId}" 未连接`)
    }

    const result = await state.sdkClient.readResource({ uri })

    const contents = result.contents as unknown as MCPResourceContent[]
    return contents?.[0] || { uri }
  }

    /**
     * 获取所有已连接服务器的工具定义
     * @param filterDenied 是否过滤 denyList（默认 false）
     */
    getAllToolDefinitions(filterDenied = false): Map<string, MCPToolDefinition[]> {
    const result = new Map<string, MCPToolDefinition[]>()
    for (const [id, state] of this.servers) {
        if (state.status !== 'connected' || state.tools.length === 0) continue
        const tools = filterDenied ? this.getEffectiveTools(id) : state.tools
        if (tools.length > 0) result.set(id, tools)
    }
    return result
  }

  /** 获取所有服务器状态（不含 transport） */
  getAllServers(): MCPServerState[] {
    return Array.from(this.servers.values()).map((s) => ({
      config: s.config,
      status: s.status,
      serverInfo: s.serverInfo,
      tools: s.tools,
      resources: s.resources,
      error: s.error,
        reconnectAttempts: s.reconnectAttempts,
        lastErrorTime: s.lastErrorTime,
    }))
  }

  /** 获取指定服务器状态（不含 transport） */
  getServer(serverId: string): MCPServerState | undefined {
    const s = this.servers.get(serverId)
    if (!s) return undefined
    return {
      config: s.config,
      status: s.status,
      serverInfo: s.serverInfo,
      tools: s.tools,
      resources: s.resources,
      error: s.error,
        reconnectAttempts: s.reconnectAttempts,
        lastErrorTime: s.lastErrorTime,
    }
  }

  /** 检查是否已连接 */
  isConnected(serverId: string): boolean {
    const state = this.servers.get(serverId)
    return state?.status === 'connected'
  }

  /** 获取指定服务器的子进程 PID（仅 stdio 有效） */
  getServerPid(serverId: string): number | undefined {
    const state = this.servers.get(serverId)
    return state?.lastPid ?? undefined
  }

  // ─── 状态变化事件 ─────────────────────────────────

  /**
   * 订阅指定 server 的状态变化
   * @param serverId '*' 监听所有
   */
  onStatusChange(serverId: string, listener: (state: MCPServerState) => void): () => void {
    if (!this.statusListeners.has(serverId)) {
      this.statusListeners.set(serverId, new Set())
    }
    this.statusListeners.get(serverId)!.add(listener)
    return () => this.statusListeners.get(serverId)?.delete(listener)
  }

  /**
   * 触发状态变化通知
   */
  private emitStatusChange(serverId: string, state: MCPServerState): void {
    // 触发指定 server 的监听器
    this.statusListeners.get(serverId)?.forEach(fn => fn(state))
    // 触发通配符监听器
    this.statusListeners.get('*')?.forEach(fn => fn(state))
  }

  // ─── 内部 ──────────────────────────────────────────

  /**
   * 根据配置创建 SDK Transport 实例
   * 被 testConnection() 和 doConnect() 共用，消除两份 switch 的重复
   */
  private createTransport(config: MCPServerConfig): StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport | WebSocketClientTransport {
    const requestInit = config.headers ? { headers: config.headers } : undefined
    switch (config.transport) {
      case 'stdio':
        return createStdioTransport({
          command: config.command!,
          args: config.args,
          env: config.env,
          cwd: config.cwd,
          stderr: 'pipe',
        })
      case 'sse':
        return new SSEClientTransport(new URL(config.url!), { requestInit })
      case 'http':
      case 'streamable-http':
        return new StreamableHTTPClientTransport(new URL(config.url!), { requestInit })
      case 'websocket':
        return new WebSocketClientTransport(new URL(config.url!))
      default:
        throw new Error(`不支持的传输方式: ${config.transport}`)
    }
  }

  /**
   * 获取 Transport 配置选项
   */
  private getTransportOptions(config?: MCPServerConfig): MCPTransportOptions {
      // 优先使用服务器级别的 timeout，否则使用 60 秒默认值
      const serverTimeout = config?.timeout ?? 60_000
    return {
        requestTimeout: serverTimeout,
        shutdownTimeout: 5_000,
        connectTimeout: serverTimeout,
    }
  }

}

/** 全局单例 */
export const mcpClient = new MCPClient()
