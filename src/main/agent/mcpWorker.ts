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
import {cpus} from 'os'
import {MCPClient} from './mcp/client'
import type {MCPServerConfig} from './mcp/types'
import {formatMcpResult} from './mcp/formatResult'

// ─── 首轮启动并发参数 ──────────────────────────────────
/**
 * 本地 stdio 池并发度。
 *
 * 上限取 6 的理由是「内存与进程创建成本」，不是 CPU：每个 MCP Server 常驻 50–150MB，
 * 且 Windows 上 npx 经 cmd.exe 包装，每个 Server 实际产生 2–3 个进程，
 * 冷启动还会触发杀软实时扫描。故只取一半核心数留出余量给 UI 与其余进程。
 */
const STDIO_CONCURRENCY = Math.max(2, Math.min(Math.floor(cpus().length / 2), 6))
/**
 * 远端池并发度。http/sse/ws 连接廉价、无本地子进程与内存开销，可取 2×，但仍设绝对上限 12。
 */
const REMOTE_CONCURRENCY = Math.min(STDIO_CONCURRENCY * 2, 12)
/** 每个任务真正启动前的随机抖动下限（ms）——避免 npx 冷启动同时打盘 */
const JITTER_MIN_MS = 100
/** 每个任务真正启动前的随机抖动上限（ms） */
const JITTER_MAX_MS = 300

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

/**
 * 权限查询请求（catalog 通道：call_mcp_tool 执行期需按 (serverId, 原始工具名) 重查
 * denyList / autoApprove；agent worker 内无 MCPClient 实例，经 MessagePort 转发到本 Worker）
 */
interface GetToolPermissionRequest {
    type: 'get_tool_permission'
    callId: string
    serverId: string
    toolName: string
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

type McpWorkerMessage = CallToolRequest | ListToolsRequest | ListAllRequest | GetToolPermissionRequest | UpdateServersMessage

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
    /** port → 归属会话 ID。主进程 cleanup 时据此显式注销（见 unregisterAgents） */
    private agentPortOwner = new Map<MessagePort, string>()

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
     * 两轮限流并发启动所有启用的 MCP Server
     *
     * 为什么限流并发（而非串行）:
     * - 串行会让「能力可用时间」等于所有 Server 握手时间之和，最慢的一个拖满整个启动窗口；
     * - 全量并发又会造成 npm registry 限流、磁盘 IO 争抢、进程数爆炸。
     *   故取受限并发：本地 stdio 走低并发池（见 STDIO_CONCURRENCY 注释：内存/进程成本决定上限），
     *   远端口走独立高并发池（REMOTE_CONCURRENCY）。
     *
     * 为什么按 transport 分池:
     * - stdio 每个连接都是一个常驻子进程（含 npx/cmd.exe 包装），成本高；
     * - http/sse/ws 只有网络连接，成本低，可与 stdio 池并行且自身并发更高。
     * 两个池互相独立、同时推进。
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

        // 第一轮: 每个 Server 仅尝试一次，不重试。失败记录后继续，不影响其他 Server。
        const firstAttempt = async (config: MCPServerConfig): Promise<void> => {
            try {
                const r = await this.mcpClient.startServer(config, 0) // maxRetries=0: 不重试
                if (!r.success) {
                    parentPort?.postMessage({
                        type: 'worker_log',
                        level: 'warn',
                        args: [`[Init] ${config.id} (${config.name}) 首轮失败: ${r.error}`],
                    })
                    failed.push(config)
                }
            } catch (err: any) {
                // P6 后 startServer 理论上不抛；此处为兜底，保证该 Server 不被静默丢弃、worker_ready 一定发出
                parentPort?.postMessage({
                    type: 'worker_log',
                    level: 'warn',
                    args: [`[Init] ${config.id} (${config.name}) 首轮失败: ${err.message}`],
                })
                failed.push(config)
            }
        }

        // 按 transport 分池：本地 stdio 低并发、远端高并发；两池并行推进。
        const stdioConfigs = enabled.filter(c => c.transport === 'stdio')
        const remoteConfigs = enabled.filter(c => c.transport !== 'stdio')
        await Promise.all([
            this.runPool(stdioConfigs, STDIO_CONCURRENCY, firstAttempt),
            this.runPool(remoteConfigs, REMOTE_CONCURRENCY, firstAttempt),
        ])

        // ★ 上报时机不变：所有 Server 均已尝试过一轮（部分可能仍在后台重试）。
        //   并发化后只会更早发出，不会延后。
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
     * 限流并发池：以 concurrency 条泳道消费 configs，每条泳道串行取下一个任务。
     *
     * 正确性保证：
     * - `cursor++` 在单线程 JS 中同步取号（await 之前），不会出现重复处理或遗漏；
     * - 泳道数 clamp 到 `[1, configs.length]`，空数组不会空转；
     * - 任务本身不抛（由 firstAttempt 内部兜底），泳道不会因异常中断而丢任务。
     *
     * @param configs 待处理的 Server 配置
     * @param concurrency 该池的并发度
     * @param task 单个 Server 的处理函数（需自行吞异常，保证泳道存活）
     */
    private runPool(
        configs: MCPServerConfig[],
        concurrency: number,
        task: (config: MCPServerConfig) => Promise<void>,
    ): Promise<void[]> {
        let cursor = 0
        const lane = async (): Promise<void> => {
            while (true) {
                const index = cursor++
                if (index >= configs.length) return
                const config = configs[index]
                // ★ 抖动：错开真正的进程创建时刻，避免多个 npx 冷启动同时打盘
                const jitter = JITTER_MIN_MS + Math.random() * (JITTER_MAX_MS - JITTER_MIN_MS)
                await new Promise(r => setTimeout(r, jitter))
                // ★ 泳道必须存活：task 一旦抛出会让 Promise.all reject，
                //   worker_ready 将永不发出、主进程 readyPromise 悬挂（无超时兜底）
                try {
                    await task(config)
                } catch (err: any) {
                    parentPort?.postMessage({
                        type: 'worker_log',
                        level: 'error',
                        args: [`[Init] 池任务异常（已隔离，不影响其他 Server）: ${config.id} (${config.name}) ${err?.message ?? String(err)}`],
                    })
                }
            }
        }
        const lanes = Math.max(1, Math.min(concurrency, configs.length))
        return Promise.all(Array.from({length: lanes}, lane))
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
                const r = await this.mcpClient.startServer(config) // maxRetries=5 (默认)
                if (r.success) {
                    parentPort?.postMessage({
                        type: 'worker_log',
                        level: 'info',
                        args: [`[Init] 后台修复成功: ${config.id} (${config.name})`],
                    })
                } else {
                    parentPort?.postMessage({
                        type: 'worker_log',
                        level: 'error',
                        args: [`[Init] 后台修复失败: ${config.id} (${config.name}): ${r.error}`],
                    })
                }
            } catch (err: any) {
                // P6 后理论上不抛；兜底
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

    /** 注册 Agent Worker MessagePort（conversationId 用于主进程显式注销） */
    registerAgent(port: MessagePort, conversationId?: string): void {
        this.agentPorts.add(port)
        if (conversationId) this.agentPortOwner.set(port, conversationId)

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
                case 'get_tool_permission':
                    this.handleGetToolPermission(port, req)
                    break
            }
        })

        port.on('close', () => {
            this.agentPorts.delete(port)
            this.agentPortOwner.delete(port)
        })

        port.start()
    }

    /**
     * 主进程 cleanup 时显式注销该会话的 Agent 端口。
     * 唯一原因：主进程用 worker.terminate() 硬杀 Agent Worker，terminate 不执行 worker 内的
     * exit 逻辑，也不保证向对端派发 'close' → 仅靠 close 注销时 agentPorts 会随运行次数
     * 无界增长（port 及其监听闭包常驻 MCP Worker）。此路径不依赖对端 close 事件。
     */
    unregisterAgents(conversationId: string): void {
        for (const [port, owner] of this.agentPortOwner) {
            if (owner !== conversationId) continue
            this.agentPorts.delete(port)
            this.agentPortOwner.delete(port)
            try {
                port.close()
            } catch { /* 端口可能已关闭 */
            }
        }
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
            // 批次启动失败有意吞：由后续 refresh 通知补偿（P6 后 startServer 恒 resolve，
            // Promise.allSettled 已接管 rejection）。
            await Promise.allSettled(batch
                // ★ 二次检查：step 1 的 await 期间 restartServer 可能已将 server 加入 pendingRestarts
                // （TOCTOU 防护——filter 计算在 await 之前，pendingRestarts 变化在 await 期间）
                .filter(c => !this.pendingRestarts.has(c.id))
                .map(c => this.mcpClient.startServer(c))
            )
            if (i + UPDATE_BATCH_SIZE < toStart.length) {
                await new Promise(r => setTimeout(r, BATCH_DELAY_MS))
            }
        }
    }

    // ─── 消息处理 ──────────────────────────────────────

    private async handleCallTool(port: MessagePort, req: CallToolRequest): Promise<void> {
        const result = await this.mcpClient.callTool(req.serverId, req.toolName, req.args)

        port.postMessage({
            type: 'tool_result',
            callId: req.callId,
            result: {
                ...formatMcpResult(result),
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
                // ★ 用 getEffectiveTools（已过滤 denyList）：agent worker 的 mcpClient 是
                //   MessagePort（无 denyList 视图），发现期 deny 过滤的唯一实现点就是这里，
                //   否则被用户明确 deny 的工具仍会被注册进 registry 并广告给模型。
                tools: this.mcpClient.getEffectiveTools(s.config.id).map(toToolPayload),
                userDescription: s.config.userDescription,
            }))

        port.postMessage({type: 'all_result', servers})
    }

    /**
     * 权限查询：按 (serverId, MCP 侧原始工具名) 返回 denyList / autoApprove 判定结果。
     * config 变更（用户开关工具/调整自动批准）实时生效，不做缓存。
     */
    private handleGetToolPermission(port: MessagePort, req: GetToolPermissionRequest): void {
        port.postMessage({
            type: 'tool_permission_result',
            callId: req.callId,
            denied: this.mcpClient.isToolDenied(req.serverId, req.toolName),
            autoApproved: this.mcpClient.isToolAutoApproved(req.serverId, req.toolName),
        })
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
                const r = await this.mcpClient.startServer(cfg)
                parentPort?.postMessage({
                    type: 'restart_complete', serverId, success: r.success,
                    ...(r.error ? {error: r.error} : {}),
                })
            } else {
                parentPort?.postMessage({type: 'restart_complete', serverId, success: false, error: '配置丢失'})
            }
        } catch (err: any) {
            // 防御性兜底：P6 后 startServer 不抛（恒 resolve），此处覆盖配置读取等非连接异常
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
            // 用 getEffectiveTools 剔除 denyList 工具：Agent Worker 内只有 MessagePort，
            // 无 denyList 视图；发现期 deny 过滤的唯一实现点就是这里，
            // 若此处下发未过滤列表，被 deny 的工具会被重新注册进 registry 并出现在能力目录。
            tools: this.mcpClient.getEffectiveTools(serverId).map(toToolPayload),
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
            if (msg.port) service.registerAgent(msg.port, msg.conversationId)
            break

        // 主进程 cleanup 显式注销（不依赖对端 close 事件）
        case 'unregister_agent':
            if (msg.conversationId) service.unregisterAgents(msg.conversationId)
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
