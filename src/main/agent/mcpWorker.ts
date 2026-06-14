/**
 * MCP Worker — 共享 MCP 连接池
 *
 * Phase 2: 在独立线程中维护所有 MCP Server 连接，
 * 通过 MessagePort 为多个 Agent Worker 提供共享 MCP 工具调用服务。
 *
 * 架构:
 * ┌─ MCP Worker ──────────────────────────────────┐
 * │ MCPClient 连接池 (复用 mcp/client.ts)         │
 * │ ├─ startServer(config) 并行连接               │
 * │ ├─ callTool(serverId, toolName, args)         │
 * │ └─ 内部 diff: update_servers 全量替换         │
 * │                                                │
 * │ MessagePort 服务                               │
 * │ ├─ call_tool → 转发到 MCPClient               │
 * │ ├─ list_tools → 返回指定 Server 的工具        │
 * │ ├─ list_all → 返回已连接 Server 的工具列表    │
 * │ └─ 200ms 防抖 status_batch → 主进程            │
 * └────────────────────────────────────────────────┘
 */

import {MessagePort, parentPort, workerData} from 'worker_threads'
import {MCPClient} from './mcp/client'
import type {MCPServerConfig} from './mcp/types'

// ─── 类型定义 ──────────────────────────────────────────

interface CallToolRequest {
    type: 'call_tool'
    callId: string
    serverId: string
    toolName: string
    args: Record<string, unknown>
}

interface ListToolsRequest {
    type: 'list_tools'
    callId: string
    serverId: string
}

interface ListAllRequest {
    type: 'list_all'
    callId: string
}

interface McpToolResult {
    success: boolean
    output: string | null
    error?: string
}

interface UpdateServersMessage {
    type: 'update_servers'
    servers: MCPServerConfig[]
}

interface RestartServerMessage {
    type: 'restart_server'
    serverId: string
}

type McpWorkerMessage = CallToolRequest | ListToolsRequest | ListAllRequest | UpdateServersMessage

// ─── MCP Worker 服务 ──────────────────────────────────

// ─── 常量 ──────────────────────────────────────────────

/** 运行时全量同步时每批并行启动的 MCP Server 数量（热缓存，可批量） */
const UPDATE_BATCH_SIZE = 20
/** 批次间隔（毫秒） */
const BATCH_DELAY_MS = 50

/** 将 MCPToolDefinition 转为纯数据 payload（去除引用，用于跨线程传递） */
function toToolPayload(t: { name: string; description?: string; inputSchema: any }): {
  name: string; description?: string; inputSchema: any
} {
  return { name: t.name, description: t.description, inputSchema: t.inputSchema }
}

class McpWorkerService {
    private mcpClient: MCPClient
    private agentPorts = new Set<MessagePort>()

    /** 200ms 防抖状态上报 */
    private pendingStatusUpdates: Array<{
        serverId: string;
        status: string;
        error?: string;
        toolCount?: number;
        tools?: Array<{ name: string; description?: string; inputSchema: any }>
    }> = []
    private statusTimer: NodeJS.Timeout | null = null

    /** 监听 MCPClient 内部状态变化，触发防抖上报 */
    private onStatusChange = (state: {
        config: { id: string }
        status: string
        error?: string
        tools?: Array<{ name: string; description?: string; inputSchema: any }>
    }) => {
        const serverId = state.config.id
        const status = state.status
        const error = state.error
        const toolCount = state.tools?.length
        // 携带完整工具数据，避免在渲染层出现 null 导致崩溃
        const tools = state.tools?.map(toToolPayload)
        this.pendingStatusUpdates = this.pendingStatusUpdates.filter(u => u.serverId !== serverId)
        this.pendingStatusUpdates.push({serverId, status, error, toolCount, tools})
        this.scheduleStatusReport()

        // 连接成功或断开时通知 Agent Worker 更新工具列表
        if (status === 'connected' || status === 'error') {
            this.broadcastToolsUpdate(serverId)
        }

        // 上报 PID 到主进程：进程 spawn 后立即追踪，确保 Worker 崩溃时仍可清理
        // connected/connecting/reconnecting/error → 上报当前 PID（如有）
        // stopped/disconnected → 清除追踪（进程已正常退出）
        if (status === 'stopped' || status === 'disconnected') {
            parentPort?.postMessage({type: 'pid_info', serverId, pid: null})
        } else {
            this.sendPidInfo(serverId)
        }
    }

    /** 上报指定服务器的子进程 PID 到主进程（用于进程泄露防护） */
    private sendPidInfo(serverId: string): void {
        const pid = this.mcpClient.getServerPid(serverId)
        parentPort?.postMessage({type: 'pid_info', serverId, pid: pid ?? null})
    }

    constructor() {
        // MCPClient 使用专用 logger，隔离 Worker 上下文日志
        this.mcpClient = new MCPClient({
            logger: {
                info: (...args: any[]) => parentPort?.postMessage({
                    type: 'worker_log',
                    level: 'info',
                    args: args.map(String)
                }),
                error: (...args: any[]) => parentPort?.postMessage({
                    type: 'worker_log',
                    level: 'error',
                    args: args.map(String)
                }),
                warn: (...args: any[]) => parentPort?.postMessage({
                    type: 'worker_log',
                    level: 'warn',
                    args: args.map(String)
                }),
                debug: (...args: any[]) => parentPort?.postMessage({
                    type: 'worker_log',
                    level: 'debug',
                    args: args.map(String)
                }),
            }
        })

        // 监听所有 MCPClient 状态变化（'*' = 通配符，监听所有 server）
        this.mcpClient.onStatusChange('*', this.onStatusChange)
    }

    /**
     * 两轮串行启动所有启用的 MCP Server
     *
     * 为什么两轮串行:
     * - 冷启动时多个 MCP Server 同时 npx/npm install 会导致:
     *   npm registry 限流、磁盘 IO 争抢、进程数爆炸
     * - 串行确保每个 Server 独占资源，互不干扰
     *
     * 为什么第一轮 0 重试:
     * - 首次下载 npm 包的 Server 本来就慢，重试只会让后面排队的 Server 等更久
     * - 第一轮快筛: 即时可用的 Server 立刻上线（多数 Server 的 npm 包已缓存）
     * - 第二轮后台补: 对冷安装超时的 Server 给完整重试机会，不影响 UI 可用性
     *
     * 运行时更新 (handleUpdateServers) 仍用分批并发，
     * 因为热缓存场景下 npm install 不会重新触发。
     */
    async init(configs: MCPServerConfig[]): Promise<void> {
        const enabled = configs.filter(c => c.enabled)
        const failed: MCPServerConfig[] = []

        // 第一轮: 每个 Server 仅尝试一次，不重试。失败跳过，继续下一个。
        for (const config of enabled) {
            try {
                await this.mcpClient.startServer(config, 0) // maxRetries=0: 不重试
            } catch (err: any) {
                parentPort?.postMessage({
                    type: 'worker_log',
                    level: 'warn',
                    args: [`[Init] ${config.id} (${config.name}) 首轮失败: ${err.message}`],
                })
                failed.push(config)
            }
        }

        // ★ 立即上报 worker_ready，UI 可以开始工作（大部分 Server 已就绪）
        parentPort!.postMessage({type: 'worker_ready'})
        this.reportStatus()

        // 第二轮: 后台逐一修复失败的 Server，带完整重试能力
        if (failed.length > 0) {
            parentPort?.postMessage({
                type: 'worker_log',
                level: 'info',
                args: [`[Init] 首轮完成，${failed.length} 个 Server 启动失败，进入后台修复...`],
            })
            this.backgroundRetry(failed).catch(() => {})
        }
    }

    /**
     * 后台修复首轮启动失败的 MCP Server
     * 逐个重试，每次间隔 2s 避免资源争抢
     */
    private async backgroundRetry(failed: MCPServerConfig[]): Promise<void> {
        for (const config of failed) {
            try {
                parentPort?.postMessage({
                    type: 'worker_log',
                    level: 'info',
                    args: [`[Init] 后台重试: ${config.id} (${config.name})...`],
                })
                await this.mcpClient.startServer(config) // maxRetries=5 (默认)
                parentPort?.postMessage({
                    type: 'worker_log',
                    level: 'info',
                    args: [`[Init] 后台修复成功: ${config.id} (${config.name})`],
                })
            } catch (err: any) {
                parentPort?.postMessage({
                    type: 'worker_log',
                    level: 'error',
                    args: [`[Init] 后台修复失败: ${config.id} (${config.name}): ${err.message}`],
                })
            }
            // 间隔 2 秒，让前一个的重试循环完全结束，资源释放干净
            await new Promise(r => setTimeout(r, 2000))
        }
    }

    /** 注册 Agent Worker MessagePort */
    registerAgent(port: MessagePort): void {
        this.agentPorts.add(port)

        port.on('message', (req: McpWorkerMessage) => {
            switch (req.type) {
                case 'call_tool':
                    this.handleCallTool(port, req).catch(err =>
                        port.postMessage({
                            type: 'tool_result',
                            callId: req.callId,
                            result: {success: false, output: null, error: err.message}
                        })
                    )
                    break
                case 'list_tools':
                    this.handleListTools(port, req)
                    break
                case 'list_all':
                    this.handleListAll(port)
                    break
            }
        })

        port.on('close', () => {
            this.agentPorts.delete(port)
        })

        port.start()
    }

    /** 处理全量配置替换（内部 diff） */
    async handleUpdateServers(configs: MCPServerConfig[]): Promise<void> {
        const existingServers = this.mcpClient.getAllServers()
        const configMap = new Map(configs.map(c => [c.id, c]))

        // 1. 断开不存在的 Server + 已禁用的 Server
        for (const existing of existingServers) {
            const newConfig = configMap.get(existing.config.id)
            if (!newConfig || !newConfig.enabled) {
                await this.mcpClient.stopServer(existing.config.id)
            }
        }

        // 2. 新增或重新启用的 Server（分批启动）
        // 注意：不能用 existingIds 判断，因为步骤 1 可能已移除部分服务器
        // ★ 跳过正在重启中的 server，避免与 restartServer 竞争导致重复进程
        const toStart = configs.filter(c =>
            c.enabled &&
            !this.mcpClient.isConnected(c.id) &&
            !this.pendingRestarts.has(c.id)
        )
        for (let i = 0; i < toStart.length; i += UPDATE_BATCH_SIZE) {
            const batch = toStart.slice(i, i + UPDATE_BATCH_SIZE)
            await Promise.allSettled(batch
                // ★ 二次检查：step 1 的 await 期间 restartServer 可能已将 server 加入 pendingRestarts
                // （TOCTOU 防护——filter 计算在 await 之前，pendingRestarts 变化在 await 期间）
                .filter(c => !this.pendingRestarts.has(c.id))
                .map(c => this.mcpClient.startServer(c).catch(() => {
                }))
            )
            if (i + UPDATE_BATCH_SIZE < toStart.length) {
                await new Promise(r => setTimeout(r, BATCH_DELAY_MS))
            }
        }
    }

    // ─── 消息处理 ──────────────────────────────────────

    private async handleCallTool(port: MessagePort, req: CallToolRequest): Promise<void> {
        const result = await this.mcpClient.callTool(req.serverId, req.toolName, req.args)

        const textParts = (result.content || [])
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('\n')

        port.postMessage({
            type: 'tool_result',
            callId: req.callId,
            result: {
                success: !result.isError,
                output: textParts || '(无输出)',
                error: result.isError ? textParts : undefined,
            } as McpToolResult,
        })
    }

    private handleListTools(port: MessagePort, req: ListToolsRequest): void {
        const server = this.mcpClient.getServer(req.serverId)
        if (!server) {
            port.postMessage({type: 'tools_result', callId: req.callId, tools: [], userDescription: undefined})
            return
        }

        port.postMessage({
            type: 'tools_result',
            callId: req.callId,
            tools: server.tools.map(toToolPayload),
            userDescription: server.config.userDescription,
        })
    }

    private handleListAll(port: MessagePort): void {
        const servers = this.mcpClient.getAllServers()
            .filter(s => s.status === 'connected')
            .map(s => ({
                id: s.config.id,
                name: s.config.name,
                status: s.status,
                tools: s.tools.map(toToolPayload),
                userDescription: s.config.userDescription,
            }))

        port.postMessage({type: 'all_result', servers})
    }

    // ─── 状态通知 ──────────────────────────────────────

    private scheduleStatusReport(): void {
        if (this.statusTimer) return
        this.statusTimer = setTimeout(() => {
            this.statusTimer = null
            if (this.pendingStatusUpdates.length > 0) {
                const batch = this.pendingStatusUpdates.splice(0)
                parentPort!.postMessage({type: 'status_batch', updates: batch})
            }
        }, 200)
    }

    private reportStatus(): void {
        const servers = this.mcpClient.getAllServers().map(s => ({
            serverId: s.config.id,
            status: s.status,
            error: s.error,
            toolCount: s.tools.length,
            tools: s.tools.map(toToolPayload),
        }))
        parentPort!.postMessage({type: 'status_batch', updates: servers})
    }

    /** 正在重启中的 Server（去重用） */
    private pendingRestarts = new Set<string>()

    /** 重启单个 MCP Server（停→启，不依赖全量 diff） */
    async restartServer(serverId: string, config?: MCPServerConfig): Promise<void> {
        // 去重：同一 serverId 的并发重启请求合并为一次
        if (this.pendingRestarts.has(serverId)) {
            parentPort?.postMessage({
                type: 'worker_log', level: 'warn',
                args: [`[restartServer] ${serverId} already being restarted, skipping duplicate request`],
            })
            // ★ 通知主进程：此次请求被合并（不算失败，等待原重启完成即可）
            parentPort?.postMessage({type: 'restart_complete', serverId, success: true, merged: true})
            return
        }
        this.pendingRestarts.add(serverId)
        try {
            await this.mcpClient.stopServer(serverId).catch(() => {})
            // 优先使用主进程传来的最新配置（含 mcp.json 最新字段），
            // 兜底用 Worker 内存中的缓存的配置
            const cfg = config ?? this.mcpClient.getServer(serverId)?.config
            if (cfg) {
                await this.mcpClient.startServer(cfg)
                parentPort?.postMessage({type: 'restart_complete', serverId, success: true})
            } else {
                parentPort?.postMessage({type: 'restart_complete', serverId, success: false, error: '配置丢失'})
            }
        } catch (err: any) {
            parentPort?.postMessage({type: 'worker_log', level: 'error', args: [`[restartServer] ${serverId} failed: ${err.message}`]})
            parentPort?.postMessage({type: 'restart_complete', serverId, success: false, error: err.message})
        } finally {
            this.pendingRestarts.delete(serverId)
        }
    }

    /** 通知所有 Agent Worker：指定 Server 的工具列表已更新 */
    private broadcastToolsUpdate(serverId: string): void {
        const server = this.mcpClient.getServer(serverId)
        if (!server) return

        const toolsPayload = {
            id: server.config.id,
            name: server.config.name,
            tools: server.tools.map(toToolPayload),
            userDescription: server.config.userDescription,
            status: server.status,
        }

        for (const port of this.agentPorts) {
            try {
                port.postMessage({type: 'server_tools_update', server: toolsPayload})
            } catch { /* 端口可能已关闭 */
            }
        }
    }
}

// ─── 入口 ──────────────────────────────────────────────

const service = new McpWorkerService()
const configs: MCPServerConfig[] = (workerData as any)?.servers || []
service.init(configs).catch(err => {
    parentPort?.postMessage({type: 'worker_error', error: err.message})
})

// 监听主进程消息（注册 Agent Worker、更新配置、定时清理）
parentPort!.on('message', (msg: any) => {
    switch (msg.type) {
        case 'register_agent':
            if (msg.port) service.registerAgent(msg.port)
            break

        case 'update_servers':
            if (msg.servers) {
                service.handleUpdateServers(msg.servers).catch(err => {
                    parentPort?.postMessage({type: 'worker_error', error: err.message})
                })
            }
            break

        case 'restart_server':
            if (msg.serverId) {
                service.restartServer(msg.serverId, msg.config).catch(err => {
                    parentPort?.postMessage({type: 'worker_error', error: err.message})
                })
            }
            break

        case 'cleanup_stopped': {
            const count = service['mcpClient'].cleanupStoppedServers()
            if (count > 0) {
                parentPort?.postMessage({
                    type: 'worker_log',
                    level: 'info',
                    args: [`[Cleanup] 清理了 ${count} 个僵尸 MCP 服务器进程`]
                })
            }
            break
        }

        case 'shutdown':
            // 优雅关闭：断开所有 MCP 服务器连接 → Worker 自然退出
            Promise.allSettled(
                service['mcpClient'].getAllServers().map(s => service['mcpClient'].stopServer(s.config.id))
            ).finally(() => parentPort?.close())
            break
    }
})
