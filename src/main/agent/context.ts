/**
 * 上下文管理 — Token 估算 + 智能摘要压缩
 *
 * 借鉴 cc_src autoCompact 策略，增强版：
 * 1. 估算消息 + 系统提示词的总 token 数
 * 2. 超过阈值时，将早期消息压缩为摘要
 * 3. 保留最近 N 轮完整消息
 * 4. 智能保留关键信息：文件路径、工具参数、关键代码片段
 * 5. 工具结果完整保留（避免重复读取文件）
 * 6. 最近 10 次工具调用：保留失败的，压缩成功的
 */

import {logger} from './logger'
import type {ChatMessage, ContentPart} from './model/types'
import type {Task} from '@shared/types'
import {getCompactPrompt} from './compact/compactPrompt'

/** 平均 4 字符 ≈ 1 token（中英文混合近似值） */
const CHARS_PER_TOKEN = 4

/**
 * 上下文上限（tokens）
 * 设为 700K 以留出 300K 余量给系统提示词（工具/MCP/Skills 可达 100K+）
 * 和输出 tokens（4K），避免触碰 1M 硬限制
 */
const _DEFAULT_MAX_CONTEXT_TOKENS = 700_000

/** 最少保留的最近消息轮数（设为 0，全部交给 LLM 摘要，避免超长 tool result 抵消压缩效果） */
const MIN_RECENT_TURNS = 0

/** 系统提示词估算上限（tokens）— 工具+MCP+Skills 可能非常大 */
const SYSTEM_PROMPT_ESTIMATE = 80_000

/** 图片 token 估算（一张图片约等于 85 个 token，保守估计） */
const IMAGE_TOKEN_ESTIMATE = 85

/** 从消息中提取纯文本内容（支持 string 或 ContentPart[]） */
function _getMessageText(msg: ChatMessage): string {
    if (typeof msg.content === 'string') return msg.content
    if (Array.isArray(msg.content)) {
        return msg.content
            .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
            .map(p => p.text)
            .join(' ')
    }
    return ''
}

/** 检查消息是否包含图片 */
function _hasMessageImages(msg: ChatMessage): boolean {
    return typeof msg.content !== 'string' &&
        Array.isArray(msg.content) &&
        msg.content.some((p: ContentPart) => p.type === 'image_url')
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * 估算消息内容的 token 数
 * 支持纯文本或多模态内容块数组
 */
export function estimateContentTokens(content: string | ContentPart[]): number {
    if (typeof content === 'string') {
        return estimateTokens(content)
    }

    let total = 0
    for (const part of content) {
        if (part.type === 'text') {
            total += estimateTokens(part.text)
        } else if (part.type === 'image_url') {
            total += IMAGE_TOKEN_ESTIMATE
        }
    }
    return total
}

/** 估算消息列表总 token 数 */
export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0
  for (const msg of messages) {
      total += estimateContentTokens(msg.content)
    if (msg.toolResult) total += estimateTokens(msg.toolResult)
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        total += estimateTokens(JSON.stringify(tc.arguments))
      }
    }
  }
  return total
}

/**
 * 估算总上下文 token 数（消息 + 系统提示词）
 */
export function estimateTotalContextTokens(
    messages: ReadonlyArray<ChatMessage> | ChatMessage[],
    systemPrompt?: string,
): number {
    const msgTokens = estimateMessagesTokens([...messages])
    const sysTokens = systemPrompt ? estimateTokens(systemPrompt) : SYSTEM_PROMPT_ESTIMATE
    return msgTokens + sysTokens
}

/**
 * 检查是否为之前的压缩边界消息
 */
export function isCompactBoundaryMessage(msg: ChatMessage): boolean {
    if (msg.role !== 'system' || typeof msg.content !== 'string') return false
    return msg.content.includes('[Earlier conversation has been compacted]') ||
        msg.content.includes('[上下文摘要]')
}

// ─── 共享组装逻辑（compressConversation + createCompactedMessages 共用） ──

/**
 * 从已有摘要组装压缩后的消息列表（无 LLM 调用）
 * 用于 compressConversation 和 compact 命令的 createCompactedMessages
 *
 * @param summary       LLM 生成的摘要文本
 * @param beforeTokens  压缩前 token 数
 * @param allMessages   完整消息列表
 * @param options.recentTurns  保留最近几轮完整消息（默认 4）
 * @param options.pendingTasks 未完成任务列表
 */
export function assembleCompactedMessages(
    summary: string,
    beforeTokens: number,
    allMessages: ChatMessage[],
    options?: {
        recentTurns?: number
        pendingTasks?: Task[]
    },
): { messages: ChatMessage[]; compactedCount: number } {
    const recentTurns = options?.recentTurns ?? MIN_RECENT_TURNS

    // ★ 过滤掉完全空内容的 assistant 消息（streaming 中断产生的无用 artifacts）
    // 这些消息 content 为空、无 toolCalls、无 thinkBlock、无 meaningful contentBlocks，
    // 保留在对话中只会显示为空白气泡
    const filtered = allMessages.filter(m => {
        if (m.role === 'assistant') {
            const contentEmpty = !m.content
            const noToolCalls = !m.toolCalls?.length
            const noThink = !(m as any).thinkBlock && !(m as any).reasoningContent
            // contentBlocks 中只有空 text block 的消息也应过滤
            // （SQLite 序列化/反序列化回环后空消息可能获得 contentBlocks: [{type:'text', text:''}]）
            const contentBlocks = (m as any).contentBlocks as any[] | undefined
            const blocksOnlyEmptyText = contentBlocks != null && contentBlocks.length > 0 &&
                contentBlocks.every((cb: any) => cb.type === 'text' && !cb.text)
            const noMeaningfulBlocks = !contentBlocks?.length || blocksOnlyEmptyText

            if (contentEmpty && noToolCalls && noThink && noMeaningfulBlocks) {
                return false
            }
        }
        return !isCompactBoundaryMessage(m)
    })
    const cutoffIndex = Math.max(0, filtered.length - recentTurns * 2)
    const earlyMessages = cutoffIndex > 0 ? filtered.slice(0, cutoffIndex) : []
    const recentMessages = cutoffIndex > 0 ? filtered.slice(cutoffIndex) : filtered

    const compactedToolCallIds = new Set<string>()
    for (const msg of earlyMessages) {
        if (msg.role === 'assistant' && msg.toolCalls) {
            for (const tc of msg.toolCalls) compactedToolCallIds.add(tc.id)
        }
    }

    const filteredRecent = recentMessages.filter(msg => {
        if (msg.role === 'tool' && msg.toolCallId && compactedToolCallIds.has(msg.toolCallId)) return false
        return true
    })

    // 保留窗口边界外的失败工具调用
    const kept = [...filteredRecent]
    let extraCount = 0
    for (let i = cutoffIndex - 1; i >= 0 && extraCount < 2; i--) {
        const msg = filtered[i]
        if (msg.role === 'tool' && msg.toolCallId && msg.isError) {
            kept.unshift(msg)
            extraCount++
        }
    }

    const summaryContent = [
        `[Earlier conversation has been compacted. Original token count: ${beforeTokens}]`,
        `[上下文摘要] 以下是早期对话的压缩摘要，包含已完成的讨论和关键信息。请基于此摘要和下方的完整消息继续执行任务，不要重复已完成的步骤。\n\n${summary}`,
        options?.pendingTasks ? formatPendingTasks(options.pendingTasks) : '',
    ].filter(Boolean).join('\n\n')

    const summaryMessage: ChatMessage = {
        id: `compact_summary_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        role: 'system',
        content: summaryContent,
    }

    return {messages: [summaryMessage, ...kept], compactedCount: earlyMessages.length}
}

// ─── 统一压缩函数（Path B 自动 + /compact 手动共用） ────────────

export interface CompressResult {
    messages: ChatMessage[]
    wasCompacted: boolean
    summary: string
    beforeTokens: number
    afterTokens: number
    savedTokens: number
    compactedCount: number
}

/**
 * 统一压缩函数 — LLM 生成摘要，自动/手动压缩共用
 *
 * 核心策略：
 * 1. 过滤已有的压缩边界消息，防止多层嵌套
 * 2. 保留最近 N 轮（recentTurns × 2 条）完整消息
 * 3. 早期消息交给 LLM 生成结构化摘要
 * 4. 清理孤立的 tool result
 * 5. 保留失败的工具调用结果（即使刚好在窗口外）
 *
 * @param allMessages    当前完整消息列表
 * @param systemPrompt   系统提示词（用于 token 估算）
 * @param options.mode           'auto' | 'manual'（默认 auto，失败时静默跳过）
 * @param options.recentTurns    保留最近几轮完整消息（默认 4）
 * @param options.customInstructions 自定义压缩指令
 * @param options.abortSignal    取消信号
 * @param options.pendingTasks   未完成任务列表
 */
export async function compressConversation(
    allMessages: ChatMessage[],
    systemPrompt: string,
    options?: {
        mode?: 'auto' | 'manual'
        recentTurns?: number
        customInstructions?: string
        abortSignal?: AbortSignal
        pendingTasks?: import('@shared/types').Task[]
    },
): Promise<CompressResult> {
    const mode = options?.mode ?? 'auto'
    const recentTurns = options?.recentTurns ?? MIN_RECENT_TURNS

    // 1. 过滤已有压缩边界（但 beforeTokens 基于原始消息，确保统计准确）
    const filtered = allMessages.filter(m => !isCompactBoundaryMessage(m))
    const beforeTokens = estimateTotalContextTokens(allMessages, systemPrompt)

    // 2. 分离 early / recent
    const cutoffIndex = Math.max(0, filtered.length - recentTurns * 2)
    const earlyMessages = cutoffIndex > 0 ? filtered.slice(0, cutoffIndex) : []
    const recentMessages = cutoffIndex > 0 ? filtered.slice(cutoffIndex) : filtered

    // 消息太少，无需压缩
    if (earlyMessages.length === 0) {
        return {
            messages: allMessages, wasCompacted: false, summary: '',
            beforeTokens, afterTokens: beforeTokens, savedTokens: 0, compactedCount: 0,
        }
    }

    // 3. LLM 生成摘要
    let summaryText = ''

    try {
        const llmResult = await generateLlmSummary(
            earlyMessages, systemPrompt, options?.customInstructions, options?.abortSignal,
        )
        summaryText = llmResult.summary
    } catch (err) {
        if (mode === 'manual') {
            // 手动压缩：用户主动触发，失败必须报错
            throw err
        }
        // 自动压缩：静默跳过，不中断 session
        return {
            messages: allMessages, wasCompacted: false, summary: '',
            beforeTokens, afterTokens: beforeTokens, savedTokens: 0, compactedCount: 0,
        }
    }

    // 4. 用共享组装逻辑构建压缩结果
    const assembled = assembleCompactedMessages(
        summaryText, beforeTokens, allMessages,
        {recentTurns: options?.recentTurns, pendingTasks: options?.pendingTasks},
    )
    const afterTokens = estimateTotalContextTokens(assembled.messages, systemPrompt)

    return {
        messages: assembled.messages,
        wasCompacted: true,
        summary: summaryText,
        beforeTokens,
        afterTokens,
        savedTokens: beforeTokens - afterTokens,
        compactedCount: assembled.compactedCount,
    }
}

/** 格式化待完成任务列表 */
function formatPendingTasks(pendingTasks: import('@shared/types').Task[]): string {
    const unfinished = pendingTasks.filter(t => t.status === 'pending' || t.status === 'running')
    if (unfinished.length === 0) return ''
    const taskList = unfinished.map(t =>
        `- [${t.status}] ${t.title}${t.description ? `: ${t.description}` : ''}`
    ).join('\n')
    return `\n\n[待完成任务] 以下任务尚未完成，请继续执行：\n${taskList}`
}

/**
 * 调用 LLM 生成对话摘要
 * 失败时抛出异常，由调用方 fallback 到本地提取
 */
async function generateLlmSummary(
    messages: ChatMessage[],
    _systemPrompt?: string,
    customInstructions?: string,
    abortSignal?: AbortSignal,
): Promise<{ summary: string; inputTokens: number; outputTokens: number }> {
    const {createAdapterForContext} = await import('./model/index')
    const {adapter} = await createAdapterForContext('background')

    // 将消息格式化为纯文本，供 LLM 总结
    const conversationText = messages.map(m => {
        const role = m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : '系统'
        let content = ''
        if (typeof m.content === 'string') content = m.content
        else if (Array.isArray(m.content)) {
            content = m.content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n')
        }
        if (m.toolCalls) {
            content += '\n[工具调用] ' + m.toolCalls.map(tc => `${tc.name}(${JSON.stringify(tc.arguments)})`).join(', ')
        }
        if (m.toolResult) {
            const truncated = m.toolResult.length > 1000 ? m.toolResult.slice(0, 1000) + '...' : m.toolResult
            content += '\n[工具结果] ' + truncated
        }
        return `[${role}]: ${content}`
    }).join('\n\n---\n\n')

    const summaryMessages: ChatMessage[] = [
        {
            role: 'system',
            content: getCompactPrompt(customInstructions),
        },
        {
            role: 'user',
            content: `请总结以下对话历史，提取关键信息：\n\n${conversationText}`,
        },
    ]

    const stream = adapter.chat({
        messages: summaryMessages,
        maxTokens: 4096,
        abortSignal,
    })

    let summary = ''
    let inputTokens = 0
    let outputTokens = 0
    for await (const chunk of stream) {
        if (chunk.type === 'text') {
            summary += chunk.content
        } else if (chunk.type === 'usage') {
            inputTokens = chunk.inputTokens
            outputTokens = chunk.outputTokens
        } else if (chunk.type === 'error') {
            throw chunk.error
        }
    }

    if (!summary.trim()) throw new Error('LLM returned empty summary')

    return {summary: summary.trim(), inputTokens, outputTokens}
}

// ─── 手动压缩入口（UI 按钮用） ─────────────────────────────────

/**
 * 简单的文本摘要（当消息太少无法智能压缩时使用）
 */
function generateTextSummary(messages: ChatMessage[]): string {
    const userMessages = messages.filter(m => m.role === 'user')
    const assistantMessages = messages.filter(m => m.role === 'assistant')

    const summaries: string[] = []

    if (userMessages.length > 0) {
        const lastFew = userMessages.slice(-3)
        summaries.push(`用户发起了 ${userMessages.length} 条请求，最近的包括：`)
        for (const msg of lastFew) {
            const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
            summaries.push(`- ${content.slice(0, 100)}...`)
        }
    }

    if (assistantMessages.length > 0) {
        summaries.push(`助手回复了 ${assistantMessages.length} 条消息`)
    }

    return summaries.join('\n')
}

/**
 * 手动压缩入口 - 用于 UI 压缩按钮
 * 与 autoCompact 不同，手动压缩强制执行且不使用阈值判断
 *
 * @deprecated 未在任何地方调用。手动压缩请使用 compressConversation({mode:'manual'})。
 *   UI 层面调用的是 controller.ts 中的 compressConversation 路径。
 *
 * @param messages 当前消息列表
 * @param customInstructions 自定义指令（可选）
 * @param systemPrompt 系统提示词
 * @returns 压缩结果
 */
export async function manualCompact(
    messages: ChatMessage[],
    customInstructions?: string,
    systemPrompt?: string,
): Promise<{
    messages: ChatMessage[]
    summary: string
    beforeTokens: number
    afterTokens: number
    savedTokens: number
    compactedMessages: number
    preservedInfo: string[]
}> {
    if (messages.length === 0) {
        throw new Error('No messages to compact')
    }

    const beforeTokens = estimateTotalContextTokens(messages, systemPrompt)

    // ── 确定 cutoff：手动压缩更激进，只保留 1 轮（2 条消息） ──
    const KEEP_MANUAL_TURNS = 1
    const cutoffIndex = Math.max(0, messages.length - KEEP_MANUAL_TURNS * 2)
    const earlyMessages = cutoffIndex > 0 ? messages.slice(0, cutoffIndex) : []
    const recentMessages = cutoffIndex > 0 ? messages.slice(cutoffIndex) : messages

    // ── 尝试 LLM 摘要 ──
    let summaryText = ''
    let llmInputTokens = 0
    let llmOutputTokens = 0
    let usedLlm = false

    // 只要有可总结的消息就尝试 LLM
    const llmTarget = cutoffIndex > 0
        ? earlyMessages
        : (messages.length > 2 ? messages.slice(0, messages.length - 2) : [])

    if (llmTarget.length > 0) {
        try {
            const llmResult = await generateLlmSummary(llmTarget, systemPrompt, customInstructions)
            summaryText = llmResult.summary
            llmInputTokens = llmResult.inputTokens
            llmOutputTokens = llmResult.outputTokens
            usedLlm = true
        } catch (err) {
            logger.warn('[manualCompact] LLM summarization failed, fallback to local', {error: err})
        }
    }

    if (!usedLlm) {
        // LLM 失败时，用简单文本摘要兜底
        summaryText = generateTextSummary(messages)
        const summaryMessage: ChatMessage = {
            id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            role: 'system',
            content: `[上下文摘要] ${summaryText}`,
        }
        return {
            messages: [summaryMessage],
            summary: summaryText,
            beforeTokens,
            afterTokens: estimateTotalContextTokens([summaryMessage], systemPrompt),
            savedTokens: 0,
            compactedMessages: messages.length,
            preservedInfo: [],
        }
    }

    // ── LLM 成功：用 LLM 摘要组装压缩结果 ──
    // 确定实际被压缩和保留的消息（兼容 cutoffIndex=0 的情况）
    const actualCompressed = cutoffIndex > 0 ? earlyMessages : llmTarget
    const actualKept = cutoffIndex > 0 ? recentMessages : messages.slice(llmTarget.length)

    // 清理与被压缩消息关联的工具结果
    const compactedToolCallIds = new Set<string>()
    for (const msg of actualCompressed) {
        if (msg.role === 'assistant' && msg.toolCalls) {
            for (const tc of msg.toolCalls) {
                compactedToolCallIds.add(tc.id)
            }
        }
    }

    const filteredRecentMessages = actualKept.filter(msg => {
        if (msg.role === 'tool' && msg.toolCallId && compactedToolCallIds.has(msg.toolCallId)) {
            return false
        }
        return true
    })

    const summaryMessage: ChatMessage = {
        id: `compact_summary_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        role: 'system',
        content: `[Earlier conversation has been compacted. Original token count: ${beforeTokens}, Current token count: ${llmInputTokens + llmOutputTokens}]\n\n[上下文摘要] 以下是之前对话的压缩摘要：\n${summaryText}`,
    }

    const newMessages = [summaryMessage, ...filteredRecentMessages]
    const afterTokens = estimateTotalContextTokens(newMessages, systemPrompt)

    return {
        messages: newMessages,
        summary: summaryText,
        beforeTokens,
        afterTokens,
        savedTokens: beforeTokens - afterTokens,
        compactedMessages: actualCompressed.length,
        preservedInfo: [],
    }
}

/**
 * 检查消息列表中是否已存在压缩边界
 */
export function hasCompactBoundary(messages: ChatMessage[]): boolean {
    return messages.some(msg =>
        msg.role === 'system' &&
        typeof msg.content === 'string' &&
        msg.content.includes('[Earlier conversation has been compacted')
    )
}

/**
 * 获取压缩边界之后的消息
 */
export function getMessagesAfterCompactBoundary(messages: ChatMessage[]): ChatMessage[] {
    const boundaryIndex = messages.findIndex(msg =>
        msg.role === 'system' &&
        typeof msg.content === 'string' &&
        msg.content.includes('[Earlier conversation has been compacted')
    )

    if (boundaryIndex === -1) {
        return messages
    }

    return messages.slice(boundaryIndex + 1)
}
