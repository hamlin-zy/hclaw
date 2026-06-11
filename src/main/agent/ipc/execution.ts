/**
 * Agent 执行 IPC handlers
 *
 * 处理 Agent 的启动、中止、消息注入、状态查询、用户确认响应
 */

import {ipcMain} from 'electron'
import type {AgentStartParams} from '../manager'
import {agentManager} from '../manager'
import {permissionEngine} from '../tools/permission'
import {isAudioFile, isImageFile, isNetworkImageUrl} from '../utils/imageProcessor'
import {runtimeConfigManager} from '../runtimeConfigManager'
import {logger} from '../logger'
import type {SystemSettings} from '@shared/types'
import {systemSettingsRepo} from '../../repositories/sqlite/systemSettingsRepository'

export function registerHandlers(): void {
    // 启动 Agent（简化版：配置从全局获取）
    ipcMain.handle('agent-start', async (_event, params: {
        conversationId: string
        message: string
        messageAttachments?: Array<{path: string; name: string}>
        /** 消息元数据（如命令模板等） */
        messageMetadata?: Record<string, unknown>
    }) => {
        try {
            // 从会话存储获取历史消息
            const {createConversationRepository} = await import('../../repositories')
            const conversationRepo = createConversationRepository() as any
            const history = (conversationRepo.readMessages(params.conversationId) as any) || []

            // 从会话元数据获取工作目录
            const meta = conversationRepo.readMeta(params.conversationId) as any
            const workingDir = meta?.workspacePath || ''

            // 获取当前权限模式
            const _mode = await permissionEngine.getMode()

            // 构建用户消息内容（处理附件）
            let userMessageContent: string | Array<{type: 'text'; text: string} | {
                type: 'image_url';
                image_url: {url: string}
            }>

            if (params.messageAttachments && params.messageAttachments.length > 0) {
                // 分离图片、音频和非音频非图片附件
                const imageAttachments: Array<{path: string; name: string}> = []
                const audioAttachments: Array<{path: string; name: string}> = []
                const otherAttachments: Array<{path: string; name: string}> = []

                for (const att of params.messageAttachments) {
                    if (isImageFile(att.path) || isNetworkImageUrl(att.path)) {
                        imageAttachments.push(att)
                    } else if (isAudioFile(att.path)) {
                        audioAttachments.push(att)
                    } else {
                        otherAttachments.push(att)
                    }
                }

                // 构建附件描述列表
                const audioDescription = audioAttachments.length > 0
                    ? audioAttachments.map((att, idx) =>
                        `[语音附件${idx + 1}]\n文件: ${att.name}\n路径: ${att.path}`
                    ).join('\n')
                    : ''

                const otherDescription = otherAttachments.length > 0
                    ? otherAttachments.map((att, idx) =>
                        `[附件${idx + 1}]\n文件: ${att.name}\n路径: ${att.path}`
                    ).join('\n')
                    : ''

                // 构建文本消息 + 图片
                const textParts: string[] = [params.message || '\n']

                if (audioDescription) textParts.push(`\n\n${audioDescription}`)
                if (otherDescription) textParts.push(`\n\n${otherDescription}`)

                // 将图片路径加入文本，确保非视觉模型也能通过 analyze_image 工具分析图片
                const imagePathDescription = imageAttachments.length > 0
                    ? imageAttachments.map((att) =>
                        `\n【图片文件路径】${att.path}`
                    ).join('')
                    : ''
                if (imagePathDescription) textParts.push(imagePathDescription)

                if (imageAttachments.length > 0) {
                    const contentArr: Array<{type: 'text'; text: string} | {
                        type: 'image_url';
                        image_url: {url: string}
                    }> = []
                    contentArr.push({type: 'text', text: textParts.join('')})

                    for (const img of imageAttachments) {
                        if (isNetworkImageUrl(img.path)) {
                            contentArr.push({type: 'image_url', image_url: {url: img.path}})
                        } else {
                            // 本地图片转为 base64 data URI
                            try {
                                const imgBuffer = await import('fs/promises').then(fs => fs.readFile(img.path))
                                const ext = img.path.split('.').pop()?.toLowerCase() || 'png'
                                const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
                                    : ext === 'png' ? 'image/png'
                                        : ext === 'gif' ? 'image/gif'
                                            : ext === 'webp' ? 'image/webp'
                                                : 'image/png'
                                const dataUri = `data:${mime};base64,${imgBuffer.toString('base64')}`
                                contentArr.push({type: 'image_url', image_url: {url: dataUri}})
                            } catch {
                                // 图片读取失败，保留文本中的文件路径供 analyze_image 工具使用
                                contentArr.push({type: 'text', text: `\n[图片文件读取失败: ${img.path}]`})
                            }
                        }
                    }

                    userMessageContent = contentArr as any
                } else {
                    userMessageContent = textParts.join('')
                }
            } else {
                userMessageContent = params.message || '\n'
            }

            // 转换历史消息（兼容新旧格式）
            const convertedMessages: Array<any> = []

            for (const msg of history) {
                if (msg.role === 'user') {
                    const attachments = msg.attachments || msg.messageAttachments
                    let userContent: string | Array<any> = msg.content || ''

                    if (attachments && attachments.length > 0) {
                        const textParts: string[] = [msg.content || '']
                        const imgParts: Array<any> = []
                        const imgAttachments = attachments.filter((att: any) =>
                            isImageFile(att.path || att) || isNetworkImageUrl(att.path || att)
                        )

                        if (imgAttachments.length > 0) {
                            // 将图片路径加入文本，确保非视觉模型也能通过 analyze_image 工具分析图片
                            const histImgPaths = imgAttachments.map((att: any) =>
                                `\n【图片文件路径】${att.path || att}`
                            ).join('')
                            textParts.push(histImgPaths)
                            imgParts.push({type: 'text', text: textParts.join('')})
                            for (const img of imgAttachments) {
                                const imgPath = img.path || img
                                if (isNetworkImageUrl(imgPath)) {
                                    imgParts.push({type: 'image_url', image_url: {url: imgPath}})
                                } else {
                                    try {
                                        const fs = await import('fs/promises')
                                        const imgBuffer = await fs.readFile(imgPath)
                                        const ext = imgPath.split('.').pop()?.toLowerCase() || 'png'
                                        const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
                                            : ext === 'png' ? 'image/png'
                                                : ext === 'gif' ? 'image/gif'
                                                    : ext === 'webp' ? 'image/webp'
                                                        : 'image/png'
                                        const dataUri = `data:${mime};base64,${imgBuffer.toString('base64')}`
                                        imgParts.push({type: 'image_url', image_url: {url: dataUri}})
                                    } catch {
                                        // 图片读取失败，使用文本描述代替
                                        textParts.push(`\n[图片: ${imgPath}]`)
                                    }
                                }
                            }
                            userContent = imgParts as any
                        } else {
                            // 非图片附件，添加文本描述
                            const otherDesc = attachments.map((att: any) => {
                                const attPath = att.path || att
                                const attName = att.name || attPath.split('/').pop() || attPath.split('\\').pop() || attPath
                                return `[附件]\n文件: ${attName}\n路径: ${attPath}`
                            }).join('\n')
                            userContent = (msg.content || '') + '\n\n' + otherDesc
                        }
                    }

                    convertedMessages.push({
                        role: 'user',
                        content: userContent,
                        id: msg.id || `msg-${Date.now()}`,
                    })
                } else if (msg.role === 'assistant') {
                    // 兼容新旧格式的 thinking/thinkBlock
                    let assistantThinking: string | undefined
                    let assistantSignature: string | undefined
                    let assistantReasoning: string | undefined
                    let assistantContent: string

                    if (msg.thinking !== undefined) {
                        assistantThinking = msg.thinking
                        assistantSignature = msg.thinkingSignature
                        assistantReasoning = msg.reasoningContent || msg.thinking
                        assistantContent = msg.content
                    } else if (msg.thinkBlock?.content) {
                        // 新路径：使用 thinkBlock 字段
                        const thinkParts = msg.thinkBlock.signature
                            ? [msg.thinkBlock.content]
                            : msg.thinkBlock.content.split('\n').filter(Boolean)
                        const textParts = msg.content
                            ? typeof msg.content === 'string'
                                ? [msg.content]
                                : []
                            : []

                        assistantThinking = thinkParts.join('\n') || undefined
                        assistantReasoning = thinkParts.join('\n') || undefined
                        assistantContent = textParts.join('')
                    } else {
                        // 旧路径：扁平字段后向兼容
                        assistantThinking = msg.thinkBlock?.content
                        assistantSignature = (msg.thinkBlock as any)?.signature
                        assistantReasoning = msg.thinkBlock?.content
                        assistantContent = msg.content
                    }

                    // 提取 toolCalls 和对应的 tool result
                    const toolCallsForMessage: Array<any> = []
                    const toolMessagesForResult: Array<any> = []

                    if (msg.toolCalls && Array.isArray(msg.toolCalls)) {
                        for (const tc of msg.toolCalls) {
                            toolCallsForMessage.push({
                                id: tc.id,
                                name: tc.name,
                                arguments: tc.arguments || tc.input || tc.args || {},
                                status: tc.status,
                            })
                            // 每个 tool_use 必须有对应的 tool_result（Anthropic API 强制要求）
                            const hasResult = tc.result != null
                            if (hasResult) {
                                const rawResult = tc.result
                                toolMessagesForResult.push({
                                    toolCallId: tc.id,
                                    toolResult: typeof rawResult === 'string' ? rawResult : (rawResult?.output ?? JSON.stringify(rawResult)),
                                    isError: tc.isError || tc.status === 'error' || false,
                                })
                            } else {
                                // 缺少 result（中断/超时/结果丢失），生成一条合成错误结果
                                toolMessagesForResult.push({
                                    toolCallId: tc.id,
                                    toolResult: `[工具执行被中断或结果丢失] ${tc.name} 工具调用未返回执行结果。该工具可能因超时、用户中止或系统错误而未完成。`,
                                    isError: true,
                                })
                            }
                        }
                    }

                    convertedMessages.push({
                        role: 'assistant',
                        content: assistantContent,
                        thinking: assistantThinking,
                        thinkingSignature: assistantSignature,
                        reasoningContent: assistantReasoning,
                        toolCalls: toolCallsForMessage.length > 0 ? toolCallsForMessage : undefined,
                    })

                    // 展开 toolCalls 中的 result 为独立的 tool 消息
                    for (const tr of toolMessagesForResult) {
                        convertedMessages.push({
                            role: 'tool' as const,
                            content: '',
                            toolCallId: tr.toolCallId,
                            toolResult: tr.toolResult,
                            isError: tr.isError,
                        })
                    }
                }
                // system 消息跳过（由 systemPrompt 处理）
            }

            const messages: AgentStartParams['messages'] = [
                ...convertedMessages,
                {
                    role: 'user' as const,
                    content: userMessageContent,
                    // 将消息元数据传递给 Worker，供 Agent Loop 识别命令模式
                    metadata: params.messageMetadata,
                    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                },
            ]
            // 诊断：统计构建后的 tool 消息数量
            const toolMsgCount = messages.filter(m => m.role === 'tool').length
            const assistantWithTcCount = messages.filter(m => m.role === 'assistant' && (m.toolCalls?.length ?? 0) > 0).length
            const totalTcCount = messages.reduce((sum, m) => sum + (m.toolCalls?.length ?? 0), 0)
            logger.debug('[agent-start]', {
                action: 'built',
                messages: messages.length,
                tool: toolMsgCount,
                assistantWithToolCalls: assistantWithTcCount,
                totalToolCalls: totalTcCount,
            })

            // 从 runtimeConfigManager 获取当前模型方案（single source of truth）
            const currentScheme = runtimeConfigManager.getScheme()
            const currentProviders = runtimeConfigManager.getProviders()

            // 从系统设置中提取 maxTurns（主 Agent 应该使用设置中的值，而非默认值）
            const settingsForWorker = systemSettingsRepo.getJson<SystemSettings>('settings')
            const maxTurnsFromSettings = settingsForWorker?.agent?.maxTurns ?? 500

            // 构建 worker 参数
            const workerParams: AgentStartParams = {
                conversationId: params.conversationId,
                messages,
                messageAttachments: params.messageAttachments,
                // 将消息元数据传递给 Worker，供 Agent Loop 识别命令模式
                messageMetadata: params.messageMetadata,
                modelConfig: {} as any, // 由 loop 从 runtimeConfigManager 获取
                maxTurns: maxTurnsFromSettings,
                workingDir,
                schemeConfig: currentScheme ? {
                    scheme: currentScheme,
                    providers: currentProviders as any,
                } : undefined,
                workMode: runtimeConfigManager.getWorkMode(),
            }

            logger.debug('[agent-start]', {
                action: 'schemeConfig',
                schemeName: currentScheme?.name || 'null',
                providers: currentProviders.length,
            })

            await agentManager.start(workerParams)
            return {success: true}
        } catch (err: any) {
            return {success: false, error: err.message}
        }
    })

    // 中止 Agent
    ipcMain.handle('agent-abort', async (_event, conversationId: string) => {
        await agentManager.abort(conversationId)
        return {success: true}
    })

    // 向运行中的 Agent 注入用户消息（不中断当前执行）
    ipcMain.handle('agent-inject-message', async (_event, params: {
        conversationId: string
        content: string
        messageId?: string
    }) => {
        const injected = agentManager.injectMessage(params.conversationId, params.content, params.messageId)
        return {success: injected}
    })

    // 查询运行状态
    ipcMain.handle('agent-status', async (_event, conversationId?: string) => {
        if (conversationId) {
            return {
                running: agentManager.isRunning(conversationId),
                allRunning: agentManager.getRunningConversations(),
            }
        }
        return {
            running: false,
            allRunning: agentManager.getRunningConversations(),
        }
    })

    // 响应用户确认
    ipcMain.handle('agent-respond-confirmation', async (_event, params: {
        conversationId: string
        requestId: string
        result: 'allow' | 'always' | 'deny'
    }) => {
        agentManager.respondConfirmation(params.conversationId, params.requestId, params.result)
        return {success: true}
    })

    // 响应用户提问的回答
    ipcMain.handle('agent-respond-ask-user', async (_event, params: {
        conversationId: string
        requestId: string
        answer: string
    }) => {
        agentManager.respondAskUser(params.conversationId, params.requestId, params.answer)
        return {success: true}
    })

    // ── 消息 LLM 统计更新 ──
    ipcMain.handle('message:updateLlmStats', async (_event, params: {
        conversationId: string
        messageId: string
        llmStats: Array<{inputTokens: number; outputTokens: number; provider: string; model: string; duration: number}>
    }) => {
        try {
            const {createConversationRepository} = await import('../../repositories')
            const repo = createConversationRepository()
            return repo.updateMessageLlmStats(params.conversationId, params.messageId, params.llmStats)
        } catch (err) {
            logger.error('[IPC] message:updateLlmStats failed', {error: err})
            return false
        }
    })
}
