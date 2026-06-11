/**
 * Agent 循环 — 压缩与事件
 *
 * 包含：
 * - 压缩命令执行（手动 /compact）
 * - 自动触发压缩（token 阈值）
 * - LLM 调用完成事件
 * - 无工具调用处理
 */

import type {AgentStreamEvent} from '../stream'
import type {ChatMessage} from '../model/types'
import type {LoopState as AgentLoopState} from '../state'
import type {RunParams} from './types'

import {logger} from '../logger'
import {extractTextContent} from '../utils/contentUtils'
import {compressConversation, estimateMessagesTokens, estimateTotalContextTokens} from '../context'
import {taskStore} from '../tasks/taskStore'
import {hookExecutor} from '../../plugin/hooks'
import {formatTokenCount, endTurnCleanup} from './helpers'

// ═══════════════════════════════════════════════════════════
//  压缩命令执行
// ═══════════════════════════════════════════════════════════

/**
 * 执行压缩命令：直接调用 compressConversation 处理（内部 LLM 摘要 + 组装），
 * 不走主循环 LLM 流式调用，避免流式 text 事件传到渲染层造成重复/空消息
 */
export async function* executeCompactCommand(
    state: AgentLoopState,
    systemPrompt: string,
    params: RunParams,
    turns: number,
): AsyncGenerator<AgentStreamEvent, void> {
    const {customInstructions, abortSignal} = params

    try {
        const compacted = await compressConversation(
            [...(state.messages || [])] as ChatMessage[],
            systemPrompt,
            {
                mode: 'manual',
                customInstructions,
                abortSignal,
                pendingTasks: taskStore.getAllTasks(),
            },
        )
        yield* emitCompactPersist(
            compacted.messages,
            compacted.beforeTokens,
            compacted.afterTokens,
            compacted.savedTokens,
            compacted.compactedCount,
            `📦 压缩完成：节省 ${compacted.savedTokens} tokens，压缩了 ${compacted.compactedCount} 条消息`,
        )
        hookExecutor.execute('PostCompact', {sessionId: params.sessionId}).catch(() => {})
        logger.info(`[AgentLoop] loop done turns:${turns} reason:compact_completed`)
        yield {type: 'done', reason: 'completed'}
    } catch (err) {
        logger.warn('[AgentLoop] compressConversation failed:', {error: err as unknown})
        yield {type: 'error', error: `压缩失败: ${(err as Error).message}`}
    }
}

// ═══════════════════════════════════════════════════════════
//  自动触发压缩
// ═══════════════════════════════════════════════════════════

export interface AutoCompressContext {
    state: AgentLoopState
    systemPrompt: string
    isCompactCommand: boolean
    params: RunParams
    /** 上一次 LLM 调用的实际 inputTokens */
    lastActualInputTokens: number
    /** 记录 inputTokens 时的消息数量 */
    messagesAtLLMCall: number
    /** 可变引用：compactLevel */
    compactLevelRef: {value: number}
}

/**
 * 路径 B：自动触发压缩（LLM 摘要，与 /compact 命令共用逻辑）
 *
 * 优先以 API 返回的实际 inputTokens + 新增消息增量估算，
 * 远比纯 chars/4 估算准确
 */
export async function* autoCompressIfNeeded(
    ctx: AutoCompressContext,
): AsyncGenerator<AgentStreamEvent, AgentLoopState> {
    const {state, systemPrompt, isCompactCommand, params, lastActualInputTokens, messagesAtLLMCall, compactLevelRef} = ctx
    const {abortSignal} = params

    const currentTotalTokens =
        lastActualInputTokens > 0
            ? lastActualInputTokens +
              estimateMessagesTokens((state.messages || []).slice(messagesAtLLMCall) as ChatMessage[])
            : estimateTotalContextTokens(state.messages || [], systemPrompt)

    const threshold = params.settings?.agent?.compactThreshold ?? 700_000
    if (isCompactCommand || currentTotalTokens <= threshold) return state

    logger.info(
        `[AgentLoop] auto-trigger compact: currentTotalTokens ${currentTotalTokens} (actual:${lastActualInputTokens}+delta) > threshold ${threshold}`,
    )
    yield {type: 'compact_status', compactStatus: 'compacting'}

    try {
        const compacted = await compressConversation(
            [...(state.messages || [])] as ChatMessage[],
            systemPrompt,
            {mode: 'auto', abortSignal, pendingTasks: taskStore.getAllTasks()},
        )

        if (compacted.wasCompacted) {
            logger.info(`[AgentLoop] auto-compact success: saved ${compacted.savedTokens} tokens`)
            compactLevelRef.value = 0

            yield* emitCompactPersist(
                compacted.messages,
                compacted.beforeTokens,
                compacted.afterTokens,
                compacted.savedTokens,
                compacted.compactedCount,
                `📦 自动压缩完成：节省 ${formatTokenCount(compacted.savedTokens)}，保留了 ${compacted.messages.length} 条消息`,
            )

            hookExecutor.execute('PostCompact', {sessionId: params.sessionId} as any).catch(() => {})

            endTurnCleanup()

            yield {type: 'compact_status', compactStatus: 'completed'}
            const msgs = [...compacted.messages] as ChatMessage[]
            return {...state, messages: msgs}
        }
    } catch (err) {
        logger.warn('[AgentLoop] auto-compact failed:', {error: err as unknown})
        yield {type: 'warning', message: `自动压缩失败: ${(err as Error).message}`}
    }

    yield {type: 'compact_status', compactStatus: 'completed'}
    return state
}

// ═══════════════════════════════════════════════════════════
//  发射 LLM 调用完成事件
// ═══════════════════════════════════════════════════════════

/**
 * 发射 llm_call_done 事件（含输入输出摘要）
 */
export function* emitLlmCallDone(
    turnCount: number,
    state: AgentLoopState,
    lastLoggedMsgCount: number,
    assistantContent: string,
    collectedToolCalls: Array<{id: string; name: string; arguments: Record<string, unknown>}>,
    conversationTitle: string,
    provider: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens: number,
    cacheWriteTokens: number,
    reasoningTokens: number,
    llmDuration: number,
    systemPrompt: string,
): Generator<AgentStreamEvent, void> {
    let inputContent = ''
    if (turnCount === 1) {
        const userMessages = state.messages.filter(m => m.role === 'user')
        const lastUserMsg = userMessages.length > 0 ? userMessages[userMessages.length - 1] : null
        inputContent = lastUserMsg ? extractTextContent(lastUserMsg.content) : ''
    } else {
        const newMessages = state.messages.slice(lastLoggedMsgCount)
        const toolNameMap = new Map<string, string>()
        for (const msg of state.messages) {
            if (msg.role === 'assistant' && msg.toolCalls) {
                for (const tc of msg.toolCalls) {
                    toolNameMap.set(tc.id, tc.name)
                }
            }
        }
        const toolResults = newMessages
            .filter(m => m.role === 'tool')
            .map(m => {
                const toolName = m.toolCallId ? (toolNameMap.get(m.toolCallId) || 'unknown') : 'unknown'
                const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
                return `[tool result: ${toolName}]\n${content.slice(0, 300)}`
            })
            .join('\n\n')
        inputContent = toolResults || '(no new context)'
    }

    let outputContent = assistantContent
    if (collectedToolCalls.length > 0) {
        const toolInfo = collectedToolCalls
            .map(tc => `[tool: ${tc.name}] ${JSON.stringify(tc.arguments).slice(0, 200)}`)
            .join('\n')
        outputContent = assistantContent
            ? `${assistantContent}\n\n--- tool calls ---\n${toolInfo}`
            : `--- tool calls ---\n${toolInfo}`
    }

    const toolCallsInfo = collectedToolCalls.map(tc => ({
        id: tc.id,
        name: tc.name,
        input: tc.arguments,
    }))

    const recentMessages = state.messages.slice(lastLoggedMsgCount).map(msg => {
        const result: {
            role: string;
            content: string;
            toolCalls?: Array<{id: string; name: string; arguments: Record<string, unknown>}>;
            toolCallId?: string;
            toolResult?: string;
        } = {
            role: msg.role,
            content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        }
        if (msg.role === 'assistant' && msg.toolCalls) {
            result.toolCalls = msg.toolCalls.map(tc => ({
                id: tc.id,
                name: tc.name,
                arguments: tc.arguments,
            }))
        }
        if (msg.role === 'tool') {
            result.toolCallId = msg.toolCallId
            result.toolResult = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
        }
        return result
    })

    yield {
        type: 'llm_call_done',
        conversationTitle,
        provider,
        model,
        duration: llmDuration,
        inputTokens,
        outputTokens,
        cacheReadTokens: cacheReadTokens > 0 ? cacheReadTokens : undefined,
        cacheWriteTokens: cacheWriteTokens > 0 ? cacheWriteTokens : undefined,
        reasoningTokens: reasoningTokens > 0 ? reasoningTokens : undefined,
        inputContent: inputContent.slice(0, 500),
        outputContent: outputContent.slice(0, 2000),
        toolCalls: toolCallsInfo,
        messages: recentMessages,
        systemPrompt,
    }
}

// ═══════════════════════════════════════════════════════════
//  无工具调用处理
// ═══════════════════════════════════════════════════════════

/**
 * 处理 LLM 未发起工具调用的情况
 */
export function* handleNoToolCalls(
    assistantContent: string,
    assistantThinking: string,
    assistantReasoningContent: string,
    turns: number,
): Generator<AgentStreamEvent, void> {
    if (!assistantContent && !assistantThinking && !assistantReasoningContent) {
        logger.warn(`[AgentLoop] LLM 返回了空响应（无文本、无思考内容、无工具调用）`)
    }

    logger.debug(`[AgentLoop] end turn ${turns} reason:no_tool_calls`)
    logger.info(`[AgentLoop] loop done turns:${turns} reason:completed`)
    yield {type: 'done', reason: 'completed'}
    endTurnCleanup()
}

// ═══════════════════════════════════════════════════════════
//  小工具方法
// ═══════════════════════════════════════════════════════════

/** 获取最后一条用户消息 */
export function getLastUserMessage(state: AgentLoopState): ChatMessage | null {
    return state.messages && state.messages.length > 0
        ? [...state.messages].reverse().find(m => m.role === 'user') ?? null
        : null
}

/** 发射 compact_persist 事件 */
export function* emitCompactPersist(
    messages: ChatMessage[],
    beforeTokens: number,
    afterTokens: number,
    savedTokens: number,
    compactedMessages: number,
    text: string,
): Generator<AgentStreamEvent, void> {
    yield {
        type: 'compact_persist',
        messages,
        beforeTokens,
        afterTokens,
        savedTokens,
        compactedMessages,
        message: text,
    }
}
