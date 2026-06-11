/**
 * 压缩命令执行器
 *
 * 职责：
 * 1. 使用压缩提示词覆盖系统提示词
 * 2. 调用 LLM（不传 tools）
 * 3. 验证输出 token 数
 * 4. 返回压缩结果
 */

import type {ChatMessage} from '../model/types'
import type {SystemSettings, Task} from '@shared/types'
import {assembleCompactedMessages, estimateTotalContextTokens} from '../context'
import {getCompactPrompt} from './compactPrompt'
import {LLM_TIMEOUT_MS, withTimeout} from '../../utils/retry'

export interface CompactCommandResult {
    summary: string
    outputTokens: number
    inputTokens: number
    beforeTokens: number
}

/**
 * 执行压缩命令，调用 LLM 生成对话摘要
 */
export async function executeCompactCommand(
    messages: ChatMessage[],
    systemPrompt: string,
    customInstructions?: string,
    abortSignal?: AbortSignal,
    settings?: SystemSettings,
): Promise<CompactCommandResult> {
    if (!messages?.length) {
        throw new Error('没有可压缩的消息')
    }

    const {createAdapterForContext} = await import('../model/index')
    const beforeTokens = estimateTotalContextTokens(messages, systemPrompt)
    const {adapter} = await createAdapterForContext('background')

    const maxTokens = settings?.model?.defaultMaxTokens ?? 8000
    const rawStream = adapter.chat({
        systemPrompt: getCompactPrompt(customInstructions, maxTokens),
        messages,
        tools: [],
        maxTokens,
        temperature: 0,
        abortSignal,
    })
    const stream = withTimeout(rawStream, settings?.agent?.llmTimeout ?? LLM_TIMEOUT_MS, abortSignal)

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
            throw ('error' in chunk ? (chunk as any).error : undefined) || new Error('LLM Stream Error')
        }
    }

    if (!summary.trim()) {
        throw new Error('压缩命令返回了空摘要')
    }

    return {
        summary: summary.trim(),
        outputTokens,
        inputTokens,
        beforeTokens,
    }
}

/** @deprecated 格式化待完成任务列表（未使用）
function _formatPendingTasks(pendingTasks: Task[]): string {
    const unfinished = pendingTasks.filter(t => t.status === 'pending' || t.status === 'running')
    if (unfinished.length === 0) return ''

    const taskList = unfinished.map(t =>
        `- [${t.status}] ${t.title}${t.description ? `: ${t.description}` : ''}`
    ).join('\n')

    return `\n\n[待完成任务] 以下任务尚未完成，请继续执行：\n${taskList}\n请继续完成上述任务，不要过早结束对话。`
}

/**
 * 格式化待完成任务列表，追加到压缩摘要中
 * 确保 LLM 压缩后知道还有未完成的工作需要继续执行
 */
function formatPendingTasks(pendingTasks: Task[]): string {
    const unfinished = pendingTasks.filter(t => t.status === 'pending' || t.status === 'running')
    if (unfinished.length === 0) return ''

    const taskList = unfinished.map(t =>
        `- [${t.status}] ${t.title}${t.description ? `: ${t.description}` : ''}`
    ).join('\n')

    return `\n\n[待完成任务] 以下任务尚未完成，请继续执行：\n${taskList}\n请继续完成上述任务，不要过早结束对话。`
}

/**
 * 创建压缩后的消息列表
 *
 * 基于 context.ts 中的 assembleCompactedMessages 实现，
 * 用于 /compact 命令路径（LLM 摘要已由执行器生成）。
 *
 * @param pendingTasks - 未完成的任务列表
 */
export function createCompactedMessages(
    summary: string,
    beforeTokens: number,
    allMessages: ChatMessage[],
    pendingTasks?: Task[],
): ChatMessage[] {
    return assembleCompactedMessages(summary, beforeTokens, allMessages, {pendingTasks}).messages
}
