/**
 * 消息气泡组件
 * 单条消息的容器，包含头像、内容和时间戳
 */

import {memo} from 'react'
import type {Message} from '@shared/types'
import ThinkBlock from '../ThinkBlock'
import StepsBlock from '../StepsBlock'
import AttachmentPreview from './AttachmentPreview'
import InterleavedContent from './InterleavedContent'
import {AssistantMessageActions, MessageActions} from './MessageActions'
import {SkillBubble} from '../skill/SkillBubble'
import {CommandBadge} from '../CommandBadge'

interface MessageBubbleProps {
    message: Message
    index: number
    isStreaming?: boolean
}

/**
 * 消息气泡组件
 */
const MessageBubble = memo(function MessageBubble({message, index, isStreaming = false}: MessageBubbleProps) {
    const isUser = message.role === 'user'

    return (
        <div
            className={`flex ${isUser ? 'justify-end' : 'justify-start'} items-end gap-2 group my-3`}
            role="article"
            aria-label={`${isUser ? '用户' : '助手'}消息`}
        >
            {/* 用户消息左侧的操作按钮 - 仅在悬停时显示 */}
            {isUser && (
                <MessageActions message={message}/>
            )}

            {/* 消息气泡 - Glassmorphism 风格 */}
            <div
                className={`message-bubble ${isUser ? 'user' : 'assistant'} max-w-[85%] flex flex-col transition-all duration-200`}>

                {/* Header - 仅助手消息显示 */}
                {!isUser && (
                    <div className="flex items-center gap-1.5 mb-2 pb-2 border-b border-[var(--border-muted)]">
                        <div className="w-5 h-5 rounded-full bg-[var(--brand-muted)] flex items-center justify-center">
                            <svg className="w-3 h-3 text-[var(--brand-primary)]" viewBox="0 0 24 24" fill="none"
                                 stroke="currentColor" strokeWidth="2" aria-hidden="true">
                                <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                                <path d="M2 17l10 5 10-5"/>
                            </svg>
                        </div>
                        <span className="text-xs font-medium text-[var(--brand-primary)]">HClaw</span>
                    </div>
                )}

                {/* Model badge for user messages */}
                {isUser && message.model && (
                    <div className="flex items-center gap-2 mb-2">
                        <div className="flex items-center gap-1.5">
                            <div
                                className="w-4 h-4 rounded bg-gradient-to-br from-[var(--brand-primary)] to-[var(--brand-primary)]/60 flex items-center justify-center">
                                <svg className="w-2.5 h-2.5 text-white" viewBox="0 0 24 24" fill="none"
                                     stroke="currentColor" strokeWidth="3">
                                    <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                                    <path d="M2 17l10 5 10-5"/>
                                </svg>
                            </div>
                            <span className="text-xs font-medium text-[var(--brand-primary)]">HClaw</span>
                        </div>
                    </div>
                )}

                {/* Think block（仅旧格式消息使用；新格式 contentBlocks 由 InterleavedContent 渲染） */}
                {!message.contentBlocks && message.thinkBlock && (
                    <div className="mb-2">
                        <ThinkBlock thinkBlock={message.thinkBlock}
                                    defaultExpanded={message.thinkBlock.status === 'thinking'}/>
                    </div>
                )}

                {/* Note: Tasks block is now displayed in the TodoPanel on the right sidebar, not in message bubbles */}

                {/* Skill Execution block */}
                {message.skillExecution && (
                    <div className="mb-3">
                        <SkillBubble
                            skillName={message.skillExecution.skillName}
                            status={message.skillExecution.status}
                            phase={message.skillExecution.phase}
                            currentStep={message.skillExecution.currentStep}
                            progress={message.skillExecution.progress}
                            references={message.skillExecution.references}
                            script={message.skillExecution.script}
                            logs={message.skillExecution.logs}
                            result={message.skillExecution.result}
                            error={message.skillExecution.error}
                            startTime={message.skillExecution.startTime}
                            endTime={message.skillExecution.endTime}
                        />
                    </div>
                )}

                {/* Command Execution block - 仅助手消息显示 */}
                {!isUser && message.commandExecution && (
                    <div className="mb-3">
                        <CommandBadge
                            commandName={message.commandExecution.commandName}
                            commandArgs={message.commandExecution.commandArgs}
                            status={message.commandExecution.status}
                            commandId={message.commandExecution.commandId}
                        />
                    </div>
                )}

                {/* Steps block */}
                {message.stepsBlock && (
                    <div className="mb-2">
                        <StepsBlock stepsBlock={message.stepsBlock}/>
                    </div>
                )}

                {/* 附件预览 */}
                {message.attachments && message.attachments.length > 0 && (
                    <div className="mb-3">
                        <AttachmentPreview attachments={message.attachments}/>
                    </div>
                )}

                {/* Interleaved text + tool calls (按 textOffset 交错渲染) */}
                <InterleavedContent message={message} isUser={isUser}/>

                {/* Timestamp */}
                <hr className="divider"/>
                <div className="flex items-center justify-end">
                    <span className="timestamp">
                        {message.endedAt ? (
                            <>
                                {new Date(message.timestamp).toLocaleTimeString('zh-CN', {
                                    hour: '2-digit',
                                    minute: '2-digit'
                                })}
                                <span className="mx-0.5 opacity-50">→</span>
                                {new Date(message.endedAt).toLocaleTimeString('zh-CN', {
                                    hour: '2-digit',
                                    minute: '2-digit'
                                })}
                                <span className="mx-1 opacity-50">·</span>
                                <span>{Math.round((message.endedAt - message.timestamp) / 1000)}秒</span>
                            </>
                        ) : (
                            new Date(message.timestamp).toLocaleTimeString('zh-CN', {
                                hour: '2-digit',
                                minute: '2-digit'
                            })
                        )}
                    </span>
                </div>
            </div>

            {/* 助手消息右侧的操作按钮 - 仅在悬停时显示 */}
            {!isUser && (
                <AssistantMessageActions message={message}/>
            )}
        </div>
    )
})

export default MessageBubble
