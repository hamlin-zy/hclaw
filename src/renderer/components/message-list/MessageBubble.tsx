/**
 * 消息气泡组件
 * 单条消息的容器，包含头像、内容和时间戳
 */

import {memo, useEffect, useMemo, useRef, useState} from 'react'
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
/**
 * 徽章降级路径的能力名兜底：通过 command:get-skill-commands / get-agent-commands /
 * get-user-commands IPC 直接读主进程注册表（不经过 powerManager.refresh，
 * 与 Ctrl+K 命令面板同款数据源）。模块级缓存 + 单飞请求，避免每条气泡重复发起 IPC。
 */
interface KnownCapabilityNames {
    skills: string[]
    agents: string[]
    userCommands: string[]
}

let knownCapsCache: KnownCapabilityNames | null = null
let knownCapsPromise: Promise<KnownCapabilityNames> | null = null

function fetchKnownCapabilityNames(): Promise<KnownCapabilityNames> {
    if (knownCapsCache) return Promise.resolve(knownCapsCache)
    if (!knownCapsPromise) {
        const pickNames = (list: Array<{ name?: string }> | undefined | null) =>
            (list ?? []).map(s => s.name).filter((n): n is string => !!n)
        knownCapsPromise = Promise.all([
            window.electronAPI?.command?.getSkillCommands?.().catch(() => []),
            window.electronAPI?.command?.getAgentCommands?.().catch(() => []),
            window.electronAPI?.command?.getUserCommands?.().catch(() => null) as Promise<Array<{ name: string }> | null | undefined>,
        ]).then(([skills, agents, userCmds]) => {
            const result: KnownCapabilityNames = {
                skills: pickNames(skills as Array<{ name?: string }>),
                agents: pickNames(agents as Array<{ name?: string }>),
                userCommands: Array.isArray(userCmds)
                    ? pickNames(userCmds.filter((c: any) => c?.enabled))
                    : [],
            }
            knownCapsCache = result
            return result
        }).catch(() => {
            knownCapsPromise = null  // 失败允许重试
            return {skills: [], agents: [], userCommands: []}
        })
    }
    return knownCapsPromise
}

function useKnownCapabilities() {
    const skills = useSkillStore((s) => s.skills)
    const agents = useAgentTemplateStore((s) => s.templates)
    const commands = useUserCommandStore((s) => s.commands)
    // store 均为空时的兜底（打包版启动时 skills-refresh 可能被主进程挂起阻塞）
    const [fallbackCaps, setFallbackCaps] = useState<KnownCapabilityNames>({skills: [], agents: [], userCommands: []})
    useEffect(() => {
        if (knownCapsCache) return
        if (skills.length > 0 && agents.length > 0 && commands.length > 0) return
        let cancelled = false
        fetchKnownCapabilityNames().then(names => {
            if (!cancelled) setFallbackCaps(names)
        })
        return () => { cancelled = true }
    }, [skills.length, agents.length, commands.length])
    return useMemo(() => ({
        skills: skills.length > 0 ? skills.map(skill => skill.name) : fallbackCaps.skills,
        agents: agents.length > 0 ? agents.map(t => t.name) : fallbackCaps.agents,
        userCommands: commands.length > 0 ? commands.map(c => c.name) : fallbackCaps.userCommands,
    }), [skills, agents, commands, fallbackCaps])
}

interface MessageBubbleProps {
    message: Message
    /**
     * 气泡底部状态注记（时间戳左侧）：阶段（思考中/响应中）/ 重试进度 / 最终错误。
     * 仅由 MessageList 传给"当前最后一条助手消息"，历史消息不携带。
     */
    statusNote?: StatusNoteData | null
    /**
     * agent 是否运行中（running/thinking，含 executing_tools）。
     * 运行中 statusNote 可能短暂为 null（阶段切换间隙）→ StatusNote 容器
     * 从 DOM 移除 → min-w-[16rem] 失效 → 时间戳行收缩 → 气泡回缩。
     * 此标志在行级兜底 min-w-[19rem]（= statusNote 256px + gap 8px + 时间戳 ~40px），
     * 仅运行中生效：statusNote 消失时行宽仍 ≥304px，气泡不缩；
     * 运行结束（done/error/abort）后释放，历史消息不占位。
     */
    isAgentRunning?: boolean
}

// ── statusNote 独立 memo 组件 ──────────────────────────────
// ★ 与气泡内容（思考块/正文流式重画）解耦：流式 text/tool 事件只更新 message，
//   statusNote 引用不变时 React 跳过本组件重渲染，DOM 零触碰 →
//   加载动画/重试 UI 不再被流式渲染干扰（避免闪烁）。
export interface StatusNoteData {
    type: 'retry' | 'error' | 'phase'
    label: string
    urgent?: boolean
}

/**
 * statusNote 内容级比较：type/label/urgent 均相同视为未变化。
 * 流式事件（thinking/text chunk）频繁产生新 agentState 引用 → MessageList 会
 * 重算出新 statusNote 对象；若用默认引用比较，memo 失效导致 StatusNote 随
 * 气泡内容一起重渲染（流式闪烁）。内容级比较保证：文案未变化时 StatusNote
 * 零重渲染、DOM 零触碰——加载动画/重试 UI 彻底与流式渲染解耦。
 */
function statusNoteEqual(
    prev: {note: StatusNoteData | null | undefined},
    next: {note: StatusNoteData | null | undefined},
): boolean {
    const a = prev.note
    const b = next.note
    if (a === b) return true
    if (!a || !b) return false
    return a.type === b.type && a.label === b.label && a.urgent === b.urgent
}

const StatusNote = memo(function StatusNote({note}: {note: StatusNoteData | null | undefined}) {
    // ── 一键复制（错误/重试详情） ──
    const [copied, setCopied] = useState(false)
    const copyTimerRef = useRef<number | null>(null)
    const copyStatusNote = async (text: string) => {
        try {
            await navigator.clipboard.writeText(text)
        } catch {
            // 降级：隐藏 textarea + execCommand（剪贴板权限受限环境）
            const ta = document.createElement('textarea')
            ta.value = text
            ta.style.position = 'fixed'
            ta.style.opacity = '0'
            document.body.appendChild(ta)
            ta.select()
            document.execCommand('copy')
            ta.remove()
        }
        setCopied(true)
        if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current)
        copyTimerRef.current = window.setTimeout(() => setCopied(false), 1500)
    }

    // 卸载时清理复制反馈定时器，避免卸载后 setState（Hooks 需在条件 return 之前）
    useEffect(() => () => {
        if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current)
    }, [])

    if (!note) return null

    return (
        // statusNote 最小宽度（min-w-[16rem]）：消除"宽度太小导致的气泡伸缩"。
        // 短文案（如"思考中"）容器收缩到文案宽度，不浪费空间；典型带模型前缀
        // 文案（210-239px）触到 256px 下限后保持稳定；超长文案（长错误/重试详情）
        // 随内容展开（truncate 兜底）。出现/消失仍各变一次（可接受）。
        <div className="flex items-center gap-1.5 min-w-[16rem] group/status">
            {note.type === 'error' ? (
                <svg className="w-3.5 h-3.5 text-[var(--error)] flex-shrink-0" viewBox="0 0 24 24"
                     fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <circle cx="12" cy="12" r="10"/>
                    <line x1="12" y1="8" x2="12" y2="13"/>
                    <line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
            ) : (
                <svg className="w-3 h-3 animate-spin text-[var(--brand-primary)] flex-shrink-0"
                     viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor"
                            strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor"
                          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
                </svg>
            )}
            <span
                className={`text-[11px] truncate ${
                    note.type === 'error' || note.urgent
                        ? 'text-[var(--error)] font-medium'
                        : 'text-[var(--text-muted)]'
                }`}
            >
                {note.label}
            </span>
            {/* 复制按钮仅对错误/重试详情显示（阶段文案无需复制） */}
            {note.type !== 'phase' && (
                <button
                    onClick={() => copyStatusNote(note.label)}
                    className="flex-shrink-0 p-0.5 rounded opacity-0 group-hover/status:opacity-100 hover:bg-[var(--border-muted)] transition-all cursor-pointer text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                    aria-label="复制错误详情"
                    title="复制错误详情"
                >
                    {copied ? (
                        <svg className="w-3.5 h-3.5 text-[var(--brand-primary)]" viewBox="0 0 24 24"
                             fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                            <polyline points="20 6 9 17 4 12"/>
                        </svg>
                    ) : (
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none"
                             stroke="currentColor" strokeWidth="2" aria-hidden="true">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                        </svg>
                    )}
                </button>
            )}
        </div>
    )
}, statusNoteEqual)

/**
 * 消息气泡组件
 */
const MessageBubble = memo(function MessageBubble({message, statusNote, isAgentRunning}: MessageBubbleProps) {
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
                className={`message-bubble ${isUser ? 'user' : 'assistant'} max-w-[85%] flex flex-col transition duration-200`}>

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

                {/* Note: Tasks block is now displayed in the TodoStrip above the input area, not in message bubbles */}

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

                {/* Timestamp + statusNote（重试/错误提示在时间戳左侧，仅最后一条助手消息） */}
                <hr className="divider"/>
                <div
                    className={`flex items-center gap-2 ${statusNote ? 'justify-between' : 'justify-end'} ${
                        // 行级最小宽度兜底：statusNote 运行中短暂为 null 时（阶段切换间隙/
                        // executing_tools）min-w-[16rem] 随容器移除而失效，行只剩时间戳 → 气泡回缩。
                        // isAgentRunning 期间行宽恒 ≥304px，气泡不缩；运行结束后释放不占位。
                        isAgentRunning ? 'min-w-[19rem]' : ''
                    }`}
                >
                    {/* 独立 memo 组件：流式内容重画不影响本区域（见 StatusNote 定义注释） */}
                    <StatusNote note={statusNote}/>
                    <span className="timestamp shrink-0 whitespace-nowrap">
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
