/**
 * LLM 调用前的截断编排
 *
 * 流程：
 *   1. 解析 model max context（ModelScheme > adapter 表 > 默认 128k）
 *   2. 估算 budget = maxContext - systemPromptTokens - defaultMaxTokens - buffer
 *   3. 估算 messages 当前 tokens
 *   4. 若 current ≤ budget → passthrough（直接返回原消息）
 *   5. 否则 → structuredTruncateMessages(messages, {keepRecentTurns: 10})
 *
 * 调用时机：每次 LLM 调用前，预算超出后调用本函数收敛到预算内。
 */

import type {ChatMessage} from '../model/types'
import {estimateMessagesTokens, estimateTokens} from '../context'
import {structuredTruncateMessages} from './structuredTruncation'
import {resolveMaxContextTokens} from './modelMaxContext'

export interface TruncateForLlmInput {
    messages: ChatMessage[]
    systemPrompt: string
    modelConfig: {provider: string; model: string; maxContextTokens?: number}
    settings?: {model?: {defaultMaxTokens?: number}}
    modelScheme?: {maxContextTokens?: number} | null
    /** 预留 buffer tokens（默认 10000） */
    reserveBufferTokens?: number
    /** 结构感知截断的最近轮数（默认 10） */
    keepRecentTurns?: number
}

export interface TruncateForLlmResult {
    messages: ChatMessage[]
    action: 'passthrough' | 'structured_truncate'
    tokenEstimate: {
        /** 可用预算（maxContext - 各种 reserve） */
        budget: number
        /** 输入消息总 tokens */
        messagesTokens: number
        /** system prompt tokens */
        systemPromptTokens: number
    }
}

const DEFAULT_RESERVE_BUFFER = 10000
const DEFAULT_KEEP_RECENT_TURNS = 10
const DEFAULT_OUTPUT_MAX_TOKENS = 8000

export function truncateForLlmCall(input: TruncateForLlmInput): TruncateForLlmResult {
    const {
        messages,
        systemPrompt,
        modelConfig,
        settings,
        modelScheme,
        reserveBufferTokens = DEFAULT_RESERVE_BUFFER,
        keepRecentTurns = DEFAULT_KEEP_RECENT_TURNS,
    } = input

    const maxContext = resolveMaxContextTokens({
        provider: modelConfig.provider,
        model: modelConfig.model,
        modelScheme: modelScheme ?? null,
        adapterInfo: {maxContextTokens: modelConfig.maxContextTokens ?? 0},
    })

    const systemPromptTokens = estimateTokens(systemPrompt)
    const outputReserve = settings?.model?.defaultMaxTokens ?? DEFAULT_OUTPUT_MAX_TOKENS
    const budget = Math.max(0, maxContext - outputReserve - reserveBufferTokens - systemPromptTokens)
    const messagesTokens = estimateMessagesTokens(messages)

    if (messagesTokens <= budget) {
        return {
            messages,
            action: 'passthrough',
            tokenEstimate: {budget, messagesTokens, systemPromptTokens},
        }
    }

    const structured = structuredTruncateMessages(messages, {keepRecentTurns})

    return {
        messages: structured.messages,
        action: 'structured_truncate',
        tokenEstimate: {budget, messagesTokens, systemPromptTokens},
    }
}
