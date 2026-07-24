/**
 * 紧凑模式 Popup 组件
 * 弹出浮层展示工具调用列表，每个卡片默认折叠
 *
 * 全局单例，在 App.tsx 中渲染，跟随会话自动切换。
 * 位置/拖拽使用公共 useDraggableDialog hook。
 */

import {memo, useEffect, useMemo} from 'react'
import {AnimatePresence, motion} from 'framer-motion'
import {useToolCallsStore} from '../../../stores/toolCallsStore'
import {useAgentStore} from '../../../stores/agentStore'
import {useDraggableDialog} from '../../../hooks/useDraggableDialog'
import {truncate} from '../../../lib/format'
import {PopupToolCard} from './PopupToolCard'
import {StreamEntryCard, mergeTimeline, getLastActiveTime} from '../StreamEntryRenderer'
import MarkdownRenderer from '../MarkdownRenderer'

/**
 * 紧凑模式 Popup — 全局单例
 */
const CompactToolPopup = memo(function CompactToolPopup() {
    const toolPopupData = useAgentStore((s) => s.toolPopupData)
    const closeToolPopup = useAgentStore((s) => s.closeToolPopup)
    const updateToolPopupExpanded = useAgentStore((s) => s.updateToolPopupExpanded)

    // ★ 所有 hooks 无条件声明
    const {dialogRef, position, isDragging, handleDragStart} = useDraggableDialog({visible: !!toolPopupData})
    const toolStates = useToolCallsStore((s) => s.states)

    // expandedCardIds 需要无条件读取，供下面的 useMemo 使用
    const expandedCardIds = toolPopupData?.expandedCardIds
    const expandedSet = useMemo(() => new Set(expandedCardIds || []), [expandedCardIds])

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') closeToolPopup()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [closeToolPopup])

    if (!toolPopupData) return null

    const {toolCalls, title, isAgent, agentDisplayName, agentTypeLabel} = toolPopupData

    const handleCardToggle = (id: string) => {
        const next = expandedSet.has(id)
            ? (expandedCardIds || []).filter((x: string) => x !== id)
            : [...(expandedCardIds || []), id]
        updateToolPopupExpanded(next)
    }

    const displayTitle = title || '工具调用详情'
    const POPUP_WIDTH = 520

    return (
        <AnimatePresence>
            <motion.div
                initial={{opacity: 0}}
                animate={{opacity: 1}}
                exit={{opacity: 0}}
                className="fixed z-[10000] pointer-events-none"
                style={{left: 0, top: 0, width: '100vw', height: '100vh'}}
            >
                <motion.div
                    ref={dialogRef}
                    initial={{scale: 0.95, opacity: 0}}
                    animate={{scale: 1, opacity: 1}}
                    exit={{scale: 0.95, opacity: 0}}
                    transition={{duration: 0.15, ease: 'easeOut'}}
                    className={`absolute pointer-events-auto bg-[var(--surface)] rounded-2xl flex flex-col overflow-hidden shadow-2xl transition-shadow duration-100 border border-[var(--border)] ${
                        isDragging ? 'shadow-overlay scale-[1.02]' : ''
                    }`}
                    style={{left: position.x, top: position.y, width: `${POPUP_WIDTH}px`, maxHeight: '75vh'}}
                >
                    <div onMouseDown={handleDragStart} onTouchStart={handleDragStart}
                        className={`flex items-center justify-between px-4 py-3 border-b border-[var(--border)] shrink-0 select-none ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}>
                        <h4 className="text-[13px] font-medium text-[var(--text-primary)] flex items-center gap-2 min-w-0 flex-1">
                            {isAgent && <span className="text-[var(--brand-primary)] shrink-0">⚡</span>}
                            <span className="truncate">{displayTitle}</span>
                            {!isAgent && <span className="text-[10px] text-[var(--text-muted)] font-normal shrink-0">{toolCalls.length} 个调用</span>}
                        </h4>
                        <button onClick={closeToolPopup}
                            className="w-6 h-6 rounded-md flex items-center justify-center text-[var(--text-muted)] hover:bg-white/[0.08] hover:text-[var(--text-primary)] transition-colors cursor-pointer">✕</button>
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
                                                <span className="text-[var(--brand-primary)]">⚡</span>
                                                <span className="text-[var(--text-muted)] font-normal">agent</span>
                                                {agentTypeLabel && (
                                                    <span className="text-[10px] font-medium text-[var(--brand-primary)] bg-[var(--brand-muted)]/30 px-1.5 py-0.5 rounded shrink-0">
                                                        {agentTypeLabel}
                                                    </span>
                                                )}
                                                <span className="font-semibold text-[var(--text-primary)] truncate flex-1">{agentDisplayName || '子 Agent'}</span>
                                                {/* 动态刷新文本（运行时进度文本，与 ToolCallHeader 的 progressText 一致） */}
                                                {state?.progress && ['running', 'pending'].includes(status) && (
                                                    <span className="text-[11px] text-[var(--brand-primary)] px-1.5 py-0 border-l border-[rgba(74,158,255,0.15)] truncate animate-pulse">
                                                        {state.progress.replace(/^子 Agent /, '')}
                                                    </span>
                                                )}
                                                <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${
                                                    status === 'success' ? 'bg-[var(--success-muted)]/30 text-[var(--success)]'
                                                        : status === 'error' ? 'bg-[var(--error-muted)]/30 text-[var(--error)]'
                                                            : 'bg-[var(--info-muted)]/30 text-[var(--info)]'
                                                }`}>{status === 'success' ? '已完成' : status === 'error' ? '失败' : '进行中'}</span>
                                            </div>
                                            {(() => {
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
                                            {result?.output && <div className="mt-2 text-[10px] text-[var(--text-primary)] leading-relaxed p-2 bg-[var(--surface-overlay)] rounded max-h-48 overflow-x-hidden overflow-y-auto break-all select-text"><MarkdownRenderer>{truncate(String(result.output), 3000)}</MarkdownRenderer></div>}
                                            {result?.error && <pre className="mt-2 text-[10px] text-[var(--error)] font-mono whitespace-pre-wrap break-all leading-relaxed p-2 bg-[var(--error-muted)]/15 rounded max-h-48 overflow-x-hidden overflow-y-auto select-text">{String(result.error)}</pre>}
                                        </div>
                                    )
                                })}
                            </div>
                        ) : (
                            <div className="space-y-0.5">
                                <div className="text-[9px] text-[var(--text-muted)] px-2 py-1 border-b border-[var(--border)] mb-2">执行顺序 ↓</div>
                                {toolCalls.map((tc: any, i: number) => (
                                    <PopupToolCard key={tc.id} toolCall={tc} index={i}
                                        expanded={expandedSet.has(tc.id)} onToggle={handleCardToggle}/>
                                ))}
                            </div>
                        )}
                    </div>

                    <div className="flex justify-end px-3 py-2 border-t border-[var(--border)] shrink-0">
                        <button onClick={closeToolPopup}
                            className="px-3 py-1 text-[10px] rounded-md bg-[var(--surface-muted)] text-[var(--text-muted)] hover:bg-[var(--surface-elevated)] transition-colors cursor-pointer">关闭</button>
                    </div>
                </motion.div>
            </motion.div>
        </AnimatePresence>
    )
})

export default CompactToolPopup
