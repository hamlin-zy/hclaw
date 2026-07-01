/**
 * ChannelManager — 主进程渠道管理器
 *
 * 职责：
 * 1. 管理 Worker Thread 生命周期
 * 2. 路由渠道消息（指令 / Agent）
 * 3. 管理渠道会话绑定
 *
 * 核心逻辑已提取到 messageHandler.ts
 */

import {Worker} from 'worker_threads'
import path from 'path'
import crypto from 'crypto'

import {channelRepo} from './ChannelRepository'
import {handleIncomingMessage} from './messageHandler'
import {createConversationRepository} from '../repositories'
import type {IncomingMessage, WorkerEvent, ResourceRef} from './types'
import {getChannelMediaDir} from '../config'
import {container} from '../agent/common/container'
import {systemSettingsRepo} from '../repositories/sqlite/systemSettingsRepository'
import type {SystemSettings} from '../../shared/types'

export class ChannelManager {
    private worker: Worker | null = null
    /** 当前正在运行 Agent 的 conversationId 集合 */
    private runningAgents = new Set<string>()

    /** 等待用户回复的 ask_user 状态 */
    private pendingAskUser = new Map<string, {
        resolve: (answer: string) => void
        reject: (err: Error) => void
        question: string
        timestamp: number
    }>()

    /** 待处理的资源下载请求 */
    private pendingDownloads = new Map<string, {
        resolve: (attachments: Array<{ path: string; name: string; mimeType?: string }>) => void
        timer: NodeJS.Timeout
    }>()

    init(): void {
        channelRepo.seedDefaults()
        // 重置所有渠道状态，避免旧 session 残留的 connected/error 状态
        channelRepo.resetAllStatuses()
        // 强制重置未配置的种子渠道为禁用 + 断开
        // 防御性措施：防止旧版数据库残留数据、迁移错误、或边缘竞态
        // 导致渠道在首次安装时就显示为「已启用 + 已连接」
        channelRepo.resetUnconfiguredChannels()
        this.spawnWorker()
    }

    private spawnWorker(): void {
        const workerPath = path.join(__dirname, 'channelWorker.cjs')
        // .cjs 扩展名确保 Node.js 始终以 CommonJS 模式加载（不受 package.json type:module 影响）
        this.worker = new Worker(workerPath)

        this.worker.on('message', (msg: WorkerEvent) => this.handleWorkerMessage(msg))

        // 提前缓存 logger，避免在两个事件回调中各 require 一次
        const {logger} = require('../agent/logger')
        this.worker.on('error', (err: Error) => {
            logger.error('ChannelManager.worker.error', {error: err.message, stack: err.stack?.slice(0, 500)})
        })

        this.worker.on('exit', (code) => {
            if (code !== 0) {
                logger.warn('ChannelManager.worker.exit', {code, message: '将在 5s 后重启'})
                setTimeout(() => this.spawnWorker(), 5000)
            }
        })

        // 连接所有已启用的渠道
        this.connectEnabledChannels()
    }

    private connectEnabledChannels(): void {
        const enabled = channelRepo.list().filter((c) => c.enabled)
        for (const ch of enabled) {
            this.connect(ch.id)
        }
    }

    private handleWorkerMessage(msg: WorkerEvent): void {
        try {
            switch (msg.type) {
                case 'status':
                    this.handleStatusUpdate(msg)
                    break
                case 'incoming_msg':
                    this.handleIncomingMessage(msg).catch(_err => {
                        // handled inside handleIncomingMessage
                    })
                    break
                case 'download_resources_result': {
                    const pending = this.pendingDownloads.get(msg.messageId)
                    if (pending) {
                        clearTimeout(pending.timer)
                        this.pendingDownloads.delete(msg.messageId)
                        pending.resolve(msg.attachments || [])
                    }
                    break
                }
                // send_result and test_result are handled elsewhere
            }
        } catch (_err) {
            // silently handled
        }
    }

    private handleStatusUpdate(msg: { channelId: string; status: string; message?: string; botIdentity?: { openId: string } }): void {

        const existing = channelRepo.get(msg.channelId)
        if (existing) {
            // 连接成功时，如果适配器提供了 botIdentity（飞书），则更新渠道 config.userId
            const updateData: Partial<typeof existing> & { name: string; type: string } = {
                name: existing.name,
                type: existing.type,
                status: msg.status as 'connected' | 'error',
                statusMessage: msg.message || '',
                lastConnectedAt: msg.status === 'connected' ? Date.now() : undefined,
            }

            if (msg.status === 'connected' && msg.botIdentity?.openId) {
                updateData.config = {
                    ...existing.config,
                    userId: msg.botIdentity.openId,
                }
            }

            channelRepo.upsert(msg.channelId, updateData)

            // 连接成功后向真实用户发送问候消息
            if (msg.status === 'connected') {
                // 优先从 channel_bindings 找活跃用户（飞书：真实用户）
                // 回退到 config.userId（个人微信：扫码登录的账号）
                const targetUserId = channelRepo.getActiveBindings(msg.channelId)[0]?.channelUserId
                    || (existing.config as any)?.userId
                if (targetUserId) {
                    this.sendGreeting(msg.channelId, targetUserId)
                }
            }
        }

        // 推送状态变更到渲染进程
        this.notifyRenderer('channel-status-changed', {
            channelId: msg.channelId,
            status: msg.status,
            statusMessage: msg.message || '',
        })
    }

    /**
     * 渠道连接成功后向登录用户发送问候消息
     * 根据系统设置决定是否发送
     */
    private async sendGreeting(channelId: string, userId: string): Promise<void> {
        const settings = systemSettingsRepo.getJson<SystemSettings>('settings')
        const sendGreeting = settings?.channels?.sendGreeting ?? true
        if (!sendGreeting) return
        await this.sendViaWorker(channelId, userId, '你好！HClaw 已准备就绪，随时为你服务 🎉')
    }

    private async handleIncomingMessage(msg: WorkerEvent): Promise<void> {
        if (msg.type !== 'incoming_msg') return

        // 从 binding 获取 conversationId（用于构建会话级附件目录）
        const binding = channelRepo.getBinding(msg.channelId, msg.userId)

        const incomingMsg: IncomingMessage = {
            channelId: msg.channelId,
            userId: msg.userId,
            text: msg.text,
            contextToken: msg.contextToken,
            conversationId: msg.conversationId || binding?.conversationId,
            attachments: msg.attachments,
            resources: msg.resources,
        }

        await handleIncomingMessage(incomingMsg, {
            sendViaWorker: (channelId, userId, text, contextToken) =>
                this.sendViaWorker(channelId, userId, text, contextToken),
            sendMediaViaWorker: (channelId, userId, filePath, fileType, contextToken) =>
                this.sendMediaViaWorker(channelId, userId, filePath, fileType, contextToken),
            getAgentRunning: () => this.runningAgents.has(binding?.conversationId ?? ''),
            renameConversation: (channelId, userId, title) =>
                this.renameConversation(channelId, userId, title),
            switchConversation: (channelId, userId, page, index) =>
                this.switchConversation(channelId, userId, page, index),
            listConversations: (page) =>
                this.listConversations(page),
            promptUserInChannel: (channelId, userId, question, conversationId) =>
                this.promptUserInChannel(channelId, userId, question, conversationId),
            rejectPermission: (channelId, userId, operation, conversationId) =>
                this.rejectPermission(channelId, userId, operation, conversationId),
            /** 通过 runningAgents 集合跟踪 Agent 运行状态，供 /status 命令查询 */
            onAgentStateChange: (conversationId, isRunning) => {
                if (isRunning) {
                    this.runningAgents.add(conversationId)
                } else {
                    this.runningAgents.delete(conversationId)
                }
            },
            /** 通知当前会话ID变更，用于通知 Adapter 设置会话级附件目录 */
            onConversationIdChange: (conversationId) => {
                this.worker?.postMessage({
                    cmd: 'set_conversation_id',
                    channelId: msg.channelId,
                    conversationId,
                })
            },
            /** 在已知 conversationId 后下载资源附件 */
            downloadResources: (channelId, resources) =>
                this.downloadResources(channelId, resources),
            /** 中止指定会话的 Agent Worker（创建新会话时清理旧 Worker） */
            abortAgent: (conversationId) => {
                const {agentManager} = require('../agent/manager')
                agentManager.abort(conversationId).catch(() => {})
            },
        })
    }

    private notifyRenderer(channel: string, data: unknown): void {
        try {
            const {getMainWindow} = require('../window')
            const win = getMainWindow()
            if (win && !win.isDestroyed()) {
                win.webContents.send(channel, data)
            }
        } catch (_err) {
            // window 模块尚未就绪，正常启动阶段会频繁触发
        }
    }

    // ─── Public API ─────────────────────────────────────────

    /**
     * 向 Worker 发起 request-response 式调用
     * @param expectedType 响应的 msg.type
     * @param payload worker.postMessage 的参数
     * @param timeoutMs 超时毫秒（默认 30s）
     */
    private requestWorker<T>(
        expectedType: string,
        payload: Record<string, unknown>,
        timeoutMs = 30_000
    ): Promise<T> {
        if (!this.worker) {
            return Promise.resolve({success: false, error: 'Worker not initialized'} as unknown as T)
        }
        return new Promise<T>((resolve) => {
            const handler = (msg: WorkerEvent) => {
                if (msg.type === expectedType && 'channelId' in msg && msg.channelId === payload.channelId) {
                    this.worker!.removeListener('message', handler)
                    resolve(msg as unknown as T)
                }
            }
            this.worker!.on('message', handler)
            this.worker!.postMessage(payload)
            setTimeout(() => {
                this.worker!.removeListener('message', handler)
                resolve({success: false, error: '请求超时'} as unknown as T)
            }, timeoutMs)
        })
    }

    async sendViaWorker(
        channelId: string,
        toUserId: string,
        text: string,
        contextToken?: string
    ): Promise<{ success: boolean; error?: string }> {
        return this.requestWorker('send_result', {
            cmd: 'send', channelId, toUserId, text, contextToken: contextToken || '',
        })
    }

    async sendMediaViaWorker(
        channelId: string,
        toUserId: string,
        filePath: string,
        fileType: string,
        contextToken?: string
    ): Promise<{ success: boolean; error?: string }> {
        return this.requestWorker('send_media_result', {
            cmd: 'send_media', channelId, toUserId, filePath, fileType, contextToken: contextToken || '',
        })
    }

    async connect(channelId: string): Promise<void> {
        const record = channelRepo.get(channelId)
        if (!record) {
            throw new Error(`Channel not found: ${channelId}`)
        }
        if (!record.enabled) {
            throw new Error(`Channel not enabled: ${channelId} (enabled=${record.enabled})`)
        }
        if (!this.worker) {
            throw new Error('Worker not initialized')
        }

        // 读取渠道超时配置
        const settings = systemSettingsRepo.getJson<SystemSettings>('settings')
        const connectionTimeout = settings?.channels?.connectionTimeout ?? 30

        this.worker.postMessage({
            cmd: 'connect',
            channelId: record.id,
            channelType: record.type,
            connectionTimeout,
            config: {
                ...record.config,
                _mediaDir: getChannelMediaDir(record.id),
            },
        })
    }

    disconnect(channelId: string): void {
        this.worker?.postMessage({cmd: 'disconnect', channelId})
    }

    async testConnection(channelId: string): Promise<{ success: boolean; error?: string; message?: string }> {
        const record = channelRepo.get(channelId)
        if (!record) return {success: false, error: 'Channel not found'}
        return this.requestWorker('test_result', {
            cmd: 'test', channelId, config: record.config,
        })
    }

    notifyConfigChange(channelId: string): void {
        const record = channelRepo.get(channelId)
        if (!record) return
        this.disconnect(channelId)
        if (record.enabled) {
            setTimeout(() => this.connect(channelId), 500)
        }
    }

    shutdown(): void {
        this.worker?.postMessage({cmd: 'shutdown'})
        setTimeout(() => {
            this.worker?.terminate()
            this.worker = null
        }, 1000)
    }

    /**
     * 在已知 conversationId 后，通过 Worker 触发适配器下载附件资源
     * 使用 Promise + request-response 模式，确保下载完成后再继续处理消息
     */
    private async downloadResources(
        channelId: string,
        resources: ResourceRef[]
    ): Promise<Array<{ path: string; name: string; mimeType?: string }>> {
        if (!this.worker || !resources?.length) return []

        const messageId = crypto.randomUUID()

        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.pendingDownloads.delete(messageId)
                resolve([])
            }, 30_000)

            this.pendingDownloads.set(messageId, {resolve, timer})

            this.worker!.postMessage({
                cmd: 'download_resources',
                channelId,
                resources,
                messageId,
            })
        })
    }

    // ─── Deps Methods ──────────────────────────────────────

    private async renameConversation(
        channelId: string,
        userId: string,
        title: string
    ): Promise<string> {
        const binding = channelRepo.getBinding(channelId, userId)
        if (!binding?.conversationId) {
            return '❌ 当前无活跃会话'
        }
        const convRepo = createConversationRepository()
        convRepo.updateMeta(binding.conversationId, {title})
        return `✅ 会话已重命名为：${title}`
    }

    private async listConversations(page: number): Promise<string> {
        const convRepo = createConversationRepository()
        const all = convRepo.list()
        const effectivePage = page === 0 ? 1 : page
        const start = (effectivePage - 1) * 10
        const items = all.slice(start, start + 10)
        const totalPages = Math.ceil(all.length / 10) || 1

        if (items.length === 0) {
            return `📋 暂无更多会话（第 ${effectivePage}/${totalPages} 页）`
        }

        const lines = items.map((c, i) => {
            const date = new Date(c.updatedAt).toLocaleString('zh-CN')
            return ` ${start + i + 1}. ${c.title} — ${date}`
        })

        return (
            `📋 会话列表（第 ${effectivePage}/${totalPages} 页）：\n` +
            lines.join('\n') +
            '\n\n发送 /chats <页码> <编号> 切换会话'
        )
    }

    private async switchConversation(
        channelId: string,
        userId: string,
        page: number,
        index: number
    ): Promise<string> {
        const convRepo = createConversationRepository()
        const all = convRepo.list()
        const effectivePage = page === 0 ? 1 : page
        const targetIdx = (effectivePage - 1) * 10 + (index - 1)
        const target = all[targetIdx]

        if (!target) {
            return '❌ 未找到指定会话'
        }

        channelRepo.upsertBinding(channelId, userId, target.id)
        return `✅ 已切换到会话：${target.title}`
    }

    private async promptUserInChannel(
        channelId: string,
        userId: string,
        question: string,
        conversationId: string
    ): Promise<string> {
        return new Promise((resolve) => {
            this.sendViaWorker(
                channelId,
                userId,
                `🤖 Agent 需要确认：${question}\n(请直接回复)`
            )
            this.pendingAskUser.set(conversationId, {
                resolve,
                reject: () => resolve(''),
                question,
                timestamp: Date.now(),
            })
        })
    }

    private async rejectPermission(
        channelId: string,
        userId: string,
        operation: string,
        _conversationId: string
    ): Promise<void> {
        await this.sendViaWorker(
            channelId,
            userId,
            `⛔ '${operation}' 操作需要权限确认，\n请切换到 自动模式 跳过权限确认，\n或移步桌面端进行权限确认。`
        )
    }
}

export const channelManager = new ChannelManager()
// 注册到 DI 容器，确保工具代码获取到的是同一个实例
container.register('ChannelManager', channelManager)
