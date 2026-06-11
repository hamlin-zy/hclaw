/**
 * 消息操作按钮组件
 * 包含用户消息的重试按钮
 */

import {memo, useCallback, useState} from 'react'
import {useAgentStore} from '../../stores/agentStore'
import {useConversationStore} from '../../stores/conversationStore'
import {confirm} from '../ConfirmDialog'
import type {Message} from '@shared/types'

// 重试按钮组件 - 用于重新执行用户消息
const RetryButton = memo(function RetryButton({message}: { message: Message }) {
    const agentStatus = useAgentStore((s) => s.agentState.status)
    const startAgent = useAgentStore((s) => s.startAgent)
    const isRunning = agentStatus === 'running' || agentStatus === 'thinking'

    const handleRetry = useCallback(async () => {
        if (isRunning) return

        const convId = useConversationStore.getState().activeConversationId
        if (!convId) return

        startAgent({
            conversationId: convId,
            message: message.content || '',
            messageAttachments: message.attachments?.map(a => ({path: a.path || '', name: a.name})) || [],
        })
    }, [isRunning, message, startAgent])

    return (
        <button
            onClick={handleRetry}
            disabled={isRunning}
            className="mb-[22px] flex items-center justify-center w-8 h-8 rounded-full bg-[var(--surface-elevated)] border border-[var(--border)] shadow-sm text-[var(--text-muted)] hover:text-[var(--brand-primary)] hover:border-[var(--brand-primary)] disabled:opacity-40 disabled:cursor-not-allowed transition-all flex-shrink-0"
            title="重试"
            aria-label="重试此消息"
        >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M1 4v6h6"/>
                <path d="M3.51 15a9 9 0 102.13-9.36L1 10"/>
            </svg>
        </button>
    )
})

// 删除按钮组件 - 用于删除单条消息
const DeleteButton = memo(function DeleteButton({message, bottomMargin = 'mb-[22px]'}: { message: Message; bottomMargin?: string }) {
    const [isLoading, setIsLoading] = useState(false)
    const agentStatus = useAgentStore((s) => s.agentState.status)
    const isRunning = agentStatus === 'running' || agentStatus === 'thinking'
    const deleteMessage = useConversationStore((s) => s.deleteMessage)

    const handleDelete = useCallback(async () => {
        console.log('[DeleteButton] handleDelete clicked, messageId:', message.id)
        if (isRunning || isLoading) return

        const confirmed = await confirm({
            title: '确认删除消息',
            message: '确定要删除这条消息吗？\n\n此操作不可撤销！',
            confirmText: '删除',
            cancelText: '取消',
            confirmVariant: 'danger',
            onConfirm: async () => {
                console.log('[DeleteButton] calling deleteMessage, messageId:', message.id)
                // 从 UI 消息列表和数据库删除
                deleteMessage(message.id)
                console.log('[DeleteButton] deleteMessage returned')
            },
        })

        if (!confirmed) {
            console.log('[DeleteButton] user cancelled')
        }
    }, [message.id, isRunning, isLoading, deleteMessage])

    return (
        <button
            onClick={handleDelete}
            disabled={isRunning || isLoading}
            className={`${bottomMargin} flex items-center justify-center w-8 h-8 rounded-full bg-[var(--surface-elevated)] border border-[var(--border)] shadow-sm text-[var(--text-muted)] hover:text-red-500 hover:border-red-500 disabled:opacity-40 disabled:cursor-not-allowed transition-all flex-shrink-0`}
            title="删除"
            aria-label="删除此消息"
        >
            {isLoading ? (
                <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin"/>
            ) : (
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M3 6h18"/>
                    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>
                    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
                </svg>
            )}
        </button>
    )
})

// 复制按钮组件 - 用于复制助手消息内容（含工具调用命令和响应）
const CopyButton = memo(function CopyButton({message}: { message: Message }) {
    const [copied, setCopied] = useState(false)

    const handleCopy = useCallback(async () => {
        const parts: string[] = []

        // 1. 主文本内容
        const content = message.content || ''
        const textContent = Array.isArray(content)
            ? content.filter(c => c.type === 'text').map(c => c.text).join('\n')
            : content
        if (textContent.trim()) {
            parts.push(textContent.trim())
        }

        // 2. 工具调用及结果
        if (message.toolCalls && message.toolCalls.length > 0) {
            const toolLines: string[] = []
            for (const tc of message.toolCalls) {
                const args = tc.arguments as Record<string, unknown>
                toolLines.push('')

                // 工具名称和状态
                const statusIcon = tc.status === 'success' ? '✓' : tc.status === 'error' ? '✗' : tc.status === 'running' ? '●' : '○'
                toolLines.push(`${statusIcon} 工具: ${tc.name}`)

                // 关键参数（按工具类型展示）
                if (tc.name === 'bash') {
                    const cmd = args.command
                    if (cmd) toolLines.push(`  命令: ${cmd}`)
                } else if (tc.name.startsWith('file_')) {
                    const filePath = args.filePath || args.path
                    if (filePath) toolLines.push(`  文件: ${filePath}`)
                    if (tc.name === 'file_edit' && args.oldString) {
                        toolLines.push(`  修改: ${String(args.oldString).slice(0, 200)}`)
                    }
                } else if (tc.name === 'grep' || tc.name === 'glob') {
                    const pattern = args.pattern
                    if (pattern) toolLines.push(`  搜索: ${pattern}`)
                } else if (tc.name === 'agent') {
                    const task = args.task
                    if (task) toolLines.push(`  任务: ${String(task).slice(0, 200)}`)
                } else if (tc.name === 'skill') {
                    const skill = args.skill || args.name
                    if (skill) toolLines.push(`  技能: ${skill}`)
                } else {
                    // 通用参数
                    const summary = Object.entries(args)
                        .filter(([k]) => k !== 'reason')
                        .map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 100) : JSON.stringify(v).slice(0, 100)}`)
                        .join(', ')
                    if (summary) toolLines.push(`  参数: ${summary}`)
                }

                // reason (LLM 解释为什么调用此工具)
                if (tc.reason) {
                    toolLines.push(`  原因: ${tc.reason}`)
                }

                // 工具结果输出
                if (tc.result) {
                    if (tc.result.output) {
                        const output = String(tc.result.output).trim()
                        if (output) {
                            // 截断过长的输出
                            const truncated = output.length > 1000 ? output.slice(0, 1000) + '\n  ... (输出已截断)' : output
                            toolLines.push(`  └─ 输出:\n${indent(truncated, 6)}`)
                        }
                    }
                    if (tc.result.error) {
                        toolLines.push(`  └─ 错误: ${tc.result.error}`)
                    }
                } else {
                    toolLines.push(`  └─ 状态: ${tc.status || 'pending'}`)
                }
            }

            if (toolLines.length > 0) {
                parts.push('--- 工具调用 ---')
                parts.push(toolLines.join('\n'))
            }
        }

        // 3. contentBlocks 中的额外文本（新格式）
        if (message.contentBlocks && message.contentBlocks.length > 0) {
            const extraTexts = message.contentBlocks
                .filter(cb => cb.type === 'text' && cb.text)
                .map(cb => cb.text!)
            if (extraTexts.length > 0) {
                parts.push(extraTexts.join('\n'))
            }
        }

        const finalText = parts.join('\n\n')

        try {
            await navigator.clipboard.writeText(finalText || textContent)
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
        } catch {
            // 复制失败，静默处理
        }
    }, [message])

    return (
        <button
            onClick={handleCopy}
            className="flex items-center justify-center w-8 h-8 rounded-full bg-[var(--surface-elevated)] border border-[var(--border)] shadow-sm text-[var(--text-muted)] hover:text-[var(--brand-primary)] hover:border-[var(--brand-primary)] transition-all flex-shrink-0"
            title={copied ? '已复制' : '复制'}
            aria-label={copied ? '已复制' : '复制此消息'}
        >
            {copied ? (
                <svg className="w-4 h-4 text-green-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M20 6L9 17l-5-5"/>
                </svg>
            ) : (
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
            )}
        </button>
    )
})

// 导出操作按钮组组件（用户消息）
export const MessageActions = memo(function MessageActions({message}: { message: Message }) {
    return (
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
            <RetryButton message={message}/>
            <DeleteButton message={message} bottomMargin="mb-[22px]"/>
        </div>
    )
})

// 导出助手消息操作按钮组组件
export const AssistantMessageActions = memo(function AssistantMessageActions({message}: { message: Message }) {
    return (
        <div className="flex items-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-200 mb-[22px]">
            <CopyButton message={message}/>
            <DeleteButton message={message} bottomMargin="mb-[0px]"/>
        </div>
    )
})

export {RetryButton, CopyButton, DeleteButton}

/** 为多行文本每行添加缩进 */
function indent(text: string, spaces: number): string {
    const prefix = ' '.repeat(spaces)
    return text.split('\n').map(line => prefix + line).join('\n').trimStart()
}
