/**
 * 消息气泡组件
 * 单条消息的容器，包含头像、内容和时间戳
 */

import {memo, useMemo} from 'react'
import type {Message} from '@shared/types'
import {useSkillStore} from '../../stores/skillStore'
import {useAgentTemplateStore} from '../../stores/agentTemplateStore'
import {useUserCommandStore} from '../../stores/userCommandStore'
import {formatDuration} from '../../lib/format'
import ThinkBlock from '../ThinkBlock'
import StepsBlock from '../StepsBlock'
import AttachmentPreview from './AttachmentPreview'
import InterleavedContent from './InterleavedContent'
import {AssistantMessageActions, MessageActions} from './MessageActions'
import {SkillBubble} from '../skill/SkillBubble'
import {CommandBadge} from '../CommandBadge'
import {UserCommandBubble, parseUserCommandContext} from './UserCommandBubble'

/**
 * 已知能力名集合（供历史 /能力 消息降级渲染使用）
 * 订阅三个 store，任意一方加载即可为旧消息补全能力名。
 * 派生集合用 useMemo 缓存，仅在 store 原始数据变化时重建，避免每次 render 产生新数组。
 */
function useKnownCapabilities() {
    const skills = useSkillStore((s) => s.skills)
    const agents = useAgentTemplateStore((s) => s.templates)
    const commands = useUserCommandStore((s) => s.commands)
    return useMemo(() => ({
        skills: skills.map(skill => skill.name),
        agents: agents.map(t => t.name),
        userCommands: commands.map(c => c.name),
    }), [skills, agents, commands])
}

interface MessageBubbleProps {
    message: Message
}

/**
 * 消息气泡组件
 */
const MessageBubble = memo(function MessageBubble({message}: MessageBubbleProps) {
    const isUser = message.role === 'user'
    // 已知能力名集合（历史消息 commandId 缺失时降级渲染 /能力 徽章用）
    const knownCapabilities = useKnownCapabilities()
    // 用户命令消息：解析命令上下文（skill/agent/command），渲染为能力徽章 + 任务内容
    const userCmdCtx = isUser ? parseUserCommandContext(message, knownCapabilities) : null
    // 命令消息时隐藏原始文本（已由徽章展示），附件/工具调用仍正常渲染
    const commandTextHidden = {...message, content: ''}

    return (
        <div
            className={`flex ${isUser ? 'justify-end' : 'justify-start'} items-end gap-2 group my-3`}
            role="article"
            aria-label={`${isUser ? '用户' : '助手'}消息`}
            data-name={`message-bubble-row-${isUser ? 'user' : 'assistant'}`}
        >
            {/* 用户消息左侧的操作按钮 - 仅在悬停时显示 */}
            {isUser && (
                <MessageActions message={message}/>
            )}

            {/* 消息气泡 - Glassmorphism 风格 */}
            <div
                data-name="message-bubble"
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

                {/* 用户命令消息 → 能力徽章 + 任务内容（替换 /能力 文本行，纯渲染层） */}
                {userCmdCtx && (
                    <div className="mb-2">
                        <UserCommandBubble ctx={userCmdCtx}/>
                    </div>
                )}

                {/* Interleaved text + tool calls (按 textOffset 交错渲染)
                    命令消息时隐藏原始文本（已由徽章展示），附件/工具调用仍正常渲染 */}
                <InterleavedContent message={userCmdCtx ? commandTextHidden : message} isUser={isUser}/>

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
                                <span>{formatDuration(message.endedAt - message.timestamp)}</span>
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
