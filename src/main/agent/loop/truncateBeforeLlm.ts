/**
 * LLM 调用前的截断编排
 *
 * v4（2026-12）：移除 token 预算门（第一层），直接走结构化截断。
 *   - 不再依赖 maxContext / budget / token 估算
 *   - ≤ keepRecentTurns+1 轮 → passthrough（结构化截断内部 guard 返回原消息）
 *   - > keepRecentTurns+1 轮 → structured_truncate（v4 工具价值剥离）
 *
 * 调用时机：每次 LLM 调用前。
 */

import type {ChatMessage} from '../model/types'
import {structuredTruncateMessages} from './structuredTruncation'

export interface TruncateForLlmInput {
    messages: ChatMessage[]
    /** 结构感知截断的最近轮数（默认 7） */
    keepRecentTurns?: number
}

export interface TruncateForLlmResult {
    messages: ChatMessage[]
    action: 'passthrough' | 'structured_truncate'
}

const DEFAULT_KEEP_RECENT_TURNS = 7

export function truncateForLlmCall(input: TruncateForLlmInput): TruncateForLlmResult {
    const {messages, keepRecentTurns = DEFAULT_KEEP_RECENT_TURNS} = input

    const result = structuredTruncateMessages(messages, {keepRecentTurns})

    return {
        messages: result.messages,
        action: result.droppedTurns > 0 ? 'structured_truncate' : 'passthrough',
    }
}
