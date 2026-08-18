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
import {resolveAgentDefinitionFromCommandId} from '../agentTemplateConverter'
import {logger} from '../logger'
import {convertAssistantHistoryMessage, restoreSkillSystemMessages} from './historyConverter'
import type {LlmStats, SystemSettings} from '@shared/types'
import {systemSettingsRepo} from '../../repositories/sqlite/systemSettingsRepository'

/**
 * 判断 history 最后一条 user 是否与本次待发送消息（params.message）为同一条已落库消息。
 *
 * 背景（跨 turn 缓存断裂根因之一）：渲染端先 addMessage 落库、再 startAgent 传同一消息。
 * 新会话首条消息在 throttle 首次立即 flush 场景必现，execution.ts 若无条件 push history 的
 * user 再 push params.message，重建序列出现 [user, user] 重复，与 loop 内存态（单 user）
 * 逐 token 不一致 → 跨 turn KV cache 从首条消息处整段断裂。
 *
 * 判定条件（全部满足才视为同一条）：
 *  1. history 末条是 user（= 尚未被 assistant 回复处理，正是本次待发送消息）
 *  2. 内容与 params.message 逐字一致
 *  3. 附件数量一致
 *
 * ★ 边界：用户连续发送相同内容（如两次"很好"）时，第二条的 history 末条是第一条的
 *   assistant 回复（role='assistant'）→ 条件 1 不满足 → 不去重，两条 user 都保留。
 */
export function isDuplicatePendingUserMessage(
    history: Array<{role: string; content?: unknown; attachments?: unknown[]}>,
    pendingMessage: string,
    pendingAttachments?: Array<unknown>,
): boolean {
    const last = history[history.length - 1]
    if (!last || last.role !== 'user') return false
    if (typeof last.content !== 'string') return false
    if (last.content !== pendingMessage) return false
    if ((last.attachments?.length ?? 0) !== (pendingAttachments?.length ?? 0)) return false
    return true
}

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
            const convertedMessages: AgentStartParams['messages'] = []

            // ★ 去重防护：渲染端先 addMessage 落库、再 startAgent 传同一消息，
            //   已落库的最后一条 user 就是本次待发送消息 → 循环内跳过它，避免
            //   重建序列出现 [user, user] 重复导致跨 turn KV cache 断裂。
            //   判定逻辑见 isDuplicatePendingUserMessage（纯函数，已单测锁定边界）。
            const lastHistoryMsg = history[history.length - 1]
            const isDuplicatePendingUser = isDuplicatePendingUserMessage(
                history,
                params.message || '',
                params.messageAttachments,
            )

            for (const msg of history) {
                if (msg.role === 'user') {
                    // 与本次待发送消息重复的最后一条已落库 user → 跳过
                    if (isDuplicatePendingUser && msg === lastHistoryMsg) {
                        continue
                    }
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
                    // ★ 按 contentBlocks 的 think 边界无损还原多 assistant
                    //   （loop 内存态：一次 LLM 调用 = 一个 assistant；否则跨 turn
                    //   重建的 prompt 前缀与上一轮 loop 末不一致，KV cache 断裂）
                    const convertedAssistant = convertAssistantHistoryMessage(msg)
                    // ★ 原样还原 skill 工具的 system 注入消息（KV cache 前缀一致性）
                    // 运行时 injectMessage 追加在 tool 消息之后（execute.ts deferredMessages），
                    // 但 system 消息不落库，重建若不恢复会改变 system 块序列 → 缓存整段断裂。
                    // 详见 restoreSkillSystemMessages 的 JSDoc。
                    restoreSkillSystemMessages(msg, convertedAssistant)
                    for (const converted of convertedAssistant) {
                        convertedMessages.push(converted)
                    }
                }
                // system 消息跳过（由 systemPrompt 处理）
            }

            let messages = convertedMessages
            messages.push({
                role: 'user' as const,
                content: userMessageContent,
                // 将消息元数据传递给 Worker，供 Agent Loop 识别命令模式
                metadata: params.messageMetadata,
                id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            })

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

            // ★ 缓存一致性诊断（方案 2 调试）：记录重建序列的精确摘要，
            //   供跨 turn 重建与 loop 末态逐 token 比对。
            //   每消息记录 role + content/thinking/reasoning/toolResult 字符长度，
            //   assistant 额外记录 thinking 来源（thinking vs reasoningContent）。
            if (messages.length > 4) {
                const msgSummary = messages.map(m => {
                    const base: Record<string, unknown> = {r: m.role}
                    if (m.role === 'assistant') {
                        base.c = (typeof m.content === 'string' ? m.content.length : 0)
                        base.th = (m.thinking || '').length
                        base.rc = (m.reasoningContent || '').length
                        base.tc = m.toolCalls?.length ?? 0
                    } else if (m.role === 'tool') {
                        base.tr = (m.toolResult || '').length
                        base.id = (m.toolCallId || '').slice(-8)
                    } else {
                        base.c = (typeof m.content === 'string' ? m.content.length : 'non-str')
                    }
                    return base
                })
                logger.info('[agent-start] 重建序列摘要', {convId: params.conversationId.slice(-8), summary: msgSummary})
            }

            // 从 runtimeConfigManager 获取当前模型方案（single source of truth）
            const currentScheme = runtimeConfigManager.getScheme()
            const currentProviders = runtimeConfigManager.getProviders()

            // 从系统设置中提取 maxTurns（主 Agent 应该使用设置中的值，而非默认值）
            const settingsForWorker = systemSettingsRepo.getJson<SystemSettings>('settings')
            const maxTurnsFromSettings = settingsForWorker?.agent?.maxTurns ?? 500

            // ★ 命令模式工具过滤修复：从 messageMetadata.commandId 解析 agentDefinition。
            //   命令路径（Ctrl+K / /agent）此前不构造 agentDefinition，filterTools 回退
            //   General 类型导致 tools/disallowedTools 白黑名单全部失效（Plan Agent 等
            //   只读 Agent 实际拿到全部工具）。注入后走与子 Agent 派发一致的过滤链。
            const agentDefinition = resolveAgentDefinitionFromCommandId(
                params.messageMetadata?.commandId as string | undefined,
            )

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
                ...(agentDefinition ? {agentDefinition} : {}),
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
        llmStats: LlmStats[]
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
