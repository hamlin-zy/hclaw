/**
 * Sub-Agent 调度器
 *
 * 管理子 Agent 的创建、并发控制和结果收集。
 * 支持可配置的并发数和优先级队列。
 *
 * 设计：
 * - 可配置的最大并发数（默认 3，从 SystemSettings 读取）
 * - 可选的优先级队列（priorityEnabled）
 * - 每个子 Agent 独立运行 agentLoop，限制可用工具
 * - 通过 AsyncGenerator 向主 Agent 推送事件
 * - 超时保护（可配置，默认 15 分钟）
 */

import crypto from 'crypto'
import {agentLoop} from '../loop'
import {logger} from '../logger'
import {runtimeConfigManager} from '../runtimeConfigManager'
import type {AgentStreamEvent} from '../stream'
import type {ChatMessage} from '../model/types'
import type {SubAgentEvent, SubAgentResult, SubAgentStartParams, SubAgentStatus, SubAgentTask,} from './types'

// ─── 常量与默认值 ─────────────────────────────────────────────

const DEFAULT_MAX_CONCURRENCY = 3
const DEFAULT_TIMEOUT = 15 * 60 * 1000 // 15 分钟

/** 低优先级任务饥饿保护：等待超过此毫秒数即提升优先级 */
const AGING_THRESHOLD_MS = 30_000

// ─── 监控指标 ─────────────────────────────────────────────────

export interface TaskMetricsEntry {
    taskId: string
    description: string
    success: boolean
    durationMs: number
    error?: string
    startedAt: number
    completedAt: number
}

// ─── 优先级队列 ───────────────────────────────────────────────

interface QueuedTask {
    id: string
    task: SubAgentTask
    params: Omit<SubAgentStartParams, 'task'>
    priority: number
    enqueuedAt: number
    resolve: (value: AsyncGenerator<SubAgentEvent>) => void
    reject: (reason: any) => void
}

/**
 * 优先级队列
 * - 高优先级任务排在前面
 * - 同优先级按入队时间 FIFO
 * - 带饥饿保护：等待超过 AGING_THRESHOLD_MS 的任务会提升优先级
 */
class PriorityQueue {
    private queue: QueuedTask[] = []

    enqueue(
        task: SubAgentTask,
        params: Omit<SubAgentStartParams, 'task'>,
        priority: number,
    ): Promise<AsyncGenerator<SubAgentEvent>> {
        return new Promise((resolve, reject) => {
            const entry: QueuedTask = {
                id: crypto.randomUUID(),
                task,
                params,
                priority,
                enqueuedAt: Date.now(),
                resolve,
                reject,
            }

            // 按优先级排序，高优先级在前；同优先级 FIFO
            const index = this.queue.findIndex(q => q.priority < priority)
            if (index === -1) {
                this.queue.push(entry)
            } else {
                this.queue.splice(index, 0, entry)
            }
        })
    }

    /**
     * 出队，带饥饿保护：
     * 1. 检查是否有等待超过 AGING_THRESHOLD_MS 的任务（从尾部开始，低优先级优先）
     * 2. 如果有，将其提升到队首出队
     * 3. 否则正常取队首（最高优先级）
     */
    dequeue(): QueuedTask | undefined {
        if (this.queue.length === 0) return undefined

        const now = Date.now()
        // 从尾部（最低优先级）向前扫描，优先提升等待最久且优先级最低的
        for (let i = this.queue.length - 1; i >= 0; i--) {
            if (now - this.queue[i].enqueuedAt >= AGING_THRESHOLD_MS) {
                // 找到饥饿任务，提升出队
                return this.queue.splice(i, 1)[0]
            }
        }

        return this.queue.shift()
    }

    peek(): QueuedTask | undefined {
        return this.queue[0]
    }

    get size(): number {
        return this.queue.length
    }

    isEmpty(): boolean {
        return this.queue.length === 0
    }

    removeByTaskId(taskId: string): boolean {
        const index = this.queue.findIndex(q => q.task.id === taskId)
        if (index !== -1) {
            this.queue.splice(index, 1)
            return true
        }
        return false
    }

    clear(): void {
        this.queue = []
    }
}

// ─── SubAgentScheduler ────────────────────────────────────────

export class SubAgentScheduler {
    private activeAgents: Map<string, AbortController> = new Map()

    // 优先级队列
    private priorityQueue = new PriorityQueue()
    private isProcessingQueue = false

    // 监控指标
    private metrics: Map<string, TaskMetricsEntry> = new Map()
    private metricsRetentionCount = 200

    /**
     * 获取当前配置
     */
    private getConfig(): { maxConcurrency: number; defaultTimeout: number; retryAttempts: number; priorityEnabled: boolean } {
        const settings = runtimeConfigManager.getSettings()
        const subagent = settings?.subagent

        return {
            maxConcurrency: subagent?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
            defaultTimeout: subagent?.defaultTimeout ?? DEFAULT_TIMEOUT,
            retryAttempts: subagent?.retryAttempts ?? 0,
            priorityEnabled: subagent?.priorityEnabled ?? false,
        }
    }

    /** 当前活跃数量 */
    get activeCount(): number {
        return this.activeAgents.size
    }

    /** 是否有空位 */
    get hasCapacity(): boolean {
        const {maxConcurrency} = this.getConfig()
        return this.activeAgents.size < maxConcurrency
    }

    /** 获取最大并发数（用于 UI 显示） */
    get maxConcurrency(): number {
        return this.getConfig().maxConcurrency
    }

    /** 获取监控指标快照 */
    getMetrics(): TaskMetricsEntry[] {
        return Array.from(this.metrics.values())
    }

    /** 获取最近 N 条监控指标 */
    getRecentMetrics(count: number = 50): TaskMetricsEntry[] {
        const entries = Array.from(this.metrics.values())
        return entries.slice(-count)
    }

    /** 获取监控统计摘要 */
    getMetricsSummary(): { total: number; success: number; failed: number; avgDurationMs: number } {
        const entries = Array.from(this.metrics.values())
        const total = entries.length
        if (total === 0) return { total: 0, success: 0, failed: 0, avgDurationMs: 0 }
        const success = entries.filter(e => e.success).length
        const failed = total - success
        const avgDurationMs = Math.round(entries.reduce((sum, e) => sum + e.durationMs, 0) / total)
        return { total, success, failed, avgDurationMs }
    }

    /** 获取所有活跃任务状态 */
    getStatuses(): SubAgentStatus[] {
        return Array.from(this.activeAgents.entries()).map(([taskId]) => ({
            taskId,
            state: 'running' as const,
        }))
    }

    /** 中止指定子 Agent */
    abort(taskId: string): void {
        const ac = this.activeAgents.get(taskId)
        if (ac) {
            logger.info(`[SubAgentScheduler] Aborting task ${taskId}`)
            ac.abort()
            this.activeAgents.delete(taskId)
        }
        // 从优先级队列中移除
        this.priorityQueue.removeByTaskId(taskId)
    }

    /** 中止所有子 Agent */
    abortAll(): void {
        logger.info(`[SubAgentScheduler] Aborting all ${this.activeAgents.size} active agents`)
        for (const [, ac] of this.activeAgents.entries()) {
            ac.abort()
        }
        this.activeAgents.clear()
        this.priorityQueue.clear()
    }

    /**
     * 添加入优先级队列
     */
    private enqueueTask(
        task: SubAgentTask,
        params: Omit<SubAgentStartParams, 'task'>,
        priority: number,
    ): Promise<AsyncGenerator<SubAgentEvent>> {
        const promise = this.priorityQueue.enqueue(task, params, priority)
        logger.info(`[SubAgentScheduler] Task ${task.id} added to queue with priority ${priority}, queue size: ${this.priorityQueue.size}`)
        this.processQueue()
        return promise
    }

    /**
     * 处理优先级队列
     * 注意：必须跟踪本地 dispatched 计数，因为 executeTaskInternal 是 async generator，
     * 它在被消费方才启动 body（activeAgents.set），而 promise resolve 触发的 consumer
     * 恢复是微任务，在当前同步循环结束后才执行。如果不计数，循环会看到 capacity 一直
     * 不变而过度分发任务，导致实际并发超过 maxConcurrency。
     */
    private processQueue(): void {
        if (this.isProcessingQueue) return
        this.isProcessingQueue = true

        const {maxConcurrency} = this.getConfig()

        try {
            // dispatched: 本轮已分发但 generator body 尚未启动的任务数
            let dispatched = 0
            while (!this.priorityQueue.isEmpty()) {
                if (this.activeAgents.size + dispatched >= maxConcurrency) break

                const item = this.priorityQueue.dequeue()
                if (!item) break

                dispatched++

                try {
                    const generator = this.executeTaskInternal({
                        task: item.task,
                        ...item.params,
                    })
                    item.resolve(generator)
                } catch (err) {
                    dispatched--
                    item.reject(err)
                }
            }
        } finally {
            this.isProcessingQueue = false
        }
    }

    /**
     * 记录任务指标
     */
    private recordMetrics(
        taskId: string,
        description: string,
        success: boolean,
        durationMs: number,
        error?: string,
    ): void {
        const entry: TaskMetricsEntry = {
            taskId,
            description,
            success,
            durationMs,
            error,
            startedAt: Date.now() - durationMs,
            completedAt: Date.now(),
        }
        this.metrics.set(taskId, entry)

        // 限制内存占用：超出保留数量时清理最旧的
        if (this.metrics.size > this.metricsRetentionCount) {
            const keys = Array.from(this.metrics.keys())
            const toRemove = keys.slice(0, this.metrics.size - this.metricsRetentionCount)
            for (const key of toRemove) {
                this.metrics.delete(key)
            }
        }
    }

    /**
     * 执行单个任务（核心逻辑）
     */
    private async *executeTaskInternal(params: SubAgentStartParams): AsyncGenerator<SubAgentEvent> {
        const {task, modelConfig, workingDir, abortSignal, agentType, agentDefinition, settings} = params

        const ac = new AbortController()
        this.activeAgents.set(task.id, ac)

        const startedAt = Date.now()

        // 设置超时保护：优先使用任务指定的超时，否则使用默认值 10 分钟
        // 防止钩子异常、LLM 卡死等情况导致子 Agent 无限等待
        const effectiveTimeout = task.timeout ?? 10 * 60 * 1000
        let timeoutTimer: NodeJS.Timeout | undefined
        timeoutTimer = setTimeout(() => {
            logger.warn(`[SubAgentScheduler] Task ${task.id} timed out after ${effectiveTimeout}ms (${task.timeout != null ? 'task-specified' : 'default'})`)
            ac.abort()
        }, effectiveTimeout)

        yield {type: 'subagent_start', taskId: task.id, description: task.description}

        // 触发 SubagentStart Hook
        import('../../plugin/hooks').then(({hookExecutor}) => {
            hookExecutor.execute('SubagentStart', {
                sessionId: '',
                taskId: task.id,
                taskName: task.description?.slice(0, 80),
            }).catch(() => {})
        }).catch(() => {})

        // 构建子 Agent 消息
        const messages: ChatMessage[] = [
            {
                role: 'user',
                content: task.description + (task.context ? `\n\n---\n附加上下文:\n${task.context}` : ''),
            },
        ]

        let output = ''
        let hasError = false
        let errorMsg = ''

        try {
            const subAbortSignal = abortSignal
                ? AbortSignal.any([ac.signal, abortSignal])
                : ac.signal

            // maxTurns 配置优先级：用户配置 > agent定义 > 默认值
            // - 用户配置 (settings.agent.maxTurns) 具有最高优先级
            // - agent定义 (agentDefinition.maxTurns) 作为备选
            // - 默认值 50 作为兜底
            const maxTurnsLimit = settings?.agent?.maxTurns ?? agentDefinition?.maxTurns ?? 500
            
            for await (const event of agentLoop({
                messages,
                modelConfig,
                workingDir,
                maxTurns: maxTurnsLimit,
                abortSignal: subAbortSignal,
                agentType: agentType || task.agentType || 'General',
                agentDefinition,
                settings,
                conversationTitle: `Sub Agent: ${task.description.slice(0, 50)}`,
            })) {
                if (event.type === 'intent_analyzed' || event.type === 'mode_change') {
                    continue
                }

                yield {type: 'subagent_progress', taskId: task.id, event: event as AgentStreamEvent}

                if (event.type === 'text') {
                    output += event.content || ''
                }
                if (event.type === 'error') {
                    hasError = true
                    errorMsg = event.error || ''
                }
                if (event.type === 'done') {
                    break
                }
            }
        } catch (err: any) {
            // 检查是否是超时错误
            if (err.name === 'AbortError' || err.message?.includes('abort')) {
                const timeoutVal = task.timeout ? `${task.timeout}ms` : '无超时限制'
                errorMsg = `任务中止（${timeoutVal}）`
            } else {
                errorMsg = err.message
            }
            hasError = true
        } finally {
            if (timeoutTimer) clearTimeout(timeoutTimer)
            this.activeAgents.delete(task.id)

            // 记录监控指标
            const duration = Date.now() - startedAt
            this.recordMetrics(task.id, task.description, !hasError, duration, hasError ? errorMsg : undefined)

            // 处理队列中的下一个任务
            this.processQueue()
        }

        const result: SubAgentResult = {
            taskId: task.id,
            success: !hasError,
            output: output.trim(),
            error: hasError ? errorMsg : undefined,
        }

        // 触发 SubagentStop Hook
        import('../../plugin/hooks').then(({hookExecutor}) => {
            hookExecutor.execute('SubagentStop', {
                sessionId: '',
                taskId: task.id,
                result: output.trim(),
            }).catch(() => {})
        }).catch(() => {})

        yield {type: 'subagent_done', taskId: task.id, result}
    }

    /** 执行子任务（AsyncGenerator 流式输出） */
    async *executeTask(params: SubAgentStartParams): AsyncGenerator<SubAgentEvent> {
        const {task} = params
        const config = this.getConfig()

        // 启用优先级队列时，加入队列等待调度
        if (config.priorityEnabled) {
            const priority = task.priority ?? 0
            params.abortSignal?.addEventListener('abort', () => {
                this.priorityQueue.removeByTaskId(task.id)
            }, {once: true})
            yield* await this.enqueueTask(task, params, priority)
            return
        }

        // 直接模式：容量不足时拒绝
        if (!this.hasCapacity) {
            const {maxConcurrency} = config
            logger.warn(`[SubAgentScheduler] No capacity for task ${task.id}, max: ${maxConcurrency}`)
            yield {
                type: 'subagent_done',
                taskId: task.id,
                result: {
                    taskId: task.id,
                    success: false,
                    output: '',
                    error: `并发上限已满 (${maxConcurrency})，请等待其他子任务完成`,
                },
            }
            return
        }

        yield* this.executeTaskInternal(params)
    }
}

/** 全局单例 */
export const subAgentScheduler = new SubAgentScheduler()
