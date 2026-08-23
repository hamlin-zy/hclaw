/**
 * Token 估算工具
 *
 * 简单字符/token 估算（chars/4 近似），供上下文 token 估算与日志诊断使用。
 * 复杂度可控，无需引入第三方分词库。
 */

import type {ChatMessage, ContentPart} from './model/types'

/** 平均 4 字符 ≈ 1 token（中英文混合近似值） */
const CHARS_PER_TOKEN = 4

/** 系统提示词估算默认值（无 system prompt 时兜底用） */
const SYSTEM_PROMPT_ESTIMATE = 80_000

/** 图片 token 估算（一张图片约等于 85 个 token，保守估计） */
const IMAGE_TOKEN_ESTIMATE = 85

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
 * 提取最近一次 LLM 请求的真实上下文占用（inputTokens + cacheReadTokens）。
 * 与渲染端窗口徽章同口径（useWindowUsage: currentInputTokens + currentCacheReadTokens）。
 * 无任何 llmStats（新会话/旧数据）→ 0，调用方回退字符估算。
 */
export function resolveLastRequestContextTokens(messages: ReadonlyArray<ChatMessage>): number {
    let tokens = 0
    for (const msg of messages) {
        if (msg.role !== 'assistant') continue
        const statsList = Array.isArray(msg.llmStats) ? msg.llmStats : []
        if (statsList.length === 0) continue
        const last = statsList[statsList.length - 1]
        tokens = (last.inputTokens || 0) + (last.cacheReadTokens || 0)
    }
    return tokens
}

/**
 * 上下文占用 token：优先真实 usage（chars/4 估算对中文严重失真，仅兜底），
 * 无 llmStats 时回退 estimateTotalContextTokens。
 */
export function resolveContextUsageTokens(
    messages: ReadonlyArray<ChatMessage> | ChatMessage[],
    systemPrompt?: string,
): number {
    const real = resolveLastRequestContextTokens(messages)
    if (real > 0) return real
    return estimateTotalContextTokens(messages, systemPrompt)
}
