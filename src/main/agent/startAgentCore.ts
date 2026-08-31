/**
 * Agent 启动统一门户（startAgentCore）
 *
 * 唯一的 Agent 启动路径：读 DB 全量历史 → 上下文重建（去重/附件/thinking 转换/
 * 结构化截断）→ 组装 workerParams → agentManager.start()。
 * 调用方：agent-start IPC（renderer）、scheduler、channel、memo。
 * origin 仅用于日志追踪，不参与行为分支。
 */
import type {AgentStartParams} from './manager'
import {agentManager} from './manager'
import {isAudioFile, isImageFile, isNetworkImageUrl} from './utils/imageProcessor'
import {convertUserHistoryMessage, normalizeHistoryMessageOrder} from './utils/userContentBuilder'
import {runtimeConfigManager} from './runtimeConfigManager'
import {resolveAgentDefinitionForTurn} from './agentTemplateConverter'
import {createConversationRepository} from '../repositories'
import {logger} from './logger'
import {convertAssistantHistoryMessage} from './ipc/historyConverter'
import {TEXT_MODEL_ROLES} from '@shared/types'
import type {ModelRole, SystemSettings} from '@shared/types'
import {systemSettingsRepo} from '../repositories/sqlite/systemSettingsRepository'
import {buildUserMessage} from './messageBuilder'
import {getConversationPersistence} from '../persistence/conversationPersistence'

export type StartOrigin = 'renderer' | 'scheduler' | 'channel' | 'memo'

export class AgentStartValidationError extends Error {}

export interface CoreStartParams {
    conversationId: string
    message: string
    messageAttachments?: Array<{path: string; name: string}>
    messageMetadata?: Record<string, unknown>
    conversationTitle?: string
    suppressUserMessage?: boolean
}

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

type UserContent = string | Array<{type: 'text'; text: string} | {
    type: 'image_url';
    image_url: {url: string}
}>

const IMAGE_MIME_BY_EXT: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
}

/** 描述文本统一为纯文本块（无附件时仅为 message 本身，空消息占位 '\n' 保持原行为） */
function buildDescriptionBlock(label: string, attachments: Array<{name: string; path: string}>): string {
    if (attachments.length === 0) return ''
    return '\n\n' + attachments.map((att, idx) =>
        `[${label}${idx + 1}]\n文件: ${att.name}\n路径: ${att.path}`
    ).join('\n')
}

/** 本地图片转 base64 data URI；读取失败返回 null（由调用方降级为错误文本块） */
async function toImageDataUri(path: string): Promise<string | null> {
    try {
        const imgBuffer = await import('fs/promises').then(fs => fs.readFile(path))
        const ext = path.split('.').pop()?.toLowerCase() || 'png'
        const mime = IMAGE_MIME_BY_EXT[ext] || 'image/png'
        return `data:${mime};base64,${imgBuffer.toString('base64')}`
    } catch {
        return null
    }
}

/**
 * 构建本轮 user 消息的多模态 content：
 * 无附件 → 纯文本；有附件 → 音频/其他附件写入描述文本，
 * 图片写入文本路径标注（供 analyze_image 使用）+ image_url 块（网络 URL 直接引用，
 * 本地图片转 base64，读取失败降级为错误文本块）。
 */
async function buildUserMessageContent(
    message: string,
    attachments?: Array<{path: string; name: string}>,
): Promise<UserContent> {
    if (!attachments || attachments.length === 0) {
        return message || '\n'
    }

    // 分离图片、音频和其他附件
    const imageAttachments = attachments.filter(att => isImageFile(att.path) || isNetworkImageUrl(att.path))
    const audioAttachments = attachments.filter(att => !imageAttachments.includes(att) && isAudioFile(att.path))
    const otherAttachments = attachments.filter(att => !imageAttachments.includes(att) && !audioAttachments.includes(att))

    const textParts: string[] = [message || '\n']
    const audioDescription = buildDescriptionBlock('语音附件', audioAttachments)
    const otherDescription = buildDescriptionBlock('附件', otherAttachments)
    if (audioDescription) textParts.push(audioDescription)
    if (otherDescription) textParts.push(otherDescription)

    // 将图片路径加入文本，确保非视觉模型也能通过 analyze_image 工具分析图片
    const imagePathDescription = imageAttachments.map(att => `\n【图片文件路径】${att.path}`).join('')
    if (imagePathDescription) textParts.push(imagePathDescription)

    const textBlock = {type: 'text' as const, text: textParts.join('')}

    if (imageAttachments.length === 0) {
        return textParts.join('')
    }

    const content: NonNullable<UserContent> = [textBlock]
    for (const img of imageAttachments) {
        if (isNetworkImageUrl(img.path)) {
            content.push({type: 'image_url', image_url: {url: img.path}})
        } else {
            const dataUri = await toImageDataUri(img.path)
            if (dataUri) {
                content.push({type: 'image_url', image_url: {url: dataUri}})
            } else {
                // 图片读取失败，保留文本中的文件路径供 analyze_image 工具使用
                content.push({type: 'text', text: `\n[图片文件读取失败: ${img.path}]`})
            }
        }
    }
    return content
}

export async function startAgentCore(params: CoreStartParams, origin: StartOrigin): Promise<void> {
    // ★ 方案校验：三角色全空则拒绝启动（双重校验，见 spec 4.5）
    const schemeForCheck = runtimeConfigManager.getScheme()
    const hasValidRole = schemeForCheck?.roles.some(r =>
        TEXT_MODEL_ROLES.includes(r.role as ModelRole)
        && r.enabled && r.endpointId && r.modelId
    )
    if (!hasValidRole) {
        throw new AgentStartValidationError('推理模型、主力模型、轻量模型不允许全部为空')
    }

    // 从会话存储获取历史消息
    const conversationRepo = createConversationRepository() as any
    const history = (conversationRepo.readMessages(params.conversationId) as any) || []

    // 从会话元数据获取工作目录
    const meta = conversationRepo.readMeta(params.conversationId) as any
    const workingDir = meta?.workspacePath || ''

    const userMessageContent = await buildUserMessageContent(params.message, params.messageAttachments)

    // Phase 2：user 消息落库收敛到主进程（渲染端已停写熔断，渲染端不再经
    // block-delta 落库 user 消息；此处为唯一写入方）。
    // ★P2：messageMetadata（commandId/commandTemplate 等）随消息落库，
    // 否则重启后 UserCommandBubble 丢失命令样式（还原为纯文本）。
    if (!params.suppressUserMessage) {
      const userMsg = await buildUserMessage({
        convId: params.conversationId,
        text: params.message,
        attachments: params.messageAttachments,
        metadata: params.messageMetadata,
      })
      getConversationPersistence().writeNow(params.conversationId, userMsg)
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
            // suppressUserMessage=true 时调用方已自行落库该消息，末条 user 即本次
            // 待发送消息，不能因去重判定跳过（否则消息从重建序列完全消失）。
            if (!params.suppressUserMessage && isDuplicatePendingUser && msg === lastHistoryMsg) {
                continue
            }
            // ★ user 消息重建（附件构建 + metadata 收拢 + 命令尾随重放）
            //   统一走共享函数（userContentBuilder.convertUserHistoryMessage），
            //   回归测试锁定其输出与 loop/execute.ts 首轮注入逐字节一致
            convertedMessages.push(...await convertUserHistoryMessage(msg))
        } else if (msg.role === 'assistant') {
            // ★ 按 contentBlocks 的 think 边界无损还原多 assistant
            //   （loop 内存态：一次 LLM 调用 = 一个 assistant；否则跨 turn
            //   重建的 prompt 前缀与上一轮 loop 末不一致，KV cache 断裂）
            const convertedAssistant = convertAssistantHistoryMessage(msg)
            convertedMessages.push(...convertedAssistant)
        }
        // system 消息跳过（由 systemPrompt 处理）
    }

    const messages = normalizeHistoryMessageOrder(convertedMessages)
    // suppressUserMessage: true 时由渠道调用方已自行落库/推送 user 消息，
    // 本次仅以 DB 历史重建上下文，不重推 params.message
    if (!params.suppressUserMessage) {
        messages.push({
            role: 'user' as const,
            content: userMessageContent,
            // 将消息元数据传递给 Worker，供 Agent Loop 识别命令模式
            metadata: params.messageMetadata,
            id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        })
    }

    // 诊断：统计构建后的 tool 消息数量
    const toolMsgCount = messages.filter(m => m.role === 'tool').length
    const assistantWithTcCount = messages.filter(m => m.role === 'assistant' && (m.toolCalls?.length ?? 0) > 0).length
    const totalTcCount = messages.reduce((sum, m) => sum + (m.toolCalls?.length ?? 0), 0)
    logger.debug('[agent-start]', {
        action: 'built',
        origin,
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
        logger.info('[agent-start] 重建序列摘要', {convId: params.conversationId.slice(-8), origin, summary: msgSummary})
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
    //
    // ★ 跨轮工具集一致性：无新命令时从 system prompt 缓存载荷恢复上一命令轮的
    //   agentDefinition（resolveAgentDefinitionForTurn，理由见其注释）。
    let cachedSystemPromptRaw: string | null = null
    try {
        cachedSystemPromptRaw = conversationRepo.getSystemPrompt(params.conversationId)
    } catch {
        cachedSystemPromptRaw = null
    }
    const agentDefinition = resolveAgentDefinitionForTurn(
        params.messageMetadata?.commandId as string | undefined,
        cachedSystemPromptRaw,
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
        ...(params.conversationTitle ? {conversationTitle: params.conversationTitle} : {}),
        ...(agentDefinition ? {agentDefinition} : {}),
    }

    logger.debug('[agent-start]', {
        action: 'schemeConfig',
        origin,
        schemeName: currentScheme?.name || 'null',
        providers: currentProviders.length,
    })

    await agentManager.start(workerParams)
}
