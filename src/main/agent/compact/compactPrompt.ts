/**
 * 压缩相关提示词
 * 用于生成对话摘要
 *
 * 结构化的三段式输出：
 * - 用户偏好 (User Preferences)
 * - 相关文件 (Related Files)
 * - 改动总结 (Changes Summary)
 * - 关键信息 (Key Information)
 */

import type {ChatMessage} from '../model/types'

function generateId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

const SECTIONS = `
## 用户偏好 (User Preferences)
- Extract any user preferences, habits, or style choices revealed during the conversation
- Examples: coding style, tool preferences, workflow habits, naming conventions

## 相关文件 (Related Files)
- List all file paths that were referenced, created, or modified
- Include brief context for each file (what was done, why it matters)

## 改动总结 (Changes Summary)
- Summarize the key changes, decisions, and outcomes
- Focus on information needed to continue the conversation seamlessly
- Preserve error patterns and solutions found
- Note any important tool operations and their results

## 关键信息 (Key Information)
- Important facts, configurations, or project context
- Decisions made and their rationale
- Pending items or next steps

Guidelines:
- Be thorough but concise
- Focus on information essential for conversation continuity
- Use clear section headers for readability
- Do not include meta-commentary about the summarization process`

/**
 * 生成压缩摘要的系统提示词（新版结构化格式）
 */
export function getCompactPrompt(customInstructions?: string, defaultMaxTokens?: number): string {
    const parts = [
        'You are a conversation summarization assistant. Your task is to create a structured summary of the conversation history.',
        '',
        'Please organize your summary into the following sections:',
        SECTIONS,
    ]

    if (customInstructions) {
        parts.push('', `## 用户额外指令\n${customInstructions}`)
    }

    if (defaultMaxTokens && defaultMaxTokens > 0) {
        parts.push('', `IMPORTANT: Your entire response must not exceed ${defaultMaxTokens} tokens. Keep the summary concise and well-structured.`)
    }

    return parts.join('\n')
}

/**
 * 生成压缩摘要的用户消息内容
 */
export function getCompactUserSummaryMessage(summary: string, transcriptPath?: string): string {
    let message = `## Conversation Summary\n\n${summary}`
    if (transcriptPath) {
        message += `\n\n<details>\n<summary>Earlier conversation</summary>\n\nPrevious messages are stored in transcript at: ${transcriptPath}\n</details>`
    }
    return message
}

/**
 * 压缩边界元数据
 */
export interface CompactBoundaryMetadata {
    type: 'compact_boundary'
    compactType: 'auto' | 'manual'
    preCompactTokenCount: number
    lastMessageId?: string
}

/**
 * 创建压缩边界消息
 */
export function createCompactBoundaryMessage(
    compactType: 'auto' | 'manual',
    preCompactTokenCount: number,
    lastMessageId?: string,
): ChatMessage {
    return {
        id: generateId(),
        role: 'system',
        content: `[Earlier conversation has been compacted. Original token count: ${preCompactTokenCount}]`,
        timestamp: Date.now(),
        metadata: {
            compactBoundary: {
                type: 'compact_boundary',
                compactType,
                preCompactTokenCount,
                lastMessageId,
            } as CompactBoundaryMetadata,
        },
    } as ChatMessage
}
