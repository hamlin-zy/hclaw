/**
 * 聚合卡片弹窗组件
 *
 * 在紧凑消息模式下，点击「聚合卡片」按钮后弹出，
 * 在弹窗内按顺序展示思考块和工具调用卡片。
 *
 * 层级关系：
 *   CombinedCardPopup (level-1)
 *     └─ 思考块（可折叠，保持 CollapsibleSection 样式）
 *     └─ 工具子卡片 → 点击 → CompactToolPopup (level-2，即现有的工具详情弹窗)
 */

import {memo, useCallback, useEffect, useMemo, useState} from 'react'
import {AnimatePresence, motion} from 'framer-motion'
import type {ToolCall, ThinkBlock as ThinkBlockType} from '@shared/types'
import {useToolCallsStore} from '../../../stores/toolCallsStore'
import {useAgentStore} from '../../../stores/agentStore'
import {useConversationStore} from '../../../stores/conversationStore'
import {useDraggableDialog} from '../../../hooks/useDraggableDialog'
import MarkdownRenderer from '../MarkdownRenderer'
import type {CombinedItem} from '../ToolCallRenderer'
import {resolveAgentDisplayName, isSkillToolCall, resolveToolDisplayName} from '../utils/messageUtils'

/**
 * 聚合卡片弹窗 — 全局单例
 * 渲染在 App.tsx 中，跟随 combinedPopupData 自动开关
 */
const CombinedCardPopup = memo(function CombinedCardPopup() {
    const combinedPopupData = useAgentStore((s) => s.combinedPopupData)
    const closeCombinedPopup = useAgentStore((s) => s.closeCombinedPopup)
    const openToolPopup = useAgentStore((s) => s.openToolPopup)

    // ★ 订阅直播消息数据，用于实时获取思考块的最新内容
    const convMsgs = useConversationStore((s) =>
        combinedPopupData?.convId ? s.messagesMap[combinedPopupData.convId] : undefined,
    )
    // ★ 订阅当前活跃会话：判断用户是否正通过弹窗在子会话中查看（此时显示「回到父会话」按钮）
    const activeConversationId = useConversationStore((s) => s.activeConversationId)

    // 从会话存储中查找当前消息（实时更新，非快照）
    const liveMessage = useMemo(() => {
        if (!combinedPopupData?.messageId || !convMsgs) return null
        return convMsgs.find(m => m.id === combinedPopupData.messageId) || null
    }, [combinedPopupData?.messageId, convMsgs])

    // ★ 预计算 thinkBlock 查找表，避免渲染循环中每帧 O(n×m) 的 find 调用
    const liveThinkBlockMap = useMemo(() => {
        if (!liveMessage?.contentBlocks) return null
        const map = new Map<string, ThinkBlockType>()
        for (const cb of liveMessage.contentBlocks) {
            if (cb.type === 'think' && cb.thinkBlock && cb.id) {
                map.set(cb.id, cb.thinkBlock)
            }
        }
        return map
    }, [liveMessage?.contentBlocks])

    // ★ 所有 hooks 无条件声明
    const {dialogRef, position, isDragging, handleDragStart} = useDraggableDialog({visible: !!combinedPopupData})

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') closeCombinedPopup()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [closeCombinedPopup])

    // 无条件 hooks，调用方可安全忽略返回值
    // 用于 tool 子卡片点击打开 CompactToolPopup
    const handleOpenToolPopup = useCallback((toolCalls: ToolCall[]) => {
        // 按名称分组统计
        const typeCounts = new Map<string, number>()
        for (const tc of toolCalls) {
            typeCounts.set(tc.name, (typeCounts.get(tc.name) || 0) + 1)
        }
        const typeLabels: string[] = []
        typeCounts.forEach((count, name) => {
            typeLabels.push(`${name} ${count}个`)
        })

        // 检测是否为 Agent 工具（单工具且名称为 agent）
        const isAgent = toolCalls.length === 1 && toolCalls[0].name === 'agent'
        const agentTc = isAgent ? toolCalls[0] : null

        openToolPopup({
            toolCalls,
            title: typeLabels.join(' · '),
            isAgent,
            agentDisplayName: agentTc ? resolveAgentDisplayName(agentTc) : null,
            agentTypeLabel: agentTc ? ((agentTc.arguments as any)?.agentType ?? null) : null,
        })
    }, [openToolPopup])

    // ★ 订阅工具运行时状态：子 Agent 完成后 status/success 变化需驱动标题与子卡片实时刷新
    const toolStates = useToolCallsStore((s) => s.states)

    // 构造弹窗标题 — 合并计算与统计，减少遍历
    const displayTitle = useMemo(() => {
        if (!combinedPopupData) return ''
        const {toolCalls, thinkCount} = combinedPopupData
        const parts: string[] = []
        if (thinkCount > 0) parts.push(`思考 ${thinkCount}`)
        const map = new Map<string, {total: number; success: number; isAgent: boolean; isSkill: boolean}>()
        for (const tc of toolCalls || []) {
            const state = toolStates[tc.id]
            const status = state?.status ?? tc.status
            const displayName = resolveToolDisplayName(tc)
            if (!map.has(displayName)) map.set(displayName, {total: 0, success: 0, isAgent: tc.name === 'agent', isSkill: isSkillToolCall(tc)})
            const entry = map.get(displayName)!
            entry.total++
            if (status === 'success') entry.success++
        }
        map.forEach((v, k) => {
            parts.push(`${v.isAgent ? '🤖' : v.isSkill ? '🛠️' : ''}${k} ${v.success}/${v.total}`
            )
        })
        return parts.join(' · ')
    }, [combinedPopupData, toolStates])

    if (!combinedPopupData) return null

    const {items, toolCalls} = combinedPopupData

    const POPUP_WIDTH = 520

    return (
        <AnimatePresence>
            {combinedPopupData && (
                <motion.div
                    initial={{opacity: 0}}
                    animate={{opacity: 1}}
                    exit={{opacity: 0}}
                    className="fixed z-[9999] pointer-events-none"
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
                        {/* Header */}
                        <div onMouseDown={handleDragStart} onTouchStart={handleDragStart}
                            className={`flex items-center justify-between px-4 py-3 border-b border-[var(--border)] shrink-0 select-none ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}>
                            <h4 className="text-[13px] font-medium text-[var(--text-primary)] flex items-center gap-2 min-w-0 flex-1">
                                <span className="truncate">{displayTitle || '详情'}</span>
                                {toolCalls?.length > 0 && (
                                    <span className="text-[10px] text-[var(--text-muted)] font-normal shrink-0">{toolCalls.length} 个调用</span>
                                )}
                            </h4>
                            {/* 回到父会话：当前活跃会话 ≠ 弹窗父会话（用户跳转到了子会话）时显示 */}
                            {combinedPopupData.convId && activeConversationId !== combinedPopupData.convId && (
                                <button
                                    onClick={() => useConversationStore.getState().setActiveConversation(combinedPopupData.convId ?? null)}
                                    className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium shrink-0 hover:bg-[var(--surface-muted)] border border-[var(--border)] mr-1"
                                    style={{color: 'var(--text-secondary)'}}
                                    title="回到主会话"
                                >
                                    <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                        <path d="M19 12H5"/>
                                        <polyline points="12 19 5 12 12 5"/>
                                    </svg>
                                    主会话
                                </button>
                            )}
                            <button onClick={closeCombinedPopup}
                                className="w-6 h-6 rounded-md flex items-center justify-center text-[var(--text-muted)] hover:bg-white/[0.08] hover:text-[var(--text-primary)] transition-colors cursor-pointer">✕</button>
                        </div>

                        {/* Body */}
                        <div className="flex-1 overflow-y-auto px-3 py-3">
                            {items.map((item: CombinedItem, idx: number) => {
                                if (item.type === 'think' && item.thinkBlock) {
                                    // ★ 从直播消息的 contentBlocks 查找表中获取最新 thinkBlock，回退到弹窗打开时的快照
                                    const liveThinkBlock = liveThinkBlockMap?.get(item.blockId ?? '') ?? item.thinkBlock
                                    return (
                                        <ThinkBlockInPopup
                                            key={item.blockId || `think-${idx}`}
                                            thinkBlock={liveThinkBlock}
                                        />
                                    )
                                }
                                if (item.type === 'tools' && item.toolCalls && item.toolCalls.length > 0) {
                                    return (
                                        <ToolSubCard
                                            key={`tools-${idx}`}
                                            toolCalls={item.toolCalls!}
                                            onOpenToolPopup={handleOpenToolPopup}
                                            onJumpToChild={(childConvId) => {
                                                // 仅切换会话，保留二级弹窗打开（用户可随时切回父会话继续查看）
                                                useConversationStore.getState().setActiveConversation(childConvId)
                                            }}
                                        />
                                    )
                                }
                                return null
                            })}

                            {items.length === 0 && toolCalls?.length > 0 && (
                                <div className="text-xs text-[var(--text-muted)] text-center py-8">
                                    没有内容
                                </div>
                            )}
                        </div>

                        {/* Footer */}
                        <div className="flex justify-end px-3 py-2 border-t border-[var(--border)] shrink-0">
                            <button onClick={closeCombinedPopup}
                                className="px-3 py-1 text-[10px] rounded-md bg-[var(--surface-muted)] text-[var(--text-muted)] hover:bg-[var(--surface-elevated)] transition-colors cursor-pointer">关闭</button>
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    )
})

/**
 * Popup 内的思考块（可折叠）
 */
const ThinkBlockInPopup = memo(function ThinkBlockInPopup({thinkBlock}: {thinkBlock: ThinkBlockType}) {
    const [expanded, setExpanded] = useState(false)
    const isThinking = thinkBlock.status === 'thinking'
    const isEmpty = isThinking && !thinkBlock.content

    return (
        <div className="mb-3">
            <button
                onClick={() => setExpanded(!expanded)}
                className="flex items-center gap-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors cursor-pointer w-full text-left bg-none border-none p-0 font-inherit"
            >
                <svg
                    className={`w-3 h-3 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
                    viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                >
                    <polyline points="9 18 15 12 9 6" />
                </svg>
                <span className="font-medium">思考过程</span>
                {isThinking ? (
                    <span className="w-2 h-2 rounded-full bg-[var(--brand-primary)] animate-pulse"/>
                ) : (
                    <span className="text-2xs text-[var(--success)]">完成</span>
                )}
            </button>

            <AnimatePresence>
                {expanded && (
                    <motion.div
                        initial={{height: 0, opacity: 0}}
                        animate={{height: 'auto', opacity: 1}}
                        exit={{height: 0, opacity: 0}}
                        transition={{duration: 0.2}}
                        className="overflow-hidden"
                    >
                        {isEmpty ? (
                            <div className="flex items-center gap-2 pl-4 mt-2 text-xs text-[var(--brand-primary)]">
                                <span className="w-2 h-2 rounded-full bg-[var(--brand-primary)] animate-pulse"/>
                                正在思考...
                            </div>
                        ) : (
                            <div className="mt-2 pl-4 border-l-2 border-[var(--border-emphasis)] bg-[var(--brand-muted)]/30 rounded-r-lg p-3 max-h-64 overflow-x-hidden overflow-y-auto break-all">
                                <MarkdownRenderer>{thinkBlock.content}</MarkdownRenderer>
                            </div>
                        )}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    )
})

/**
 * Popup 内的工具子卡片
 * 显示工具名称/统计/展开链接，点击后打开 CompactToolPopup
 */
const ToolSubCard = memo(function ToolSubCard({
    toolCalls,
    onOpenToolPopup,
    onJumpToChild,
}: {
    toolCalls: ToolCall[]
    onOpenToolPopup: (toolCalls: ToolCall[]) => void
    /** 跳转子会话回调（由父组件传入，跳转同时关闭二级弹窗） */
    onJumpToChild: (childConvId: string) => void
}) {
    // ★ 订阅工具运行时状态：完成态 status 变化需驱动子卡片统计/圆点实时刷新
    const toolStates = useToolCallsStore((s) => s.states)

    // 统计 & 按名称分组（合并遍历，一轮搞定）
    const {chips, dotClass, isAgentGroup, isRunning, agentTc} = useMemo(() => {
        let error = 0, running = 0
        const typeMap = new Map<string, {total: number; error: number; isAgent: boolean; isSkill: boolean}>()
        for (const tc of toolCalls) {
            const state = toolStates[tc.id]
            const status = state?.status ?? tc.status
            // 全局统计
            if (status === 'error') error++
            else if (status === 'running') running++
            const displayName = resolveToolDisplayName(tc)
            if (!typeMap.has(displayName)) typeMap.set(displayName, {total: 0, error: 0, isAgent: tc.name === 'agent', isSkill: isSkillToolCall(tc)})
            const entry = typeMap.get(displayName)!
            entry.total++
            if (status === 'error') entry.error++
        }
        const isRunning = running > 0
        const hasError = error > 0
        const chips = Array.from(typeMap.entries()).map(([name, v]) => ({name, ...v}))
        const dotClass = isRunning
            ? 'bg-[var(--info)] animate-pulse'
            : hasError
                ? 'bg-[var(--error)]'
                : 'bg-[var(--success)]'
        // 单 agent 工具（跳转按钮只对单个 agent 调用显示）
        const agentTc = toolCalls.length === 1 && toolCalls[0].name === 'agent' ? toolCalls[0] : null
        return {chips, dotClass, isAgentGroup: toolCalls.length > 0 && toolCalls.every(tc => tc.name === 'agent'), isRunning, agentTc}
    }, [toolCalls, toolStates])

    // 运行中工具的动态刷新文本（从 toolCallsStore 实时读取，不能放入 useMemo）
    const runningProgress = useMemo(() => {
        for (const tc of toolCalls) {
            const state = toolStates[tc.id]
            const status = state?.status ?? tc.status
            if ((status === 'running' || status === 'pending') && state?.progress) {
                return state.progress.replace(/^子 Agent /, '')
            }
        }
        return null
    }, [toolCalls, toolStates])

    // ★ agent 工具：运行中点击直接跳转子会话实时观看（流式详情在子会话中展示）；
    //   完成后点击仍打开三级弹窗看完整结果
    const handleCardClick = () => {
        if (agentTc && isRunning) {
            const runtimeTaskId = toolStates[agentTc.id]?.taskId ?? agentTc.taskId
            if (runtimeTaskId) {
                onJumpToChild(runtimeTaskId)
                return
            }
        }
        onOpenToolPopup(toolCalls)
    }

    // 运行时 taskId 从 toolCallsStore 实时读取（弹窗 toolCalls 是打开时的快照，
    // 运行中才补写的 taskId 只存在于运行时状态）
    const runtimeTaskId = agentTc
        ? toolStates[agentTc.id]?.taskId ?? agentTc.taskId
        : undefined
    const handleJumpToChild = (e: React.MouseEvent) => {
        e.stopPropagation()
        if (runtimeTaskId) onJumpToChild(runtimeTaskId)
    }

    return (
        <button
            onClick={handleCardClick}
            className="w-full flex items-center gap-2 px-3 py-2 my-1.5 rounded-lg text-left transition-colors
                border border-[var(--border)] bg-[var(--surface-muted)]
                hover:bg-[var(--surface-elevated)] hover:border-[var(--border-emphasis)] cursor-pointer"
        >
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`}/>

            <span className="flex items-center gap-1.5 text-[11px] min-w-0 flex-1 overflow-hidden">
                {chips.map((chip) => (
                    <span key={chip.name}
                        className="flex items-center gap-1 px-1.5 py-0.5 rounded
                            bg-[rgba(255,255,255,0.05)] text-[var(--text-secondary)] shrink-0"
                    >
                        {chip.isAgent && <span className="text-[var(--brand-primary)] mr-0.5">🤖</span>}
                        {chip.isSkill && <span className="text-[var(--brand-primary)] mr-0.5">🛠️</span>}
                        <span className="font-mono font-semibold">{chip.name}</span>
                        <span className={chip.error > 0 ? 'text-[var(--error)]' : 'text-[var(--success)]'}>
                            {chip.total - chip.error}/{chip.total}
                        </span>
                    </span>
                ))}
                {/* 动态刷新文本（运行时进度，仅运行中/pending 的 Agent 工具） */}
                {runningProgress && (
                    <span className="text-[11px] text-[var(--brand-primary)] border-l border-[rgba(74,158,255,0.15)] pl-1.5 truncate animate-pulse shrink-1 min-w-0">
                        {runningProgress}
                    </span>
                )}
            </span>

            {/* 展开详情：运行中的纯 agent 工具组隐藏（子 Agent 详情在子会话中实时观看，直接跳转） */}
            {!(isAgentGroup && isRunning) && (
                <span className="text-[10px] text-[var(--text-muted)] shrink-0 flex items-center gap-0.5">
                    展开详情
                    <span className="text-[8px]">›</span>
                </span>
            )}
            {/* 跳转到子会话：agent 工具组且有 taskId（运行中或已完成均显示） */}
            {runtimeTaskId && (
                <button
                    onClick={handleJumpToChild}
                    className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium shrink-0
                        hover:bg-[var(--surface-muted)] border border-[var(--border)]"
                    style={{color: 'var(--brand-primary)'}}
                    title="跳转到子会话"
                >
                    <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                        <polyline points="15 3 21 3 21 9"/>
                        <line x1="10" y1="14" x2="21" y2="3"/>
                    </svg>
                    跳转
                </button>
            )}
        </button>
    )
})

export default CombinedCardPopup
