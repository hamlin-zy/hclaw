/**
 * ChannelMessageQueue — 渠道并发消息排队管理
 *
 * 问题：当渠道用户快速发送多条消息时，Agent 可能尚未处理完上一条，
 * 导致并发请求覆盖 runningAgents 状态或消息顺序错乱。
 *
 * 解决方案：
 * - 每会话维护一个 FIFO 消息队列
 * - 消息到达时，若会话正在处理中，则排队并告知用户"排队中"
 * - 当前消息处理结束时，通过 onDone 回调自动弹出下一条继续处理
 *
 * 复用设计参考：SchedulerPool.pendingTasks 的队列模式
 */

import {logger} from '../agent/logger'
import type {IncomingMessage} from './types'

interface QueuedMessage {
    msg: IncomingMessage
    queuedAt: number
}

export interface QueueCallbacks {
    /** 处理下一条消息（由 ChannelManager 实现） */
    processNext: (msg: IncomingMessage) => Promise<void>
    /** 通知用户消息已排队 */
    notifyQueued: (msg: IncomingMessage, position: number) => Promise<void>
}

/**
 * 渠道消息排队器
 *
 * 以 conversationId 为键管理各会话的消息队列。
 * 保证同一会话的消息串行处理，避免并发覆盖 runningAgents 状态。
 */
export class ChannelMessageQueue {
    /** conversationId → 消息队列 */
    private queues = new Map<string, QueuedMessage[]>()
    /** conversationId → 是否正在处理中 */
    private processing = new Set<string>()

    /**
     * 尝试入队
     * @returns true = 已入队（当前有消息正在处理）；false = 直接处理（队列空闲）
     */
    enqueue(msg: IncomingMessage, callbacks: QueueCallbacks): boolean {
        const convId = msg.conversationId!
        if (!this.processing.has(convId)) {
            // 队列空闲，直接处理
            this.processing.add(convId)
            return false
        }

        // 正在处理中 → 入队
        if (!this.queues.has(convId)) {
            this.queues.set(convId, [])
        }
        const queue = this.queues.get(convId)!
        const position = queue.length + 1
        queue.push({msg, queuedAt: Date.now()})

        callbacks.notifyQueued(msg, position).catch(() => {})
        return true
    }

    /**
     * 标记当前消息处理完成，弹出并处理下一条
     * 应在 Agent 完全结束后调用（在 onAgentStateChange(false) 时触发）
     */
    dequeueAndProcess(convId: string, callbacks: QueueCallbacks): void {
        const queue = this.queues.get(convId)
        if (!queue || queue.length === 0) {
            // 队列已空，标记为空闲
            this.processing.delete(convId)
            this.queues.delete(convId)
            return
        }

        // 弹出队首消息并处理
        const next = queue.shift()!
        logger.info('ChannelQueue.dequeue', { convId: convId.slice(0,8), remaining: queue.length })

        // 保持 processing 状态（正在处理新的消息）
        callbacks.processNext(next.msg).catch(err => {
            logger.error('ChannelQueue.processNext', { error: (err as Error)?.message || err })
            // 处理失败也要继续清空，避免卡死
            this.processing.delete(convId)
            this.queues.delete(convId)
        })
    }

    /** 获取指定会话的排队数量（不含当前正在处理的） */
    getQueueSize(convId: string): number {
        return this.queues.get(convId)?.length ?? 0
    }

    /** 获取所有会话的排队数量 */
    getTotalQueued(): number {
        let total = 0
        for (const queue of this.queues.values()) {
            total += queue.length
        }
        return total
    }

    /** 清空指定会话的队列（通常在切换会话时调用） */
    clear(convId: string): void {
        this.queues.delete(convId)
        this.processing.delete(convId)
    }
}
