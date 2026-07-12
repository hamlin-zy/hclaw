/**
 * Token 估算工具
 *
 * 简单字符/token 估算（chars/4 近似），供 truncateForLlmCall 计算 budget 使用。
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
