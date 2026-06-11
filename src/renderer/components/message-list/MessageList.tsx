/**
 * MessageList 主组件
 * 使用 content-visibility 实现原生懒渲染，支持超长消息内容
 */

import {memo, useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {AnimatePresence, motion} from 'framer-motion'
import {useConversationStore} from '../../stores/conversationStore'
import {useAgentStore} from '../../stores/agentStore'
import MessageBubble from './MessageBubble'
import {ThinkingIndicator} from './StatusIndicators'

// ─── 复制提示 Toast ────────────────────────────────────

const CopyToast = memo(function CopyToast({visible}: { visible: boolean }) {
    return (
        <AnimatePresence>
            {visible && (
                <motion.div
                    initial={{opacity: 0, y: -20}}
                    animate={{opacity: 1, y: 0}}
                    exit={{opacity: 0, y: -20}}
                    transition={{duration: 0.2, ease: 'easeOut'}}
                    className="fixed top-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-[var(--surface-elevated)] border border-[var(--border)] shadow-elevated text-sm text-[var(--text-primary)]"
                    role="status"
                    aria-live="polite"
                >
                    <span className="text-[var(--brand-primary)] mr-1.5">✔</span>
                    已复制
                </motion.div>
            )}
        </AnimatePresence>
    )
})

// ─── Welcome Message ─────────────────────────────────────

function WelcomeMessage() {
    return (
        <div className="text-center space-y-4 p-8">
            <div className="flex justify-center mb-4">
                <img
                    src="./icon.png"
                    alt="HClaw"
                    className="w-56 h-56"
                    draggable={false}
                />
            </div>
            <h1 className="text-2xl font-semibold text-[var(--text-primary)]">欢迎使用 HClaw</h1>
            <p className="text-[var(--text-muted)] max-w-md mx-auto">
                智能对话助手，帮助您完成各种任务。开始新的对话吧！
            </p>
        </div>
    )
}

// ─── 导航按钮组件 ─────────────────────────────────────────

const NavButton = memo(function NavButton({
                                              active, onClick, ariaLabel, children,
                                          }: {
    active: boolean
    onClick: () => void
    ariaLabel: string
    children: React.ReactNode
}) {
    return (
        <motion.button
            initial={{opacity: 0, scale: 0.8}}
            animate={{opacity: active ? 1 : 0.3, scale: 1}}
            exit={{opacity: 0, scale: 0.8}}
            transition={{duration: 0.15}}
            onClick={onClick}
            disabled={!active}
            aria-label={ariaLabel}
            className={`w-12 h-12 rounded-full bg-[var(--surface-elevated)] border border-[var(--border)] shadow-elevated flex items-center justify-center transition-all ${
                active
                    ? 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--brand-primary)] cursor-pointer'
                    : 'text-[var(--text-muted)] opacity-30 cursor-default'
            }`}
        >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                 aria-hidden="true">
                {children}
            </svg>
        </motion.button>
    )
})

const LoadMoreTrigger = memo(function LoadMoreTrigger({
                                                          hasMore, loading, onLoadMore, conversationId,
                                                      }: {
    hasMore: boolean; loading: boolean; onLoadMore: () => void; conversationId?: string
}) {
    const ref = useRef<HTMLDivElement>(null)

    useEffect(() => {
        const el = ref.current
        if (!el || !hasMore || loading) return

        const observer = new IntersectionObserver(
            () => {
                if (hasMore && !loading) onLoadMore()
            },
            {rootMargin: '200px 0px 0px 0px'},
        )
        observer.observe(el)
        return () => observer.disconnect()
    }, [hasMore, loading, onLoadMore])

    return (
        <div ref={ref} className="flex items-center justify-center py-4">
            {loading ? (
                <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                    <div
                        className="w-3 h-3 rounded-full border-2 border-[var(--border)] border-t-[var(--brand-primary)] animate-spin"/>
                    加载历史消息...
                </div>
            ) : hasMore ? (
                <button onClick={onLoadMore}
                        className="text-xs text-[var(--text-muted)] hover:text-[var(--brand-primary)] transition-colors cursor-pointer">
                    加载更多历史消息
                </button>
            ) : conversationId ? (
                <div className="text-xs text-[var(--text-muted)] opacity-50">— 已加载全部历史消息 —</div>
            ) : null}
        </div>
    )
})

// ─── 工具函数 ─────────────────────────────────────────────

/**
 * 在容器中查找视口顶部最近的 data-msg-idx 元素索引。
 *
 * 原理：遍历可见 DOM 子元素，用 getBoundingClientRect().top 找到
 * 离容器顶部最近的消息。相比 elementsFromPoint，不依赖浏览器绘制状态，
 * 在 content-visibility: auto 下也能准确定位视口顶部的已渲染元素。
 *
 * 性能：仅遍历视口附近已渲染的元素（content-visibility 的远距离元素
 * 用 offsetTop 快速跳过），一次调用典型耗时 < 0.5ms。
 */
function findViewportTopMsgIdx(container: HTMLElement): number | null {
    const containerRect = container.getBoundingClientRect()
    const wrapper = container.firstElementChild
    if (!wrapper) return null

    let closestIdx: number | null = null
    let closestDist = Infinity

    for (const child of wrapper.children) {
        const attr = child.getAttribute('data-msg-idx')
        if (attr === null) continue

        const childRect = child.getBoundingClientRect()
        // 元素底部明显在容器顶部之上 → 已滚过，跳过
        if (childRect.bottom < containerRect.top - 100) continue
        // 元素顶部已超出容器底部 → 后续元素只会更远，终止
        if (childRect.top > containerRect.bottom) break

        // 找到离容器顶部最近的那个
        const dist = Math.abs(childRect.top - containerRect.top)
        if (dist < closestDist) {
            closestDist = dist
            closestIdx = parseInt(attr, 10)
        }
    }

    return closestIdx
}

// ─── MessageList 主组件 ───────────────────────────────────

export default function MessageList({conversationId}: { conversationId?: string } = {}) {
    const messagesFromMap = conversationId
        ? useConversationStore((s) => s.messagesMap[conversationId] || [])
        : []
    const messages = conversationId ? messagesFromMap : useConversationStore((s) => s.loadedMessages)
    const activeConversationId = useConversationStore((s) => s.activeConversationId)
    const hasMore = conversationId ? useConversationStore((s) => s.hasMoreMap[conversationId] ?? false) : false
    const loadingMore = conversationId ? useConversationStore((s) => s.loadingMoreMap[conversationId] ?? false) : false
    // agent 状态
    const streamingMessageId = useAgentStore((s) => conversationId ? s.convAgentStates[conversationId]?.streamingMessageId ?? null : s.streamingMessageId)

    const containerRef = useRef<HTMLDivElement>(null)
    const [showCopyToast, setShowCopyToast] = useState(false)
    const [showScrollBtn, setShowScrollBtn] = useState(false)
    const [newMsgCount, setNewMsgCount] = useState(0)
    const userScrolledAwayRef = useRef(false)
    // 视口顶部消息索引（用于导航按钮状态判断）
    const [currentMsgIdx, setCurrentMsgIdx] = useState(0)
    // 追踪最近一次导航到的精确消息索引
    const lastNavigatedMsgIdxRef = useRef<number | null>(null)
    // requestAnimationFrame 节流，每个动画帧最多一次 elementsFromPoint 检测
    const rafPendingRef = useRef(false)

    /** 重置"用户已离开底部"相关状态（3 处共用） */
    function resetScrollState() {
        userScrolledAwayRef.current = false
        setShowScrollBtn(false)
        setNewMsgCount(0)
    }

    // ── 用户消息索引（用于导航按钮） ──────────────────────
    const userMessageIndices = useMemo(() => {
        return messages.reduce<number[]>((acc, msg, index) => {
            if (msg.role === 'user') acc.push(index)
            return acc
        }, [])
    }, [messages])

    const hasPrevUserMsg = useMemo(() => {
        if (currentMsgIdx <= 0 && !hasMore) return false
        return userMessageIndices.some(idx => idx < currentMsgIdx) || hasMore
    }, [currentMsgIdx, userMessageIndices, hasMore])

    const hasNextUserMsg = useMemo(() => {
        const lastIdx = messages.length - 1
        if (currentMsgIdx >= lastIdx) return false
        return userMessageIndices.some(idx => idx > currentMsgIdx)
    }, [currentMsgIdx, userMessageIndices, messages.length])

    // ── 导航到上一条用户消息 ──────────────────────────────
    const goToPrevUserMessage = useCallback(() => {
        const container = containerRef.current
        if (!container) return

        // 点击时刻用 elementsFromPoint 检测当前位置（不受 content-visibility 影响）
        const viewportIdx = findViewportTopMsgIdx(container)
        if (viewportIdx === null) return

        const targetIdx = userMessageIndices
            .filter(idx => idx < viewportIdx)
            .pop()
        if (targetIdx !== undefined) {
            lastNavigatedMsgIdxRef.current = targetIdx
            setCurrentMsgIdx(targetIdx)
            container.querySelector(`[data-msg-idx="${targetIdx}"]`)
                ?.scrollIntoView({behavior: 'smooth', block: 'start'})
            return
        }
        // 已加载中没有上一条 -> 触发加载更多
        if (hasMore && conversationId) {
            useConversationStore.getState().loadMoreMessages(conversationId)
        }
    }, [userMessageIndices, hasMore, conversationId])

    // ── 导航到下一条用户消息 ──────────────────────────────
    const goToNextUserMessage = useCallback(() => {
        const container = containerRef.current
        if (!container) return

        const viewportIdx = findViewportTopMsgIdx(container)
        if (viewportIdx === null) return

        const targetIdx = userMessageIndices
            .filter(idx => idx > viewportIdx)
            .shift()
        if (targetIdx !== undefined) {
            lastNavigatedMsgIdxRef.current = targetIdx
            setCurrentMsgIdx(targetIdx)
            container.querySelector(`[data-msg-idx="${targetIdx}"]`)
                ?.scrollIntoView({behavior: 'smooth', block: 'start'})
        }
    }, [userMessageIndices])

    // ── 处理滚动事件 ──────────────────────────────────────
    const handleScroll = useCallback(() => {
        const el = containerRef.current
        if (!el) return

        const {scrollTop, scrollHeight, clientHeight} = el
        const distFromBottom = scrollHeight - scrollTop - clientHeight
        setShowScrollBtn(distFromBottom > 100)
        userScrolledAwayRef.current = distFromBottom > 100

        // 如果最近有导航操作，检测目标元素是否仍在视口顶部附近
        const lastNav = lastNavigatedMsgIdxRef.current
        if (lastNav !== null) {
            const targetEl = el.querySelector(`[data-msg-idx="${lastNav}"]`)
            if (targetEl) {
                const targetRect = targetEl.getBoundingClientRect()
                const containerRect = el.getBoundingClientRect()
                if (Math.abs(targetRect.top - containerRect.top) < 60) {
                    setCurrentMsgIdx(lastNav)
                    return
                }
            }
            // 用户已手动滚动离开导航目标，清除标记
            lastNavigatedMsgIdxRef.current = null
        }

        // 每帧最多一次，用 elementsFromPoint 精确检测视口顶部的消息索引
        //（不受 content-visibility: auto 估算尺寸影响，基于实际绘制内容）
        if (!rafPendingRef.current) {
            rafPendingRef.current = true
            requestAnimationFrame(() => {
                rafPendingRef.current = false
                const container = containerRef.current
                if (!container || !container.isConnected) return
                const idx = findViewportTopMsgIdx(container)
                setCurrentMsgIdx(idx ?? Math.max(0, Math.floor(container.scrollTop / 200)))
            })
        }
    }, [])

    // ── 滚动到底部 ─────────────────────────────────────────
    const scrollToBottom = useCallback((behavior: 'smooth' | 'auto' | boolean = 'smooth') => {
        const el = containerRef.current
        if (!el) return
        el.scrollTo({
            top: el.scrollHeight,
            behavior: behavior === true ? 'smooth' : behavior === false ? 'auto' : (behavior as ScrollBehavior),
        })
    }, [])

    // ── 回到底部 ────────────────────────────────────────────
    const goToBottom = useCallback(() => {
        resetScrollState()
        lastNavigatedMsgIdxRef.current = null
        setCurrentMsgIdx(messages.length - 1)
        scrollToBottom(true)
    }, [scrollToBottom, messages.length])

    // ── 切换会话时重置状态 ───────────────────────────────
    useEffect(() => {
        resetScrollState()
        setCurrentMsgIdx(0)
        lastNavigatedMsgIdxRef.current = null
        // 新会话自动滚动到底部（scrollIntoView 确保即使 content-visibility 未布局也能正确定位）
        requestAnimationFrame(() => {
            const container = containerRef.current
            if (!container) return
            const lastMsg = container.querySelector(':scope > div > :last-child')
            if (lastMsg) {
                lastMsg.scrollIntoView({block: 'end'})
            } else {
                scrollToBottom('auto')
            }
        })
    }, [activeConversationId, scrollToBottom])

    // ── 新消息时滚动到底部 ────────────────────────────────
    const prevCountRef = useRef(messages.length)
    useEffect(() => {
        const prevCount = prevCountRef.current
        if (messages.length > prevCount && prevCount > 0) {
            const newMsgs = messages.slice(prevCount)
            const hasUser = newMsgs.some(m => m.role === 'user')

            if (hasUser) {
                resetScrollState()
                requestAnimationFrame(() => scrollToBottom('auto'))
            } else if (!userScrolledAwayRef.current) {
                requestAnimationFrame(() => scrollToBottom('smooth'))
            } else {
                // 用户已上翻，仅计数
                setNewMsgCount(prev => prev + (messages.length - prevCount))
            }
        }
        prevCountRef.current = messages.length
    }, [messages.length, scrollToBottom])

    // 流式内容更新时自动跟随（收到新内容但消息数不变）
    // ★ 使用 MutationObserver 仅在 DOM 实际变化时触发，避免无依赖 useEffect 每次渲染后强制布局
    useEffect(() => {
        const el = containerRef.current
        if (!el || !streamingMessageId) return
        // 非活跃会话不监听滚动跟随
        if (conversationId !== useConversationStore.getState().activeConversationId) return

        const observer = new MutationObserver(() => {
            if (!userScrolledAwayRef.current) {
                const dist = el.scrollHeight - el.scrollTop - el.clientHeight
                if (dist < 200) {
                    el.scrollTop = el.scrollHeight - el.clientHeight
                }
            }
        })

        observer.observe(el, {childList: true, subtree: true, characterData: true})
        return () => observer.disconnect()
    }, [streamingMessageId, conversationId])

    // ── 监听文本选择并自动复制（仅活跃会话） ──────────────
    useEffect(() => {
        const handleMouseUp = (e: MouseEvent) => {
            const target = e.target as HTMLElement
            if (!containerRef.current?.contains(target)) return
            // 非活跃会话不处理自动复制
            if (conversationId !== useConversationStore.getState().activeConversationId) return

            setTimeout(() => {
                const selection = window.getSelection()
                const selectedText = selection?.toString().trim()
                if (selectedText && selectedText.length > 0) {
                    navigator.clipboard.writeText(selectedText).then(() => {
                        setShowCopyToast(true)
                        setTimeout(() => setShowCopyToast(false), 1500)
                    }).catch(() => {})
                }
            }, 10)
        }

        document.addEventListener('mouseup', handleMouseUp)
        return () => document.removeEventListener('mouseup', handleMouseUp)
    }, [conversationId])

    // ── 加载更多 ──────────────────────────────────────────
    const loadMore = useCallback(() => {
        if (!conversationId || loadingMore) return
        useConversationStore.getState().loadMoreMessages(conversationId)
    }, [conversationId, loadingMore])

    // ── 空状态 ────────────────────────────────────────────
    if (messages.length === 0) {
        return (
            <div className="flex-1 flex items-center justify-center p-8">
                <WelcomeMessage/>
            </div>
        )
    }

    // ── 消息列表（原生滚动 + content-visibility 懒渲染） ──
    return (
        <>
            <CopyToast visible={showCopyToast}/>
            <div
                ref={containerRef}
                onScroll={handleScroll}
                className="relative flex-1 overflow-y-auto overflow-x-hidden"
            >
                <div className="px-4 py-4">
                    {/* 加载更多触发器 */}
                    {hasMore && (
                        <LoadMoreTrigger
                            hasMore={hasMore}
                            loading={loadingMore}
                            onLoadMore={loadMore}
                            conversationId={conversationId}
                        />
                    )}
                    {/* 只显示 role='user' 或 'assistant' 的消息 */}
                    {/* 这样可以隐藏 role='context' 等内部消息（如 hook additionalContext） */}
                    {messages
                        .map((message, origIdx) => ({message, origIdx}))
                        .filter(({message}) => message.role === 'user' || message.role === 'assistant')
                        .map(({message, origIdx}, displayIdx) => (
                        <div
                            key={message.id}
                            data-msg-idx={origIdx}
                            style={{contentVisibility: 'auto', containIntrinsicSize: 'auto 200px'}}
                        >
                            <MessageBubble
                                message={message}
                                index={displayIdx}
                                isStreaming={message.id === streamingMessageId}
                            />
                        </div>
                    ))}
                </div>

                {/* 消息导航按钮组件 */}
                {showScrollBtn && (
                    <div className="sticky bottom-4 right-8 z-10 flex items-center justify-end pointer-events-none">
                        <div className="flex items-center gap-2 pointer-events-auto">
                            <NavButton
                                active={hasPrevUserMsg}
                                onClick={goToPrevUserMessage}
                                ariaLabel="上一条用户消息"
                            >
                                <polyline points="18 15 12 9 6 15"/>
                            </NavButton>
                            <NavButton
                                active={hasNextUserMsg}
                                onClick={goToNextUserMessage}
                                ariaLabel="下一条用户消息"
                            >
                                <polyline points="6 9 12 15 18 9"/>
                            </NavButton>
                            <motion.button
                                initial={{opacity: 0, scale: 0.8}}
                                animate={{opacity: 1, scale: 1}}
                                exit={{opacity: 0, scale: 0.8}}
                                transition={{duration: 0.15}}
                                onClick={goToBottom}
                                aria-label="回到底部"
                                className="w-12 h-12 rounded-full bg-[var(--surface-elevated)] border border-[var(--border)] shadow-elevated flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--brand-primary)] transition-all"
                            >
                                {newMsgCount > 0 ? (
                                    <span className="relative flex items-center justify-center">
                                        <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                             strokeWidth="2" aria-hidden="true">
                                            <line x1="4" y1="19" x2="20" y2="19"/>
                                            <polyline points="6 9 12 15 18 9"/>
                                        </svg>
                                        <span
                                            className="absolute -top-1 -right-1 min-w-[18px] h-[18px] rounded-full bg-[var(--brand-primary)] text-white text-[10px] font-medium flex items-center justify-center">
                                            {newMsgCount > 99 ? '99+' : newMsgCount}
                                        </span>
                                    </span>
                                ) : (
                                    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                         strokeWidth="2" aria-hidden="true">
                                        <line x1="4" y1="19" x2="20" y2="19"/>
                                        <polyline points="6 9 12 15 18 9"/>
                                    </svg>
                                )}
                            </motion.button>
                        </div>
                    </div>
                )}

                </div>

                <div className="absolute left-4 bottom-4 z-10 pointer-events-none">
                    <ThinkingIndicator conversationId={conversationId}/>
                </div>
        </>
    )
}
