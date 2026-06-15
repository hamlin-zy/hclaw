/**
 * Channel message handler
 *
 * Handles incoming messages from channels and routes them appropriately:
 * - Command processing
 * - Session binding
 * - Agent routing
 */

import crypto from 'crypto'
import * as path from 'path'
import * as fs from 'fs'

import {channelRepo} from './ChannelRepository'
import {workspaceRepo} from '../repositories/sqlite/workspaceRepository'
import {agentManager} from '../agent/manager'
import {channelCommandManager} from './CommandManager'
import {buildUserContent, hasAudioAttachment, isAttachmentOnlyMarker} from './utils'
import {mcpService} from '../services/mcpService'
import type {ChannelBindingRecord, CommandResult, IncomingMessage, ResourceRef} from './types'
import type {ChatMessage, ModelConfig} from '../agent/model/types'
import type {LLMProvider, ModelScheme, WorkMode} from '@shared/types'
import {logger} from '../agent/logger'

/** 统一的结构化错误日志，避免 (err as Error)?.message || err 重复书写 */
function logError(context: string, err: unknown, extra?: Record<string, unknown>): void {
    logger.error(context, { ...extra, error: (err as Error)?.message || err })
}

/**
 * 渠道积压附件队列
 *
 * 用户可能先发送附件（图片/文件），然后发送语音指令或文本指令。
 * 附件消息会先被保存到积压队列，当收到带有实际内容的指令时，
 * 将积压的附件与指令一起传递给 Agent。
 *
 * 队列以 {channelId}_{userId}_{conversationId} 为键，
 * 确保不同用户/渠道/会话的附件不会混淆。
 * 积压超时时间 5 分钟，超时后自动清理。
 */
interface PendingAttachments {
    attachments: Array<{ path: string; name: string; mimeType?: string }>
    timestamp: number
}
const pendingAttachmentsQueue = new Map<string, PendingAttachments>()
const PENDING_ATTACHMENTS_TTL_MS = 5 * 60 * 1000 // 5 分钟

function getPendingKey(channelId: string, userId: string, conversationId: string): string {
    return `${channelId}_${userId}_${conversationId}`
}

function addToPendingAttachments(channelId: string, userId: string, conversationId: string, attachments: Array<{ path: string; name: string; mimeType?: string }>): void {
    const key = getPendingKey(channelId, userId, conversationId)
    pendingAttachmentsQueue.set(key, {
        attachments: attachments,
        timestamp: Date.now(),
    })
}

function flushPendingAttachments(channelId: string, userId: string, conversationId: string): Array<{ path: string; name: string; mimeType?: string }> | null {
    const key = getPendingKey(channelId, userId, conversationId)
    const pending = pendingAttachmentsQueue.get(key)
    if (!pending) return null
    if (Date.now() - pending.timestamp > PENDING_ATTACHMENTS_TTL_MS) {
        pendingAttachmentsQueue.delete(key)
        return null
    }
    pendingAttachmentsQueue.delete(key)
    return pending.attachments
}

function cleanupExpiredPendingAttachments(): void {
    const now = Date.now()
    for (const [key, pending] of pendingAttachmentsQueue.entries()) {
        if (now - pending.timestamp > PENDING_ATTACHMENTS_TTL_MS) {
            pendingAttachmentsQueue.delete(key)
        }
    }
}

setInterval(cleanupExpiredPendingAttachments, 60 * 1000)

// ─── 消息持久化辅助 ──────────────────────────────────────────

/**
 * 将渠道附件转换为 Message Attachment 格式（含 id、类型检测等）
 */
function toMessageAttachments(atts: Array<{ path: string; name: string; mimeType?: string }>): Array<{
    id: string; name: string; type: string; size: number; path: string; isImage: boolean
}> {
    const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.svg'])
    return atts.map(a => {
        const ext = a.path ? `.${a.path.split('.').pop()?.toLowerCase()}` : ''
        return {
            id: crypto.randomUUID(),
            name: a.name,
            type: a.mimeType || '',
            size: 0,
            path: a.path,
            isImage: IMAGE_EXTENSIONS.has(ext),
        }
    })
}

/**
 * 向 conversation 表写入一条消息并更新元数据
 * 使用直接 INSERT，消除 readMessages → DELETE ALL → REINSERT ALL 的竞态风险
 * 支持传入 attachments 结构化存储在 metadata 中，供 UI 层 AttachmentPreview 渲染
 */
async function persistMessage(
    conversationId: string,
    role: 'user' | 'assistant',
    content: string,
    options?: { preview?: string; reloadMessages?: boolean; attachments?: Array<{ path: string; name: string; mimeType?: string }> }
): Promise<void> {
    try {
        const {getDatabase, saveDatabase} = await import('../repositories/sqlite')
        const {createConversationRepository} = await import('../repositories')
        const db = getDatabase()
        const msgId = crypto.randomUUID()
        const timestamp = Date.now()

        // ★ 直接 INSERT，避免 readMessages → DELETE ALL → REINSERT ALL 的竞态导致消息丢失
        // 结构化存储附件到 metadata，使 UI 能用 AttachmentPreview 渲染精美卡片而非原始文本
        const metaData: Record<string, unknown> = {content}
        if (options?.attachments?.length) {
            metaData.attachments = toMessageAttachments(options.attachments)
        }
        const metadataStr = JSON.stringify(metaData)

        db.prepare(
            'INSERT INTO messages (id, conversation_id, role, timestamp, ended_at, metadata, llm_stats) VALUES (?, ?, ?, ?, NULL, ?, NULL)'
        ).run(msgId, conversationId, role, timestamp, metadataStr)

        db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(timestamp, conversationId)

        saveDatabase()

        const preview = options?.preview ?? (content.slice(0, 200).replace(/\n+/g, ' ').trim() || '(空回复)')
        createConversationRepository().updateMeta(conversationId, {preview})
        notifyConversationUpdated(conversationId, {preview, reloadMessages: options?.reloadMessages})
    } catch (err) {
        logError('persistMessage', err, { convId: conversationId?.slice(0,8), role, contentLen: (content||'').length })
        throw err  // 让调用方知道持久化失败
    }
}

/** 惰性获取主窗口，替代多次 require('../window') */
function getMainWindowLazy(): Electron.BrowserWindow | null {
    try {
        const {getMainWindow} = require('../window') as typeof import('../window')
        const win = getMainWindow()
        return win && !win.isDestroyed() ? win : null
    } catch (err) {
        // 应用启动阶段 window 模块尚未就绪属于正常情况
        logger.debug('getMainWindowLazy', { error: (err as Error)?.message || err })
        return null
    }
}

interface MessageHandlerDeps {
    sendViaWorker: (channelId: string, userId: string, text: string, contextToken?: string) => Promise<{ success: boolean; error?: string }>
    sendMediaViaWorker?: (channelId: string, userId: string, filePath: string, fileType: string, contextToken?: string) => Promise<{ success: boolean; error?: string }>
    getAgentRunning?: () => boolean
    renameConversation: (channelId: string, userId: string, title: string) => Promise<string>
    switchConversation: (channelId: string, userId: string, page: number, index: number) => Promise<string>
    listConversations: (page: number) => Promise<string>
    promptUserInChannel: (channelId: string, userId: string, question: string, conversationId: string) => Promise<string>
    rejectPermission: (channelId: string, userId: string, operation: string, conversationId: string) => Promise<void>
    /** Agent 运行状态变更通知，用于 ChannelManager 维护 runningAgents 集合 */
    onAgentStateChange?: (conversationId: string, isRunning: boolean) => void
    /** 通知当前会话ID变更，用于 Adapter 设置会话级附件目录 */
    onConversationIdChange?: (conversationId: string) => void
    /** 在已知 conversationId 后下载资源附件 */
    downloadResources?: (channelId: string, resources: ResourceRef[]) => Promise<Array<{ path: string; name: string; mimeType?: string }>>
    /** 中止指定会话的 Agent Worker（创建新会话时清理旧 Worker） */
    abortAgent?: (conversationId: string) => void
}

/**
 * Process incoming channel message and route to appropriate handler
 */
export async function handleIncomingMessage(
    msg: IncomingMessage,
    deps: MessageHandlerDeps
): Promise<void> {
    const {sendViaWorker} = deps



    // 1. Check for commands
    const cmdResult = channelCommandManager.handle(msg.channelId, msg.text, {
        binding: channelRepo.getBinding(msg.channelId, msg.userId),
        agentRunning: deps.getAgentRunning?.() ?? false,
    })

    if (cmdResult.handled) {
        await handleCommandResult(msg, cmdResult, deps)
        return
    }

    // 2. Check session binding
    const binding = channelRepo.getBinding(msg.channelId, msg.userId)

    if (!binding?.conversationId) {
        await sendViaWorker(
            msg.channelId,
            msg.userId,
            `请先发送 /new <工作目录编号> 创建新会话：\n${formatWorkspaceList()}`,
            msg.contextToken
        )
        return
    }

    // 3. Flush pending attachments (merge with current message)
    const pendingAttachments = flushPendingAttachments(msg.channelId, msg.userId, binding.conversationId)
    if (pendingAttachments) {
        msg.attachments = [...(msg.attachments || []), ...pendingAttachments]
    }

    // 4. 立即更新适配器的会话ID（确保附件下载使用正确的会话目录）
    if (binding?.conversationId) {
        deps.onConversationIdChange?.(binding.conversationId)
    }

    // 4.1 如有未下载的资源引用，在 conversationId 已知后触发下载
    //     适配器使用正确的会话级目录保存附件
    if (msg.resources?.length && deps.downloadResources) {
        const downloaded = await deps.downloadResources(msg.channelId, msg.resources)
        if (downloaded.length > 0) {
            msg.attachments = [...(msg.attachments || []), ...downloaded]
        }
    }

    // 5. Check attachment-only messages (no user text)
    const isOnlyMarker = isAttachmentOnlyMarker(msg.text)
    const hasAttachments = (msg.attachments?.length ?? 0) > 0

    if (isOnlyMarker) {
        if (hasAttachments) {
            await handleAttachmentOnlyMessage(msg, binding, deps)
        } else {
            // 无附件（CDN 下载失败导致 attachments=undefined）→ 回复提示，不启动 Agent
            await persistMessage(binding.conversationId, 'user', '(附件消息，下载失败)', {
                preview: '(附件消息-下载失败)',
            }).catch(err => logError('handler.persistFailed', err, { context: 'attachment-message' }))

            const failReply = '✅ 已收到文件消息。发送文字或语音指令来开始对话。'
            await sendViaWorker(msg.channelId, msg.userId, failReply, msg.contextToken)

            await persistMessage(binding.conversationId, 'assistant', failReply, {
                reloadMessages: true,
            }).catch(err => logError('handler.persistFailed', err, { context: 'download-reply' }))
        }
        return
    }

    // 5. Process and route to agent
    await processAgentMessage(msg, binding, deps)
}

// ─── Command Result Handling ──────────────────────────

async function handleCommandResult(
    msg: IncomingMessage,
    result: CommandResult,
    deps: MessageHandlerDeps
): Promise<void> {
    const {sendViaWorker} = deps

    if (result.needsNewSession) {
        const workspaceIndex = parseWorkspaceIndex(msg.text)

        if (isNaN(workspaceIndex)) {
            const wsList = formatWorkspaceList()
            await sendViaWorker(
                msg.channelId,
                msg.userId,
                `请选择工作区，发送 /new <工作目录编号> 创建新会话：\n${wsList}`,
                msg.contextToken
            )
        } else {
            await createNewSession(msg, workspaceIndex, deps)
            // 保存 /new 指令的用户消息（Issues #2/#3）
            const newBinding = channelRepo.getBinding(msg.channelId, msg.userId)
            if (newBinding?.conversationId) {
                persistCommandMessages(newBinding.conversationId, msg.text)
            }
        }
        return
    }

    let reply: string | undefined

    if (result.needsRename) {
        reply = await deps.renameConversation(msg.channelId, msg.userId, result.needsRename.title)
    } else if (result.needsSwitchChat) {
        reply = await deps.switchConversation(
            msg.channelId, msg.userId,
            result.needsSwitchChat.page, result.needsSwitchChat.index
        )
    } else if (result.needsListChats) {
        reply = await deps.listConversations(result.needsListChats.page)
    } else {
        reply = result.reply
    }

    // 保存快捷指令的用户消息和回复（Issues #2/#3）
    const binding = channelRepo.getBinding(msg.channelId, msg.userId)
    if (binding?.conversationId) {
        persistCommandMessages(binding.conversationId, msg.text, reply || undefined)
    }

    if (reply) {
        await sendViaWorker(msg.channelId, msg.userId, reply, msg.contextToken)
    }
}

/**
 * 持久化快捷指令消息（Issues #2/#3）
 * 将用户消息和助手回复写入 SQLite，使用事务保证原子性
 */
async function persistCommandMessages(conversationId: string, userText: string, assistantReply?: string): Promise<void> {
    const {getDatabase, saveDatabase} = await import('../repositories/sqlite')
    try {
        const db = getDatabase()
        const now = Date.now()

        const userRowId = crypto.randomUUID()
        const newRows: Array<{
            id: string; role: string; timestamp: number; ended_at: null; metadata: string; llm_stats: null
        }> = [
            { id: userRowId, role: 'user', timestamp: now, ended_at: null, metadata: JSON.stringify({content: userText}), llm_stats: null },
        ]
        if (assistantReply) {
            const asstRowId = crypto.randomUUID()
            newRows.push({ id: asstRowId, role: 'assistant', timestamp: now + 1, ended_at: null, metadata: JSON.stringify({content: assistantReply}), llm_stats: null })
        }

        db.transaction(() => {
            const stmt = db.prepare(
                'INSERT INTO messages (id, conversation_id, role, timestamp, ended_at, metadata, llm_stats) VALUES (?, ?, ?, ?, ?, ?, ?)'
            )
            for (const row of newRows) {
                stmt.run(row.id, conversationId, row.role, row.timestamp, row.ended_at, row.metadata, row.llm_stats)
            }
            db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId)
        })()

        saveDatabase()

        notifyConversationUpdated(conversationId, {preview: userText.slice(0, 200)})
    } catch (err) {
        logError('handler.persistError', err)
    }
}

/**
 * 通知渲染进程：会话有更新（Issues #2/#3 UI 刷新）
 * 通过 conversation-updated 事件触发 UI 重新加载对话消息列表
 */
function notifyConversationUpdated(convId: string, updates: Record<string, unknown>): void {
    const win = getMainWindowLazy()
    if (win) {
        win.webContents.send('conversation-updated', {
            id: convId,
            ...updates,
            updatedAt: Date.now(),
        })
    }
}

// ─── Helpers ──────────────────────────────────────────────

function parseWorkspaceIndex(text: string): number {
    const parts = text.trim().split(/\s+/)
    return parts.length > 1 ? parseInt(parts[1], 10) : NaN
}

// ─── Attachment-Only Message Handling ─────────────────────

/**
 * 检查 MCP 工具列表中是否存在语音识别（speech_to_text）能力
 */
function hasASRCapability(): boolean {
    const servers = mcpService.list()
    for (const server of servers) {
        if (server.status !== 'connected') continue
        for (const tool of (server.tools || []) as Array<{ name?: string; description?: string }>) {
            const name = tool.name?.toLowerCase() || ''
            if (name === 'speech_to_text' || name.includes('asr') || name.includes('语音转文字')) {
                return true
            }
        }
    }
    return false
}

/**
 * 处理纯附件消息（无用户文字输入）
 *
 * 规则：
 * - 语音消息 → 有 ASR 则交给 Agent，无 ASR 则提示用户配置
 * - 图片/文件/文档等 → 保存到积压队列，提示用户发送指令
 *
 * 设计说明：
 * 用户可能先发送附件（图片/文件），然后发送语音指令或文本指令。
 * 附件消息会先被保存到积压队列，当收到带有实际内容的指令时，
 * 将积压的附件与指令一起传递给 Agent。
 */
async function handleAttachmentOnlyMessage(
    msg: IncomingMessage,
    binding: ChannelBindingRecord,
    deps: MessageHandlerDeps
): Promise<void> {
    const {sendViaWorker} = deps

    // 规则 1 & 2：语音消息（有 ASR 能力时直接交给 Agent）
    if (hasAudioAttachment(msg.attachments!)) {
        if (!hasASRCapability()) {
            await sendViaWorker(
                msg.channelId,
                msg.userId,
                '⚠️ 收到语音消息，但当前未配置语音识别（ASR）能力。\n' +
                '请参考官方文档，配置语音识别 MCP 工具后即可使用语音指令。\n' +
                '配置方式：添加一个支持 speech_to_text 的 MCP 服务（如百度语音识别）并启用。',
                msg.contextToken
            )
            return
        }

        // 有 ASR 能力 → 交给 Agent 处理（Agent 会使用 speech_to_text MCP 工具转写）
        await processAgentMessage(msg, binding, deps)
        return
    }

    // 规则 3：图片/文件/文档等非音频附件 → 保存到积压队列，不触发 Agent
    addToPendingAttachments(msg.channelId, msg.userId, binding.conversationId, msg.attachments!)

    // 持久化用户消息，确保对话历史完整
    // ★ 存储空文本 + 结构化附件，UI 层用 AttachmentPreview 展示
    await persistMessage(binding.conversationId, 'user', '', {
        preview: '(纯附件消息)',
        attachments: msg.attachments,
    }).catch(err => logError('handler.persistAttachment', err))

    const replyText = `✅ 已保存 ${msg.attachments!.length} 个附件。\n发送文字或语音指令来开始对话。`
    await sendViaWorker(msg.channelId, msg.userId, replyText, msg.contextToken)

    // 持久化助手回复并通知 UI 刷新
    await persistMessage(binding.conversationId, 'assistant', replyText, {
        preview: replyText.slice(0, 50),
        reloadMessages: true,
    }).catch(err => logError('handler.persistAssistantReply', err))
}

// ─── Agent Message Processing ─────────────────────────────

async function processAgentMessage(
    msg: IncomingMessage,
    binding: ChannelBindingRecord,
    deps: MessageHandlerDeps
): Promise<void> {
    const {sendViaWorker} = deps

    // 1. Write user message to conversation (store raw text + structured attachments)
    const {createConversationRepository} = await import('../repositories')
    const convRepo = createConversationRepository()

    const userPreviewText = msg.text.slice(0, 200).replace(/\n+/g, ' ').trim() || '(图片/附件消息)'

    logger.info('processAgentMessage', { text: (msg.text||'').slice(0,100), attachments: (msg.attachments||[]).length })
    logger.info('processAgentMessage.persist', { convId: binding.conversationId?.slice(0,8) })
    try {
        // ★ 存储原始用户文本作为 content，附件作为结构化 metadata，
        //   UI 层 AttachmentPreview 组件会自动渲染精美卡片
        // ★ 传 reloadMessages: true，让 UI 重新加载消息列表，渲染用户消息
        //   否则在会话已激活时，用户从渠道发送的消息不会显示在 UI 中
        await persistMessage(binding.conversationId, 'user', msg.text, {
            preview: userPreviewText,
            attachments: msg.attachments,
            reloadMessages: true,
        })
    } catch (err) {
        logError('processAgentMessage.persistFailed', err)
        await sendViaWorker(msg.channelId, msg.userId, `❌ 消息保存失败，请稍后重试。`, msg.contextToken)
        return
    }

    // 2. Build chat messages for agent
    const allMsgs = (convRepo.readMessages(binding.conversationId) as Array<{
        id: string; role: string; content: string; timestamp?: number; attachments?: Array<{ path: string; name: string }>
    }>) || []

    // 修正后在 map 中保留 timestamp、metadata 等字段，确保 compact_persist 回写时数据完整
    // ★ 对于含结构化附件的用户消息，用 buildUserContent 重建 LLM 输入（含附件描述文本）
    const chatMessages: ChatMessage[] = allMsgs.map((m) => {
        const mAny = m as any
        const hasStructuredAttachments = m.role === 'user' && mAny.attachments?.length > 0
        return {
            role: m.role as 'user' | 'assistant' | 'system' | 'tool',
            content: hasStructuredAttachments
                ? buildUserContent(m.content, mAny.attachments)
                : m.content,
            id: m.id,
            timestamp: m.timestamp,
        }
    })
    // 4. Get runtime config
    const {runtimeConfigManager} = await import('../agent/runtimeConfigManager')
    const currentScheme = runtimeConfigManager.getScheme() as ModelScheme | undefined
    const currentProviders = runtimeConfigManager.getProviders() as LLMProvider[] | undefined
    const meta = convRepo.readMeta(binding.conversationId) as { workspacePath?: string }
    const workingDir = meta?.workspacePath || ''
    const workMode = runtimeConfigManager.getWorkMode()
    const roleProviderInfo = runtimeConfigManager.getModelConfigForWorkMode()
    const modelConfig: ModelConfig | undefined = roleProviderInfo.isValid && roleProviderInfo.provider && roleProviderInfo.modelId
        ? {provider: roleProviderInfo.provider.type, model: roleProviderInfo.modelId}
        : undefined

    // 5. Run agent and get response (with progress notifications every 5 minutes)
    let responseText: string
    try {
        // ⚡ 通知 ChannelManager：当前会话的 Agent 开始运行
        deps.onAgentStateChange?.(binding.conversationId, true)
        responseText = await runAgent({
            conversationId: binding.conversationId,
            messages: chatMessages,
            messageAttachments: msg.attachments,
            workingDir,
            currentScheme,
            currentProviders,
            workMode,
            modelConfig,
            onProgress: (minutes: number) => {
                sendViaWorker(
                    msg.channelId,
                    msg.userId,
                    `🔄 Agent 正在处理中，请稍等...\n(已运行 ${minutes} 分钟)`,
                    msg.contextToken
                )
            },
        })
    } catch (err) {
        await sendViaWorker(
            msg.channelId,
            msg.userId,
            `❌ Agent 处理失败: ${(err as Error).message}`,
            msg.contextToken
        )
        return
    } finally {
        // ⚡ 通知 ChannelManager：当前会话的 Agent 已停止（无论成功或失败）
        deps.onAgentStateChange?.(binding.conversationId, false)
    }

    // 6. Update conversation preview — assistant 消息已由 agentManager.doMergeAndPersist 落库，无需重复写入
    const previewText = responseText.slice(0, 200).replace(/\n+/g, ' ').trim() || '(空回复)'
    convRepo.updateMeta(binding.conversationId, {preview: previewText})
    notifyConversationUpdated(binding.conversationId, {preview: previewText})

    // 7. Send response via channel
    await sendViaWorker(msg.channelId, msg.userId, responseText, msg.contextToken)

    // 8. 检查响应中是否有文件需要作为媒体消息发送
    const mediaFiles = extractMediaFiles(responseText, workingDir)
    for (const fileInfo of mediaFiles) {
        try {
            const resolvedPath = path.resolve(fileInfo.filePath)
            if (fs.existsSync(resolvedPath)) {
                await deps.sendMediaViaWorker?.(
                    msg.channelId,
                    msg.userId,
                    resolvedPath,
                    fileInfo.fileType || 'image',
                    msg.contextToken,
                )
            }
        } catch (err) {
            // 文件发送失败不影响主流程
            logger.debug('processAgentMessage.sendMedia', { error: (err as Error)?.message || err })
        }
    }
}

interface RunAgentOptions {
    conversationId: string
    messages: ChatMessage[]
    messageAttachments?: Array<{ path: string; name: string }>
    workingDir: string
    currentScheme?: ModelScheme
    currentProviders?: LLMProvider[]
    workMode: WorkMode | undefined
    modelConfig?: ModelConfig
    /** 可选：进度通知回调，参数为已运行分钟数 */
    onProgress?: (minutes: number) => void
}

async function runAgent(options: RunAgentOptions): Promise<string> {
    const {
        conversationId,
        messages,
        messageAttachments,
        workingDir,
        currentScheme,
        currentProviders,
        workMode,
        modelConfig,
        onProgress,
    } = options

    // 进度通知：立即发送第一条，之后每 5 分钟发送带时长统计
    const PROGRESS_INTERVAL_MS = 5 * 60 * 1000
    let progressTimer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval> | undefined
    let minutesElapsed = 0

    const sendProgressNotification = () => {
        onProgress?.(minutesElapsed)
        minutesElapsed += 5
    }

    // 立即发送第一条，之后每 5 分钟再发
    if (onProgress) {
        sendProgressNotification()
        progressTimer = setInterval(sendProgressNotification, PROGRESS_INTERVAL_MS)
    }

    return new Promise<string>((resolve, reject) => {
        let accumulatedText = ''

        const removeListener = agentManager.addStreamListener(conversationId, (event) => {
            switch (event.type) {
                case 'text':
                    accumulatedText += event.content
                    break
                case 'done':
                    removeListener()
                    if (progressTimer) clearInterval(progressTimer)
                    if (event.reason === 'error' || event.reason === 'aborted') {
                        reject(new Error(`Agent 结束，原因: ${event.reason}`))
                    } else {
                        resolve(accumulatedText || '(空回复)')
                    }
                    break
                case 'error':
                    removeListener()
                    if (progressTimer) clearInterval(progressTimer)
                    reject(new Error(event.error || 'Agent错误'))
                    break
            }
        })

        // Start agent (no timeout - agent can run for hours)
        agentManager
            .start({
                conversationId,
                messages,
                messageAttachments,
                modelConfig: modelConfig || {provider: 'anthropic' as const, model: ''},
                workingDir,
                // maxTurns 由 agentManager.start() 内部从系统设置读取，此处不传
                schemeConfig: currentScheme && currentProviders
                    ? {scheme: currentScheme, providers: currentProviders}
                    : undefined,
                workMode: workMode as string | undefined,
            })
            .catch((err) => {
                removeListener()
                if (progressTimer) clearInterval(progressTimer)
                reject(err)
            })
    })
}

// ─── Session Management ───────────────────────────────────

async function createNewSession(
    msg: IncomingMessage,
    workspaceIndex: number,
    deps: MessageHandlerDeps
): Promise<void> {
    const {sendViaWorker} = deps

    const workspaces = workspaceRepo.list()
    let workspacePath: string

    if (workspaceIndex > 0 && workspaceIndex <= workspaces.length) {
        workspacePath = workspaces[workspaceIndex - 1].path
    } else {
        const current = workspaceRepo.getCurrentWorkspace()
        workspacePath = current?.path || workspaces[0]?.path || ''
    }

    if (!workspacePath) {
        await sendViaWorker(
            msg.channelId,
            msg.userId,
            '❌ 请先在桌面端选择或创建工作目录后再创建会话。',
            msg.contextToken
        )
        return
    }

    const convId = crypto.randomUUID()

    // 获取旧会话 ID（在 upsertBinding 之前，用于清理旧 Agent Worker）
    const oldBinding = channelRepo.getBinding(msg.channelId, msg.userId)
    const oldConversationId = oldBinding?.conversationId

    // Create conversation record (must await so FK constraint satisfied before upsertBinding)
    await createConversationRecord(convId, msg.channelId, msg.userId, workspacePath)

    // Create binding
    channelRepo.upsertBinding(msg.channelId, msg.userId, convId)

    // 清理旧会话的 Agent Worker（渠道交互通常只有单个活跃会话）
    if (oldConversationId && deps.abortAgent) {
        try {
            deps.abortAgent(oldConversationId)
        } catch (err) {
            logError('createNewSession', err, { context: 'abortAgent' })
        }
    }

    await sendViaWorker(
        msg.channelId,
        msg.userId,
        `✅ 新会话已建立！\n工作区：${workspacePath}\n现在可以发送消息开始对话了。`,
        msg.contextToken
    )
}

async function createConversationRecord(
    convId: string,
    channelId: string,
    userId: string,
    workspacePath: string
): Promise<void> {
    const {getDatabase, saveDatabase} = await import('../repositories/sqlite')
    try {
        const db = getDatabase()
        const now = Date.now()

        const metaObj = {
            id: convId,
            title: `[${channelId}] ${userId}`,
            workspacePath,
            createdAt: now,
            updatedAt: now,
            preview: '',
            status: 'active',
            channel: channelId,
        }

        db.prepare(
            'INSERT OR REPLACE INTO conversations (id, meta, created_at, updated_at, workspace_path) VALUES (?, ?, ?, ?, ?)'
        ).run(convId, JSON.stringify(metaObj), now, now, workspacePath)

        saveDatabase()

        // Notify renderer
        const win = getMainWindowLazy()
        if (win) {
            win.webContents.send('conversation-created', {
                ...metaObj,
                updatedAt: now,
                pinned: false,
            })
        }
    } catch (err) {
        logError('handler.createConversation', err)
    }
}

function formatWorkspaceList(): string {
    const workspaces = workspaceRepo.list()
    if (workspaces.length === 0) {
        return '暂无可用工作区，请先在桌面端配置'
    }
    return workspaces.map((w: { name?: string; path: string }, i: number) =>
        `${i + 1}. ${w.name || w.path}`
    ).join('\n')
}

// ─── Media File Detection ──────────────────────────────

interface MediaFileInfo {
    filePath: string
    fileType: string
}

/**
 * 从 Agent 响应文本中提取文件路径标记
 *
 * 支持格式：
 * - 【已生成文件:/path/to/file.png】
 * - 【已生成文件:image:/path/to/file.png】
 * - 【已保存文件:/path/to/file.pdf】
 * - 文本中直接出现的图片/视频/音频文件路径（绝对路径或相对路径）
 */
function extractMediaFiles(text: string, workingDir?: string): MediaFileInfo[] {
    const results: MediaFileInfo[] = []
    const seen = new Set<string>()

    // 1. 解析【已生成文件:路径】标记
    const tagRegex = /【已(生成|保存)文件(?::(image|audio|video|file))?:([^】]+)】/g
    let match: RegExpExecArray | null
    while ((match = tagRegex.exec(text)) !== null) {
        const fileType = match[2] || 'file'
        const filePath = match[3].trim().replace(/\/$/, '')
        if (filePath && !seen.has(filePath)) {
            seen.add(filePath)
            results.push({filePath, fileType})
        }
    }

    // 2. 额外检测：从文本中直接提取图片文件路径（绝对路径）
    // 匹配 Windows 绝对路径或带扩展名的图片路径
    const imgRegex = /([A-Za-z]:\\(?:[^\\\s"'）,。]+\\)*[^\\\s"'）,。]+\.(png|jpg|jpeg|gif|webp|bmp|svg))/gi
    while ((match = imgRegex.exec(text)) !== null) {
        const filePath = match[1].trim().replace(/[\)\]]+$/, '')
        if (!seen.has(filePath) && fs.existsSync(filePath)) {
            seen.add(filePath)
            results.push({filePath, fileType: 'image'})
        }
    }

    // 3. 如果提供了工作目录，尝试匹配文本中的文件名（相对路径）
    if (workingDir) {
        const bareNameRegex = /\b([^\\\s"'）,。]+\.(png|jpg|jpeg|gif|webp|bmp|svg))\b/gi
        while ((match = bareNameRegex.exec(text)) !== null) {
            const fileName = match[1]
            const candidate = path.join(workingDir, fileName)
            if (!seen.has(candidate) && fs.existsSync(candidate)) {
                seen.add(candidate)
                results.push({filePath: candidate, fileType: 'image'})
            }
        }
    }

    return results
}
