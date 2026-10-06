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
import {MCP_WORKER_RESOURCE_LIMITS} from '../../workerLimits'
import {isProcessRunning} from './transport/processUtils'

/** 保存 agentManager 引用（延迟设置，避免循环依赖） */
let agentManagerRef: { workers: Map<string, { worker: Worker }> } | null = null

export function setAgentManagerRef(ref: typeof agentManagerRef): void {
    agentManagerRef = ref
}

export class MCPWorkerManager {
    private worker: Worker | null = null
    /**
     * 当前 Worker 的 'exit' handler 引用（spawn() 里闭包捕获实例后保存）。
     * Node 的 'exit' 事件只传 exitCode、不带实例，故闭包是「把退出者实例带进 handler」的唯一途径；
     * 同时它也是 reclaimCurrentWorker() 精确 off 的稳定引用（内联箭头函数摘不掉）。
     */
    private workerExitHandler: ((code: number) => void) | null = null
    private restarting = false
    /**
     * 退出中标志：shutdown() 首行置位。
     * exit/error 处理器先判此标志直接 return，避免 terminate() 导致的非 0 退出
     * 触发 scheduleRestart()，在应用退出过程中复活 Worker 及其 MCP 子进程。
     */
    private shuttingDown = false
    /** 当前 MCP 配置缓存（用于重启时重新传递） */
    private currentConfigs: MCPServerConfig[] = []
    /** 等待 MCP Worker 就绪的 Promise */
    private readyPromise: Promise<void> = Promise.resolve()
    private readyResolve: (() => void) | null = null
    /** 已排期的崩溃重启定时器句柄（提为字段以便 shutdown 时取消） */
    private restartTimer: ReturnType<typeof setTimeout> | null = null

    /**
     * 等待 restartServer 结果的 Promise 映射: serverId → { resolve, timer }
     * 由 IPC handler 设置，Worker 的 restart_complete 消息触发
     */
    private restartWaiters: Map<string, {
        resolve: (result: { success: boolean; error?: string; merged?: boolean }) => void
        timer: ReturnType<typeof setTimeout>
    }> = new Map()

    /** 定时清理间隔（毫秒） */
    private cleanupTimer: ReturnType<typeof setInterval> | null = null

    /**
     * process 'exit' 处理器是否已注册。
     * init() 可被重复调用（热重载 / 重复初始化路径），而 process.on 不做去重 →
     * 监听器随调用次数累积、退出一遍重复 killAllTrackedPids。故只注册一次。
     */
    private exitHandlerRegistered = false

    /**
     * 追踪所有 MCP 子进程 PID（serverId → pid 集合）
     * 在 Worker 外部维护，确保 Worker 崩溃后仍能清理对应子进程。
     * 用集合而非单值：同一 serverId 在异常路径上可能短暂存在多个子进程（重复启动的残留），
     * 单值会被后者覆盖，导致 killAllTrackedPids 只能清掉最后一个、其余永久失控。
     */
    private trackedPids: Map<string, Set<number>> = new Map()

    /**
     * 初始化 MCP Worker
     * 从 mcpService 和插件系统收集配置
     */
    async init(): Promise<void> {
        this.collectConfigs()
        this.spawn()

        // 每 10 分钟清理一次已停止超过 5 分钟的僵尸服务器进程
        // init() 可被重复调用（热重载/重复初始化），不先 clear 会漏掉旧定时器造成泄漏
        if (this.cleanupTimer) clearInterval(this.cleanupTimer)
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
        if (this.exitHandlerRegistered) return   // 幂等：避免重复 init 累积监听器
        this.exitHandlerRegistered = true
        process.on('exit', () => this.killAllTrackedPids())
    }

    /**
     * 同步杀死所有追踪的 PID（适用于 process.on('exit') 等同步场景）
     */
    private killAllTrackedPids(): void {
        for (const [, pids] of this.trackedPids) {
            for (const pid of pids) {
                try {
                    execSync(`taskkill /F /T /PID ${pid} 2>nul`, {timeout: 2000, windowsHide: true})
                } catch {
                    // 进程可能已退出，忽略
                }
            }
        }
        this.trackedPids.clear()
    }

    /**
     * 更新追踪的 PID。
     * ⚠️ pid 为 null 只表示"该 server 当前没有活跃子进程"，不能清空整组记录：
     *    每次重连都会经过 stopped/disconnected 上报一次 null，若在此删除，同名下仍存活的
     *    残留 PID（正是要清理的对象）会永久失联。
     *    顺手剔除已退出 PID：集合只增不减会无界增长，且让 exit 清理被死 PID 拖慢。
     */
    private updateTrackedPid(serverId: string, pid: number | null): void {
        const pids = this.trackedPids.get(serverId) ?? new Set<number>()
        for (const p of pids) {
            if (!isProcessRunning(p)) pids.delete(p)
        }
        if (pid) pids.add(pid)
        if (pids.size > 0) this.trackedPids.set(serverId, pids)
        else this.trackedPids.delete(serverId)
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

    /** 回收当前 Worker：结算挂起的重启等待方 → 取消排期重启 → 清子进程 → 摘监听器 → 终止线程 */
    private reclaimCurrentWorker(): void {
        // ★ 必须结算 restartWaiters：Worker 被回收后不可能再回传 restart_complete，
        //   否则点过"重连"的调用方会白等满 60s 超时才收到"重启超时"。
        for (const [serverId, waiter] of this.restartWaiters) {
            clearTimeout(waiter.timer)
            this.restartWaiters.delete(serverId)
            waiter.resolve({ success: false, error: 'MCP Worker 已回收' })
        }
        // ★ 取消已排期的崩溃重启（与 shutdown() 的既有段落对齐）：
        //   否则回收后 5 秒定时器仍会再 spawn 一次 —— spawn() 首行的 reclaim 虽能自愈、
        //   不泄漏线程，但会白建一个 Worker 并重复一整轮全量握手。
        if (this.restartTimer) {
            clearTimeout(this.restartTimer)
            this.restartTimer = null
        }
        // ★ restarting 必须无条件复位，不能嵌在 if (this.restartTimer) 内：
        //   若 scheduleRestart 的 timer 回调里 collectConfigs()/spawn() 抛错，
        //   回调末尾的复位不会执行，此时 timer 已为 null 但 restarting 仍为 true；
        //   之后新 Worker 崩溃时 onWorkerExit 的 `!this.restarting` 门恒为假
        //   → 永久不再自动重启（静默降级）。
        this.restarting = false
        const previous = this.worker
        if (!previous) return
        // terminate() 不会联动子进程，故先用同步 taskkill 清掉旧 Worker 的子进程
        this.killAllTrackedPids()
        // ★ 精确摘除监听器（不再用 removeAllListeners）：
        //   - message：旧 Worker 残留的 status_batch / pid_info 会打进新实例的状态缓存
        //   - exit：terminate 引发的非 0 退出会走 'exit' 分支触发 scheduleRestart，
        //     在本次 spawn 之后 5 秒又生成一个新 Worker
        //   ⚠️ 只有「具名稳定引用」才能精确 off，故 spawn() 里的 handler 全部改为类字段
        //      （内联箭头函数摘不掉，只能 removeAllListeners，那会连 error 兜底一并摘掉）。
        previous.off('message', this.onWorkerMessage)
        // ★ 闭包捕获实例的 handler 才是精确摘除所需的那一个；此前的裸 onWorkerExit 只是
        //   兼容「非 spawn 注入实例」的兜底（如测试直接挂裸引用），二者都要摘。
        previous.off('exit', this.workerExitHandler ?? this.onWorkerExit)
        this.workerExitHandler = null
        // ★ error 必须保留兜底监听：terminate() 是异步的，摘监听器到线程真正结束之间存在
        //   窗口，此刻旧 Worker 若 emit('error')，无监听器的 EventEmitter 会直接 throw
        //   未捕获异常。摘掉具名的 onWorkerError（不再触碰新实例状态）后重挂一个空兜底。
        previous.off('error', this.onWorkerError)
        previous.on('error', () => { /* 终止窗口内的兜底：只为避免无监听器时 emit('error') throw */ })
        void previous.terminate().catch((err: unknown) => {
            logger.warn('[MCPWorkerManager] 终止旧 MCP Worker 失败', {error: String(err)})
        })
        this.worker = null
    }

    /** 创建并启动 MCP Worker 线程 */
    private spawn(): void {
        // ★ 重复 spawn 防护：旧 Worker 若仍存活必须先回收，否则它连同其 MCP 子进程会
        //   永久脱离管理视野（旧 Worker 的 status_batch / pid_info 已无人处理，
        //   其子进程也不在 trackedPids 中）——这是残留进程清不掉的机制之一。
        this.reclaimCurrentWorker()

        // 覆盖 this.readyPromise 前先 settle 旧的那一个：
        // 否则上一轮从未 ready 就被替换的 promise 会永久悬挂，调用方闭包与实例无法释放
        this.readyResolve?.()

        this.readyPromise = new Promise((resolve) => {
            this.readyResolve = resolve
        })

        const workerPath = path.join(__dirname, 'mcpWorker.js')
        // ★ 内存加固（评审建议 4）：MCP Worker 只做协调（真正的 server 是独立子进程），
        //   显式 256/16 上限即可，见 ../../workerLimits.ts。
        const worker = new Worker(workerPath, {
            type: 'module' as const,
            workerData: {servers: this.currentConfigs},
            resourceLimits: MCP_WORKER_RESOURCE_LIMITS,
        } as any)
        this.worker = worker

        // ★ 闭包捕获实例：Node 的 'exit' 只传 exitCode，不传实例；闭包把退出者带进 handler，
        //   使 onWorkerExit 的「仅当退出者正是当前实例」判定在生产路径真正生效，
        //   同时把 handler 引用存为类字段，供 reclaimCurrentWorker() 精确 off（内联箭头摘不掉）。
        //   ⚠️ 若存在「spawn 新实例但未先 reclaim 旧实例」的路径，本字段会被新闭包覆盖 →
        //      旧实例的 off 失效；此时新判定正好兜住（旧实例退出时因 !== this.worker 被忽略）。
        const exitHandler = (code: number) => this.onWorkerExit(code, worker)
        this.workerExitHandler = exitHandler

        worker.on('message', this.onWorkerMessage)
        worker.on('error', this.onWorkerError)
        worker.on('exit', exitHandler)
    }

    /**
     * Worker 消息分发。
     * ⚠️ 必须是具名稳定引用（类字段箭头函数）：reclaimCurrentWorker() 要按引用精确摘除，
     *    内联箭头函数无法 off（只能 removeAllListeners，会把 error 兜底一起摘掉）。
     */
    private readonly onWorkerMessage = (msg: any): void => {
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
                // 与 worker_log 同理：这是 Worker 异常的唯一上报通道，
                // 收了就丢会让 update_servers（fire-and-forget）等路径的抛错彻底不可见
                logger.error('[MCP Worker] 内部错误:', msg.error ?? 'unknown')
                break

            case 'worker_log': {
                // Worker 跑在独立线程，其日志不会进入主进程 logger；
                // 缺此桥接时「MCP 启动失败 / 重复子进程」等问题在日志里完全不可见（诊断缺口）。
                // 安全序列化：args 里可能带对象/Error，直接 join 会得到 "[object Object]"
                const text = `[MCP Worker] ${Array.isArray(msg.args) ? msg.args.map((a: unknown) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') : ''}`
                switch (msg.level) {
                    case 'error':
                        logger.error(text)
                        break
                    case 'warn':
                        logger.warn(text)
                        break
                    case 'info':
                        logger.info(text)
                        break
                    default:
                        // 未知 level 兜底 debug：宁可降低噪声级别，也不丢日志
                        logger.debug(text)
                        break
                }
                break
            }

            case 'restart_complete':
                // Worker 中 restartServer 完成 → 通知等待中的 IPC handler
                this.handleRestartComplete(msg.serverId, msg.success, msg.error, msg.merged)
                break

        }
    }

    /**
     * Worker 启动期崩溃（error 可能先于 exit 到达）：settle readyPromise，
     * 否则任何 await waitForReady() 会永久挂起
     * （重启/退出决策统一由 onWorkerExit 按 shuttingDown 判定）
     */
    private readonly onWorkerError = (_err: Error): void => {
        this.readyResolve?.()
    }

    /**
     * Worker 退出：解除当前实例引用 + settle readyPromise + 非正常情况下按需排期重启
     *
     * @param worker 退出者实例。spawn() 用**闭包捕获实例**的 handler 注册
     *   （`(code) => this.onWorkerExit(code, worker)`），因为 Node 的 'exit' 事件只传 exitCode、
     *   不传实例；不传实例时（如测试直接挂裸引用）以 `this.worker` 为准。
     *   显式传入时用于「仅当退出的正是当前实例」判定，避免旧实例误清新实例引用。
     */
    private readonly onWorkerExit = (code: number, worker?: Worker): void => {
        // 退出者已不是当前实例 → 不得产生任何副作用（不 settle ready、不排期重启、不清新引用）。
        // 生产路径下旧实例的 exit 监听器已被 reclaimCurrentWorker() 按保存的闭包引用精确摘除，
        // 本判定是纵深防御：兜住「监听器摘除失效」（如 workerExitHandler 字段被新实例覆盖，
        // 旧实例的 off 落空）时旧实例退出误清新实例引用的场景。
        if (worker !== undefined && worker !== this.worker) return

        // 任何退出路径都 settle readyPromise（worker_ready 之前崩溃时唤醒等待方）
        this.readyResolve?.()

        // shutdown() 中的 terminate() 会以非 0 码退出；此时绝不能再排期重启
        // （this.worker 的置 null 仍由 shutdown() 自己负责，语义不变）
        if (this.shuttingDown) return

        // ★ 退出即解除 this.worker 引用：
        //   崩溃后的 5s 重启窗口内若 this.worker 仍指向已死实例，restartServer() 会走
        //   「worker 非空」分支 —— postMessage 静默 no-op，waiter 却照常登记，调用方
        //   白等满 60s 才收到「重启超时」；任何依赖 this.worker 非空的判断也都会误判。
        //   防护来源：① reclaimCurrentWorker() 按保存的闭包引用精确摘除旧实例监听器（主防线）；
        //   ② 方法首行的实例判定（纵深防御，兜住摘除失效 / 字段被覆盖等异常路径）。
        this.worker = null

        if (code !== 0 && !this.restarting) {
            // Worker 崩溃时，先清理其遗留的子进程，再重启
            this.killAllTrackedPids()
            this.scheduleRestart()
        }
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

        // 句柄存入实例字段，便于 shutdown() 取消（内联 setTimeout 无法取消）
        this.restartTimer = setTimeout(() => {
            this.restartTimer = null
            this.collectConfigs() // 重新收集最新配置
            this.spawn()
            this.restarting = false
        }, 5000)
    }

    /**
     * 为 Agent Worker 创建 MessagePort
     * 返回 agentPort，主进程通过 worker.postMessage({ type: 'mcp_port', port: agentPort }, [agentPort]) 发送给 Agent Worker
     */
    createAgentPort(conversationId?: string): { agentPort: import('worker_threads').MessagePort } {
        const {port1, port2} = new MessageChannel()

        // port1 → MCP Worker（带 conversationId，供主进程 cleanup 时显式注销）
        if (this.worker) {
            this.worker.postMessage({type: 'register_agent', port: port1, conversationId}, [port1])
        }

        // port2 → Agent Worker（由调用者发送）
        return {agentPort: port2}
    }

    /**
     * 通知 MCP Worker 注销某会话的 Agent 端口。
     * 主进程用 worker.terminate() 硬杀 Agent Worker（abort 超时 / cleanup 回收），terminate
     * 不执行 worker 内 exit 逻辑、也不保证向对端派发 'close' → MCP Worker 侧 agentPorts
     * 会随运行次数无界增长。故由本方法在 cleanup 路径显式下发注销消息。
     */
    unregisterAgent(conversationId: string): void {
        if (!this.worker) return
        try {
            this.worker.postMessage({type: 'unregister_agent', conversationId})
        } catch { /* MCP Worker 可能已退出 */ }
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
    restartServer(serverId: string): Promise<{ success: boolean; error?: string }> {
        const latest = mcpService.get(serverId)
        if (!latest) {
            logger.warn('[MCPWorkerManager] restartServer: 找不到服务器', {serverId})
            return Promise.resolve({ success: false, error: '服务器不存在' })
        }
        // ★ Worker 未就绪（崩溃重启窗口 / 尚未 init）时必须立即失败：
        //   postMessage 会静默 no-op，但下面仍会登记 waiter → 调用方白等满 60s 才拿到
        //   "重启超时"，且期间 worker 永远不可能回传 restart_complete。
        if (!this.worker) {
            logger.warn('[MCPWorkerManager] restartServer: MCP Worker 未就绪', {serverId})
            return Promise.resolve({ success: false, error: 'MCP Worker 未就绪' })
        }
        this.worker.postMessage({
            type: 'restart_server',
            serverId,
            config: this.mapToConfig(latest),
        })

        // 返回 Promise，等待 Worker 回传 restart_complete
        return new Promise((resolve) => {
            // 同 serverId 覆盖：先结算旧 waiter（语义"已被新请求覆盖"）——旧 Promise 不
            // 结算即永挂起（调用方 await 卡死），旧 timer 也会在超时时误删新 entry。
            // 先 delete 再 resolve：resolve 回调若同步重入登记同键，不会被误删。
            const prev = this.restartWaiters.get(serverId)
            if (prev) {
                clearTimeout(prev.timer)
                this.restartWaiters.delete(serverId)
                prev.resolve({ success: false, error: '请求已被覆盖' })
            }

            const timer = setTimeout(() => {
                this.restartWaiters.delete(serverId)
                logger.warn('[MCPWorkerManager] restartServer 超时', {serverId})
                resolve({ success: false, error: '重启超时' })
            }, 60_000) // 60 秒超时

            this.restartWaiters.set(serverId, { resolve, timer })
        })
    }

    /** 处理 Worker 回传的 restart_complete 消息 */
    private handleRestartComplete(serverId: string, success: boolean, error?: string, _merged?: boolean): void {
        const waiter = this.restartWaiters.get(serverId)
        if (waiter) {
            clearTimeout(waiter.timer)
            this.restartWaiters.delete(serverId)
            waiter.resolve({ success, error })
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
        // 首行置位：之后的 exit/error（含下面 terminate 触发的非 0 退出）不再排期重启
        this.shuttingDown = true

        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer)
            this.cleanupTimer = null
        }

        // 取消已排期的崩溃重启，否则 5s 后会在退出过程中重新 spawn Worker 与其 MCP 子进程
        if (this.restartTimer) {
            clearTimeout(this.restartTimer)
            this.restartTimer = null
            this.restarting = false
        }

        // 结算所有挂起的 restartServer 等待方：关闭期间不让调用方等满 60s 超时
        // 先 delete 再 resolve（与 restartServer 覆盖逻辑一致，防止 resolve 回调同 tick 重入误删）
        for (const [serverId, waiter] of this.restartWaiters) {
            clearTimeout(waiter.timer)
            this.restartWaiters.delete(serverId)
            waiter.resolve({ success: false, error: '已关闭' })
        }

        if (this.worker) {
            // 通知 Worker 优雅断开所有 MCP 服务器连接（释放子进程）
            this.worker.postMessage({type: 'shutdown'})

            // 等待 Worker 退出，超时 5 秒后强制终止
            const worker = this.worker
            await new Promise<void>((resolve) => {
                const exitTimer = setTimeout(() => {
                    // 与 reclaimCurrentWorker() 对齐：terminate() 是异步的，其 rejection
                    // （Worker 已退出等）不得冒泡为未处理的 Promise 拒绝
                    void worker.terminate().catch((err: unknown) => {
                        logger.warn('[MCPWorkerManager] 强制终止 MCP Worker 失败', {error: String(err)})
                    })
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
