/**
 * MCPWorkerManager — 主进程 MCP Worker 生命周期管理
 *
 * Phase 2: 管理 MCP Worker 的创建、重启、MessagePort 分发。
 * 主进程不再持有 mcpClient，所有 MCP 通信由 MCP Worker 处理。
 *
 * 职责:
 * 1. app.ready 中 powerManager.initialize() 后初始化
 * 2. 收集 MCP 配置 → 通过 workerData 传给 MCP Worker
 * 3. 创建/重启 MCP Worker
 * 4. Agent Worker 请求 mcp_port 时创建 MessageChannel
 * 5. 转发 status_batch 到 mcpService（mcpService.onEvent → mcp:status-changed 推送到渲染进程）
 * 6. MCP Worker 崩溃时自动重启，通知 Agent Worker
 */

import {MessageChannel, Worker} from 'worker_threads'
import {execSync} from 'child_process'
import path from 'path'
import {mcpService} from '../../services/mcpService'
import type {MCPServerConfig} from './types'
import type {McpServer} from '../../../shared/types/mcp'
import {logger} from '../logger'

/** 保存 agentManager 引用（延迟设置，避免循环依赖） */
let agentManagerRef: { workers: Map<string, { worker: Worker }> } | null = null

export function setAgentManagerRef(ref: typeof agentManagerRef): void {
    agentManagerRef = ref
}

export class MCPWorkerManager {
    private worker: Worker | null = null
    private restarting = false
    /** 当前 MCP 配置缓存（用于重启时重新传递） */
    private currentConfigs: MCPServerConfig[] = []
    /** 等待 MCP Worker 就绪的 Promise */
    private readyPromise: Promise<void> = Promise.resolve()
    private readyResolve: (() => void) | null = null

    /**
     * 等待 restartServer 结果的 Promise 映射: serverId → { resolve, reject, timer }
     * 由 IPC handler 设置，Worker 的 restart_complete 消息触发
     */
    private restartWaiters: Map<string, {
        resolve: (result: { success: boolean; merged?: boolean }) => void
        reject: (err: Error) => void
        timer: ReturnType<typeof setTimeout>
    }> = new Map()

    /** 定时清理间隔（毫秒） */
    private cleanupTimer: ReturnType<typeof setInterval> | null = null

    /**
     * 追踪所有 MCP 子进程 PID（serverId → pid）
     * 在 Worker 外部维护，确保 Worker 崩溃后仍能清理对应子进程
     */
    private trackedPids: Map<string, number> = new Map()

    /**
     * 初始化 MCP Worker
     * 从 mcpService 和插件系统收集配置
     */
    async init(): Promise<void> {
        this.collectConfigs()
        this.spawn()

        // 每 10 分钟清理一次已停止超过 5 分钟的僵尸服务器进程
        this.cleanupTimer = setInterval(() => {
            this.worker?.postMessage({type: 'cleanup_stopped'})
        }, 10 * 60 * 1000)

        // 注册进程退出时的同步清理——确保应用退出时 MCP 子进程不被遗留
        this.registerExitHandler()
    }

    /**
     * 注册 Node.js 进程退出处理
     * 使用同步方式 kill 子进程，因为 process.on('exit') 不支持异步操作
     * 通过 process.on('exit') 注册确保任何退出路径都能被覆盖
     */
    private registerExitHandler(): void {
        process.on('exit', () => this.killAllTrackedPids())
    }

    /**
     * 同步杀死所有追踪的 PID（适用于 process.on('exit') 等同步场景）
     */
    private killAllTrackedPids(): void {
        for (const [serverId, pid] of this.trackedPids) {
            try {
                execSync(`taskkill /F /T /PID ${pid} 2>nul`, {timeout: 2000, windowsHide: true})
            } catch {
                // 进程可能已退出，忽略
            }
        }
        this.trackedPids.clear()
    }

    /** 更新追踪的 PID */
    private updateTrackedPid(serverId: string, pid: number | null): void {
        if (pid) {
            this.trackedPids.set(serverId, pid)
        } else {
            this.trackedPids.delete(serverId)
        }
    }

    /** 单个服务器 → 配置对象映射 */
    private mapToConfig(s: McpServer): MCPServerConfig {
        return {
            id: s.id,
            name: s.name,
            transport: s.transport as MCPServerConfig['transport'],
            command: s.command,
            args: s.args,
            env: s.env,
            url: s.url,
            headers: s.headers,
            cwd: s.cwd,
            timeout: s.timeout,
            autoApprove: s.autoApprove,
            denyList: s.denyList,
            enabled: s.enabled ?? true,
            userDescription: s.userDescription,
        }
    }

    /** 收集所有 MCP 配置（本地 + 插件） */
    private collectConfigs(): void {
        this.currentConfigs = mcpService.list().map(s => this.mapToConfig(s))
    }

    /** 创建并启动 MCP Worker 线程 */
    private spawn(): void {
        this.readyPromise = new Promise((resolve) => {
            this.readyResolve = resolve
        })

        const workerPath = path.join(__dirname, 'mcpWorker.js')
        this.worker = new Worker(workerPath, {
            type: 'module' as const,
            workerData: {servers: this.currentConfigs},
        } as any)

        this.worker.on('message', (msg: any) => {
            switch (msg.type) {
                case 'worker_ready':
                    this.readyResolve?.()
                    break

                case 'status_batch':
                    // 批量状态更新 → mcpService 缓存 + 转发渲染进程
                    this.handleStatusBatch(msg.updates)
                    break

                case 'pid_info':
                    // MCP 子进程 PID 追踪——Worker 崩溃后仍可清理
                    if (msg.serverId) {
                        this.updateTrackedPid(msg.serverId, msg.pid ?? null)
                    }
                    break

                case 'worker_error':
                    break

                case 'worker_log':
                    break

                case 'restart_complete':
                    // Worker 中 restartServer 完成 → 通知等待中的 IPC handler
                    this.handleRestartComplete(msg.serverId, msg.success, msg.error, msg.merged)
                    break

            }
        })

        this.worker.on('error', (_err: Error) => {
        })

        this.worker.on('exit', (code) => {
            if (code !== 0 && !this.restarting) {
                // Worker 崩溃时，先清理其遗留的子进程，再重启
                this.killAllTrackedPids()
                this.scheduleRestart()
            }
        })
    }

    /** 处理批量状态更新 */
    private handleStatusBatch(updates: Array<{
        serverId: string;
        status: string;
        error?: string;
        toolCount?: number;
        tools?: Array<{ name: string; description?: string; inputSchema: any }>
    }>): void {
        for (const u of updates) {
            // u.tools 有数据时覆盖缓存，无数据时保留现有缓存
            const tools = u.tools ?? mcpService.get(u.serverId)?.tools ?? []
            mcpService.updateStatus(u.serverId, u.status as any, u.error, tools)
        }
        // 状态转发由 mcpService.updateStatus() → mcpService.onEvent
        // → registerMCPEventForwarding → 'mcp:status-changed' 统一处理
    }

    /** MCP Worker 崩溃后 5 秒自动重启 */
    private scheduleRestart(): void {
        this.restarting = true

        // 通知所有 Agent Worker：MCP Worker 不可用
        this.broadcastToAgentWorkers({type: 'mcp_worker_unavailable'})

        setTimeout(() => {
            this.collectConfigs() // 重新收集最新配置
            this.spawn()
            this.restarting = false
        }, 5000)
    }

    /**
     * 为 Agent Worker 创建 MessagePort
     * 返回 agentPort，主进程通过 worker.postMessage({ type: 'mcp_port', port: agentPort }, [agentPort]) 发送给 Agent Worker
     */
    createAgentPort(): { agentPort: import('worker_threads').MessagePort } {
        const {port1, port2} = new MessageChannel()

        // port1 → MCP Worker
        if (this.worker) {
            this.worker.postMessage({type: 'register_agent', port: port1}, [port1])
        }

        // port2 → Agent Worker（由调用者发送）
        return {agentPort: port2}
    }

    /**
     * 从 mcpService 缓存读取所有配置并同步到 Worker
     * 所有 MCP 操作（增/删/改/启/停）最终都应调用此方法，
     * 由 Worker 统一管理进程生命周期，避免主进程和 Worker 各自 spawn 子进程
     */
    syncConfigs(): void {
        this.updateConfigs(mcpService.list().map(s => this.mapToConfig(s)))
    }

    /**
     * 重启单个 MCP Server（停→启，不触发全量 diff）
     * 由刷新按钮调用，避免误重连所有已断开的服务
     *
     * 从 mcpService 读取最新配置（而非 Worker 内存中的缓存），
     * 确保 transport 等字段与 mcp.json 一致
     *
     * @returns Promise，在 Worker 完成重启后 resolve（超时 60s 拒绝）
     */
    restartServer(serverId: string): Promise<{ success: boolean }> {
        const latest = mcpService.get(serverId)
        if (!latest) {
            logger.warn('[MCPWorkerManager] restartServer: 找不到服务器', {serverId})
            return Promise.resolve({ success: false })
        }
        this.worker?.postMessage({
            type: 'restart_server',
            serverId,
            config: this.mapToConfig(latest),
        })

        // 返回 Promise，等待 Worker 回传 restart_complete
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.restartWaiters.delete(serverId)
                logger.warn('[MCPWorkerManager] restartServer 超时', {serverId})
                resolve({ success: false })
            }, 60_000) // 60 秒超时

            this.restartWaiters.set(serverId, { resolve, reject: () => {}, timer })
        })
    }

    /** 处理 Worker 回传的 restart_complete 消息 */
    private handleRestartComplete(serverId: string, success: boolean, _error?: string, merged?: boolean): void {
        const waiter = this.restartWaiters.get(serverId)
        if (waiter) {
            clearTimeout(waiter.timer)
            this.restartWaiters.delete(serverId)
            waiter.resolve({ success })
        }
        // merged=true 表示此请求被合并到已有的重启中，无需额外操作
    }

    /**
     * 全量替换 MCP 配置（直接接收配置数组）
     * 在用户增删改 MCP Server 时调用
     */
    updateConfigs(configs: MCPServerConfig[]): void {
        this.currentConfigs = configs
        this.worker?.postMessage({type: 'update_servers', servers: configs})
    }

    /** 等待 MCP Worker 就绪 */
    waitForReady(): Promise<void> {
        return this.readyPromise
    }

    /** 广播消息到所有 Agent Worker */
    private broadcastToAgentWorkers(msg: any): void {
        if (!agentManagerRef) return
        for (const [, entry] of agentManagerRef.workers) {
            try {
                entry.worker.postMessage(msg)
            } catch { /* Worker 可能已关闭 */
            }
        }
    }

    /** 关闭 MCP Worker + 停止定时清理 */
    async shutdown(): Promise<void> {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer)
            this.cleanupTimer = null
        }

        if (this.worker) {
            // 通知 Worker 优雅断开所有 MCP 服务器连接（释放子进程）
            this.worker.postMessage({type: 'shutdown'})

            // 等待 Worker 退出，超时 5 秒后强制终止
            const worker = this.worker
            await new Promise<void>((resolve) => {
                const exitTimer = setTimeout(() => {
                    worker.terminate()
                    resolve()
                }, 5000)
                worker.once('exit', () => {
                    clearTimeout(exitTimer)
                    resolve()
                })
            })
            this.worker = null
        }

        // 杀死所有未被 Worker 清理的残留子进程（安全兜底）
        this.killAllTrackedPids()
    }

    /**
     * 同步强制杀死所有追踪的子进程（供外部同步场景使用）
     */
    forceKillAllPids(): void {
        this.killAllTrackedPids()
    }
}

/** 全局单例 */
export const mcpWorkerManager = new MCPWorkerManager()
