/**
 * 紧凑模式 Popup 组件
 * 弹出浮层展示工具调用列表，每个卡片默认折叠
 *
 * 全局单例，在 App.tsx 中渲染，跟随会话自动切换。
 * 位置/拖拽使用公共 useDraggableDialog hook。
 */

import {memo, useEffect, useMemo} from 'react'
import {AnimatePresence, motion} from 'framer-motion'
import {fade, scaleFade} from '../../../lib/motionPresets'
import {useToolCallsStore} from '../../../stores/toolCallsStore'
import {useAgentStore} from '../../../stores/agentStore'
import {useConversationStore} from '../../../stores/conversationStore'
import {useDraggableDialog} from '../../../hooks/useDraggableDialog'
import {truncate} from '../../../lib/format'
import {PopupToolCard} from './PopupToolCard'
import {buildDisplaySegments, resolveToolCallsByAnchor} from '../utils/displaySegments'
import {StreamEntryCard, mergeTimeline, getLastActiveTime} from '../StreamEntryRenderer'
import MarkdownRenderer from '../MarkdownRenderer'
import {AgentIcon, RemoveIcon, SkillIcon} from '../../icons'

/**
 * 状态徽章 class（success / error / 其它）。两处调用点共用同一配色口径。
 * 仅收敛 class 三元；徽章文案三元仍由各调用点自持（口径不同，勿合并）。
 */
function statusBadgeClass(status: string): string {
    const tone = status === 'success' ? 'bg-[var(--success-muted)] text-[var(--success)]'
        : status === 'error' ? 'bg-[var(--error-muted)] text-[var(--error)]'
            : 'bg-[var(--info-muted)] text-[var(--info)]'
    return `text-[9px] px-1.5 py-0.5 rounded-full ${tone}`
}

/**
 * 紧凑模式 Popup — 全局单例
 */
const CompactToolPopup = memo(function CompactToolPopup() {
    const toolPopupData = useAgentStore((s) => s.toolPopupData)
    const closeToolPopup = useAgentStore((s) => s.closeToolPopup)
    const updateToolPopupExpanded = useAgentStore((s) => s.updateToolPopupExpanded)
    const setActiveConversation = useConversationStore((s) => s.setActiveConversation)

    // ★ 所有 hooks 无条件声明
    const {dialogRef, position, isDragging, handleDragStart} = useDraggableDialog({visible: !!toolPopupData})
    const toolStates = useToolCallsStore((s) => s.states)

    // expandedCardIds 需要无条件读取，供下面的 useMemo 使用
    const expandedCardIds = toolPopupData?.expandedCardIds
    const expandedSet = useMemo(() => new Set(expandedCardIds || []), [expandedCardIds])

    // ★ 实时重推导（pull 模型）：按 anchor 从会话最新消息重算工具调用集，
    //   修复「打开后新出现的工具调用永不渲染」；找不到 anchor 时回退快照。
    const convId = toolPopupData?.convId
    const messageId = toolPopupData?.messageId
    const anchorToolCallId = toolPopupData?.anchorToolCallId
    const anchorBlockId = toolPopupData?.anchorBlockId
    const convMsgs = useConversationStore((s) => (convId ? s.messagesMap[convId] : undefined))
    const liveMessage = useMemo(() => {
        if (!messageId || !convMsgs) return null
        return convMsgs.find((m) => m.id === messageId) || null
    }, [messageId, convMsgs])
    const derived = useMemo(
        () => (liveMessage
            ? resolveToolCallsByAnchor(buildDisplaySegments(liveMessage, true), {toolCallId: anchorToolCallId, blockId: anchorBlockId})
            : null),
        [liveMessage, anchorToolCallId, anchorBlockId],
    )

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') closeToolPopup()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [closeToolPopup])

    if (!toolPopupData) return null

    const {toolCalls: snapshotToolCalls, title, isAgent, agentDisplayName, agentTypeLabel, isSkill, skillDisplayName} = toolPopupData
    // ★ L2 弹窗实时重推导：优先使用从最新消息按 anchor 解析出的工具调用集，回退快照
    const toolCalls = derived ?? snapshotToolCalls

    const handleCardToggle = (id: string) => {
        const next = expandedSet.has(id)
            ? (expandedCardIds || []).filter((x: string) => x !== id)
            : [...(expandedCardIds || []), id]
        updateToolPopupExpanded(next)
    }

    // 跳转到子会话：优先取运行时 taskId（toolPopupData 是打开时的快照，运行中才补写的
    // taskId 只存在于 toolCallsStore），再回退到 toolCall 静态 taskId
    const handleJumpToSession = (tc: any) => {
        const state = toolStates[tc.id]
        const runtimeTaskId = state?.taskId ?? tc.taskId
        if (runtimeTaskId) setActiveConversation(runtimeTaskId)
    }

    const displayTitle = title || '工具调用详情'
    const POPUP_WIDTH = 520

    return (
        <AnimatePresence>
            <motion.div
                {...fade}
                className="fixed z-[10000] pointer-events-none"
                style={{left: 0, top: 0, width: '100vw', height: '100vh'}}
            >
                <motion.div
                    ref={dialogRef}
                    {...scaleFade}
                    transition={{duration: 0.15, ease: 'easeOut'}}
                    className={`absolute pointer-events-auto bg-[var(--surface)] rounded-2xl flex flex-col overflow-hidden shadow-2xl transition-shadow duration-100 border border-[var(--border)] ${
                        isDragging ? 'shadow-overlay scale-[1.02]' : ''
                    }`}
                    style={{left: position.x, top: position.y, width: `${POPUP_WIDTH}px`, maxHeight: '75vh'}}
                >
                    <div onMouseDown={handleDragStart} onTouchStart={handleDragStart}
                        className={`flex items-center justify-between px-4 py-3 border-b border-[var(--border-muted)] shrink-0 select-none ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}>
                        <h4 className="text-[13px] font-medium text-[var(--text-primary)] flex items-center gap-2 min-w-0 flex-1">
                            {isAgent && <AgentIcon className="w-4 h-4 shrink-0 [color:var(--brand-primary)]"/>}
                            {isSkill && <SkillIcon className="w-4 h-4 shrink-0 [color:var(--brand-primary)]"/>}
                            <span className="truncate">{displayTitle}</span>
                            {!isAgent && !isSkill && <span className="text-[10px] text-[var(--text-muted)] font-normal shrink-0">{toolCalls.length} 个调用</span>}
                        </h4>
                        <button onClick={closeToolPopup}
                            className="w-6 h-6 rounded-md flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--surface-overlay)] hover:text-[var(--text-primary)] transition-colors cursor-pointer" data-name="compact-popup-button"><RemoveIcon className="w-4 h-4"/></button>
                    </div>

                    <div className="flex-1 overflow-y-auto px-3 py-3">
                        {isAgent ? (
                            <div className="space-y-1">
                                {toolCalls.map((tc: any) => {
                                    const state = toolStates[tc.id]
                                    const progressLog = state?.progressLog
                                    const subAgentStream = state?.subAgentStream
                                    const result = state?.result ?? tc.result
                                    const status = state?.status ?? tc.status
                                    return (
                                        <div key={tc.id} className="rounded-lg border border-[rgba(74,158,255,0.15)] bg-[rgba(74,158,255,0.04)] p-3">
                                            <div className="flex items-center gap-2 mb-2 text-[11px]">
                                                <AgentIcon className="w-3.5 h-3.5 shrink-0 [color:var(--brand-primary)]"/>
                                                <span className="text-[var(--text-muted)] font-normal">Agent</span>
                                                {agentTypeLabel && (
                                                    <span className="text-[10px] font-medium text-[var(--text-brand)] bg-[var(--brand-muted)] px-1.5 py-0.5 rounded shrink-0">
                                                        {agentTypeLabel}
                                                    </span>
                                                )}
                                                <span className="font-semibold text-[var(--text-primary)] truncate flex-1">{agentDisplayName || '子 Agent'}</span>
                                                {/* 动态刷新文本（运行时进度文本，与 ToolCallHeader 的 progressText 一致） */}
                                                {state?.progress && ['running', 'pending'].includes(status) && (
                                                    <span className="text-[11px] text-[var(--text-brand)] px-1.5 py-0 border-l border-[rgba(74,158,255,0.15)] truncate animate-pulse">
                                                        {state.progress.replace(/^子 Agent /, '')}
                                                    </span>
                                                )}
                                                <span className={statusBadgeClass(status)}>{status === 'success' ? '已完成' : status === 'error' ? '失败' : '进行中'}</span>
                                                {(state?.taskId || tc.taskId) && (
                                                    <button
                                                        onClick={() => handleJumpToSession(tc)}
                                                        className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium hover:bg-[var(--surface-muted)] border border-[var(--border)] shrink-0"
                                                        style={{color: 'var(--text-brand)'}}
                                                        title="跳转到子会话"
                                                     data-name="compact-popup-jump-to-session-button">
                                                        <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                                                            <polyline points="15 3 21 3 21 9"/>
                                                            <line x1="10" y1="14" x2="21" y2="3"/>
                                                        </svg>
                                                        跳转
                                                    </button>
                                                )}
                                            </div>
                                            {/* ★ 已完成 Agent 只展示最终输出，不展示思考/工具执行过程细节；
                                                仅运行中保留实时进度时间轴 */}
                                            {(['running', 'pending'].includes(status)) && (() => {
                                                const entries = mergeTimeline(progressLog || [], subAgentStream || [])
                                                const lastTime = getLastActiveTime(progressLog || [], subAgentStream || [])
                                                if (entries.length === 0) return null
                                                return (
                                                    <div className="space-y-0.5">
                                                        {entries.map((e, idx) => {
                                                            const isLast = (e.kind === 'progress' ? e.log.timestamp : e.entry.timestamp) === lastTime
                                                            if (e.kind === 'progress') {
                                                                return (
                                                                    <div key={`p-${idx}`} className="flex items-start gap-2 pl-4 py-1 text-[10px]">
                                                                        <span className="text-[var(--info)] mt-0.5 shrink-0">●</span>
                                                                        <span className={`flex-1 break-all ${isLast ? 'text-[var(--info)]' : 'text-[var(--text-secondary)]'}`}>
                                                                            {e.log.text.replace(/^子 Agent /, '')}
                                                                        </span>
                                                                    </div>
                                                                )
                                                            }
                                                            return (
                                                                <StreamEntryCard key={`s-${idx}`} entry={e.entry} variant="popup" />
                                                            )
                                                        })}
                                                    </div>
                                                )
                                            })()}
                                            {/* agent 工具：子 Agent 工作报告不截断（完整保留，容器可滚动） */}
                                            {result?.output && <div className="mt-2 text-[10px] text-[var(--text-primary)] leading-relaxed p-2 bg-[var(--surface-overlay)] rounded max-h-48 overflow-x-hidden overflow-y-auto break-all select-text"><MarkdownRenderer>{String(result.output)}</MarkdownRenderer></div>}
                                            {result?.error && <pre className="mt-2 text-[10px] text-[var(--error)] font-mono whitespace-pre-wrap break-all leading-relaxed p-2 bg-[var(--error-muted)] rounded max-h-48 overflow-x-hidden overflow-y-auto select-text">{String(result.error)}</pre>}
                                        </div>
                                    )
                                })}
                            </div>
                        ) : isSkill ? (
                            <div className="space-y-1">
                                {toolCalls.map((tc: any) => {
                                    const state = toolStates[tc.id]
                                    const result = state?.result ?? tc.result
                                    const status = state?.status ?? tc.status
                                    return (
                                        <div key={tc.id} className="rounded-lg border border-[rgba(59,130,246,0.15)] bg-[rgba(59,130,246,0.04)] p-3">
                                            <div className="flex items-center gap-2 mb-2 text-[11px]">
                                                <SkillIcon className="w-3.5 h-3.5 shrink-0 [color:var(--brand-primary)]"/>
                                                <span className="text-[var(--text-muted)] font-normal">Skill</span>
                                                <span className="font-semibold text-[var(--text-primary)] truncate flex-1">{skillDisplayName || '技能'}</span>
                                                <span className={statusBadgeClass(status)}>{status === 'success' ? '已完成' : status === 'error' ? '失败' : '进行中'}</span>
                                            </div>
                                            {result?.output && <div className="mt-2 text-[10px] text-[var(--text-primary)] leading-relaxed p-2 bg-[var(--surface-overlay)] rounded max-h-48 overflow-x-hidden overflow-y-auto break-all select-text"><MarkdownRenderer>{truncate(String(result.output), 3000)}</MarkdownRenderer></div>}
                                            {result?.error && <pre className="mt-2 text-[10px] text-[var(--error)] font-mono whitespace-pre-wrap break-all leading-relaxed p-2 bg-[var(--error-muted)] rounded max-h-48 overflow-x-hidden overflow-y-auto select-text">{String(result.error)}</pre>}
                                        </div>
                                    )
                                })}
                            </div>
                        ) : (
                            <div className="space-y-0.5">
                                <div className="text-[9px] text-[var(--text-secondary)] px-2 py-1 border-b border-[var(--border-muted)] mb-2">执行顺序 ↓</div>
                                {toolCalls.map((tc: any, i: number) => (
                                    <PopupToolCard key={tc.id} toolCall={tc} index={i}
                                        expanded={expandedSet.has(tc.id)} onToggle={handleCardToggle}/>
                                ))}
                            </div>
                        )}
                    </div>

                    <div className="flex justify-end px-3 py-2 border-t border-[var(--border-muted)] shrink-0">
                        <button onClick={closeToolPopup}
                            className="px-3 py-1 text-[10px] rounded-md bg-[var(--surface-muted)] text-[var(--text-secondary)] hover:bg-[var(--surface-overlay)] transition-colors cursor-pointer" data-name="compact-popup-close-button">关闭</button>
                    </div>
                </motion.div>
            </motion.div>
        </AnimatePresence>
    )
})

export default CompactToolPopup
