/**
 * MessageList 主组件
 * 使用 content-visibility 实现原生懒渲染，支持超长消息内容
 */

import {memo, useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {AnimatePresence, motion} from 'framer-motion'
import {useConversationStore} from '../../stores/conversationStore'
import {useAgentStore} from '../../stores/agentStore'
import MessageBubble from './MessageBubble'
import {ThinkingIndicator, getPhaseLabel} from './StatusIndicators'
import {KbdCombo} from '../common/Kbd'

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
    const shortcuts = [
        {label: '新建会话', keys: ['Ctrl', 'N']},
        {label: '快速搜索', keys: ['Ctrl', 'K']},
        {label: '切换会话', keys: ['Alt', ['↑', '↓']]},
        {label: '输入历史', keys: ['Ctrl', ['↑', '↓']]},
    ]

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
                智能对话助手，帮助您完成各种任务
            </p>
            <p className="text-xs text-[var(--text-muted)] pt-2">
                试试这些快捷键，快速上手操作
            </p>
            <div className="grid grid-cols-2 gap-2.5 max-w-[360px] mx-auto">
                {shortcuts.map(({label, keys}) => (
                    <div
                        key={label}
                        className="welcome-shortcut-card flex items-center justify-between gap-2 px-3 py-2 rounded-lg
                                   bg-[var(--surface-muted)]/40 border border-[var(--border-muted)]
                                   hover:bg-[var(--surface-muted)]/60 transition-colors"
                    >
                        <span className="text-xs text-[var(--text-muted)] whitespace-nowrap">{label}</span>
                        <KbdCombo keys={keys}/>
                    </div>
                ))}
            </div>
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
    const messages = useConversationStore((s) =>
        conversationId ? (s.messagesMap[conversationId] || []) : s.loadedMessages)
    const activeConversationId = useConversationStore((s) => s.activeConversationId)
    const hasMore = useConversationStore((s) =>
        conversationId ? (s.hasMoreMap[conversationId] ?? false) : false)
    const loadingMore = useConversationStore((s) =>
        conversationId ? (s.loadingMoreMap[conversationId] ?? false) : false)
    // agent 状态
    const streamingMessageId = useAgentStore((s) => conversationId ? s.convAgentStates[conversationId]?.streamingMessageId ?? null : s.streamingMessageId)
    // statusNote 数据源：重试进度（executingToolsMessage 的 retry 分支）+ 最终错误
    const convExecMsg = useAgentStore((s) =>
        conversationId ? (s.convAgentStates[conversationId]?.executingToolsMessage ?? null) : (s as any).executingToolsMessage)
    const convErrorMsg = useAgentStore((s) =>
        conversationId ? (s.convAgentStates[conversationId]?.errorMessage ?? null) : s.errorMessage)
    // 阶段状态（思考中/响应中等）——同样搬入气泡 statusNote
    const convAgentState = useAgentStore((s) =>
        conversationId ? (s.convAgentStates[conversationId]?.agentState ?? null) : s.agentState)
    const convIsThinkingAfterTools = useAgentStore((s) =>
        conversationId ? (s.convAgentStates[conversationId]?.isThinkingAfterTools ?? false) : s.isThinkingAfterTools)

    const containerRef = useRef<HTMLDivElement>(null)
    const [showCopyToast, setShowCopyToast] = useState(false)
    const [showScrollBtn, setShowScrollBtn] = useState(false)
    const [newMsgCount, setNewMsgCount] = useState(0)
    const userScrolledAwayRef = useRef(false)
    // 滚动初始化标记：防止消息异步加载时的竞态导致初始化被跳过
    const scrollInitDoneRef = useRef(false)
    // 视口顶部消息索引（用于导航按钮状态判断）
    const [currentMsgIdx, setCurrentMsgIdx] = useState(0)
    // 追踪最近一次导航到的精确消息索引
    const lastNavigatedMsgIdxRef = useRef<number | null>(null)
    // 追踪上一次 loadingMore 状态，用于检测一次向前分页的完成
    const prevLoadingMoreRef = useRef(false)
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
    // 重置滚动相关状态并标记初始化未完成，等待后续初始化 effect。
    useEffect(() => {
        resetScrollState()
        setCurrentMsgIdx(0)
        lastNavigatedMsgIdxRef.current = null
        // 重置加载状态追踪，避免跨会话的 loadingMore 残留干扰校准
        prevLoadingMoreRef.current = false
        // 重置消息计数基准，使首次 0→N 的异步加载也能触发"新消息滚动"兜底
        prevCountRef.current = 0
        // 重置滚动初始化标记，让下一次容器可用时重新初始化
        scrollInitDoneRef.current = false
    }, [activeConversationId])

    // ── 初始化滚动到底部（会话切换 / 首次挂载补初始化） ────
    // ★ 等待历史消息加载完成后再滚动到底部：
    //   会话切换瞬间消息可能尚未从 SQLite 加载（loadMessagesInitial 是异步的），
    //   若立即滚动，列表为空或仅部分渲染（content-visibility 懒渲染），
    //   会停在中部/顶部。因此用 MutationObserver 监听容器子节点，
    //   待历史消息真正插入 DOM 后再执行 scrollIntoView 精确滚动；
    //   超时兜底防止空会话卡住。
    // ★ 标记机制：启动时首个会话的消息加载完成前，MessageList 走空态分支
    //   （containerRef 为 null），此 effect 会提前返回；消息到达后 messages.length
    //   变化触发重跑，容器已挂载，才真正建立观察器——覆盖"应用启动激活首个会话"场景。
    // ★ 清理时若初始化被打断（未 settle 即重跑），重置标记让下次重跑时重建观察器。
    useEffect(() => {
        if (scrollInitDoneRef.current) return
        const container = containerRef.current
        if (!container || messages.length === 0) return
        scrollInitDoneRef.current = true

        let settled = false
        let settleTimer: number | null = null
        let fallbackTimer: number | null = null
        let observer: MutationObserver | null = null

        // 统一停止观察与计时（settle 与清理共用）
        const stop = () => {
            settled = true
            if (settleTimer) clearTimeout(settleTimer)
            if (fallbackTimer) clearTimeout(fallbackTimer)
            observer?.disconnect()
        }

        const settle = () => {
            if (settled) return
            stop()
            // 消息元素已插入 DOM 且 content-visibility 完成布局后精确滚动
            requestAnimationFrame(() => {
                const c = containerRef.current
                if (!c) return
                const lastMsg = c.querySelector(':scope > div > :last-child')
                if (lastMsg) {
                    lastMsg.scrollIntoView({block: 'end'})
                } else {
                    scrollToBottom('auto')
                }
            })
        }

        // 防抖调度：替换已有定时器
        const scheduleSettle = (delay: number) => {
            if (settleTimer) clearTimeout(settleTimer)
            settleTimer = window.setTimeout(settle, delay)
        }

        // 历史消息加载是异步的（loadMessagesInitial），子节点插入时触发滚动
        observer = new MutationObserver(() => {
            if (settled) return
            scheduleSettle(50) // 短防抖，等一批子节点插入完
        })
        observer.observe(container, {childList: true, subtree: true})

        // 立即调度一次：消息可能已插入 DOM（如启动场景补初始化），
        // 无需等待 MutationObserver；若尚未插入，观察器回调会重置计时
        scheduleSettle(50)
        // 兜底：1500ms 内无子节点变化也执行一次滚动
        fallbackTimer = window.setTimeout(settle, 1500)

        return () => {
            if (settled) return
            stop()
            // 初始化被打断（消息加载中依赖变化触发 effect 重建），
            // 重置标记以便下次依赖变化时重新初始化
            scrollInitDoneRef.current = false
        }
    }, [activeConversationId, messages.length, scrollToBottom])

    // ── 新消息时滚动到底部 ────────────────────────────────
    // ★ 放开 prevCount > 0 门槛：会话切换后首次 0→N 的异步加载（loadMessagesInitial）
    //   也视为新消息，加载完成即滚动到底部，作为 MutationObserver 方案的兜底
    const prevCountRef = useRef(messages.length)
    useEffect(() => {
        const prevCount = prevCountRef.current
        if (messages.length > prevCount) {
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

    // ── 加载更多后重新校准导航定位 ────────────────────────
    // ★ 根因：loadMoreMessages 把更早的消息插入列表头部时，视口位置
    //   （scrollTop）不变，不会触发滚动事件；而 currentMsgIdx /
    //   lastNavigatedMsgIdxRef 仍是加载前的旧索引。此时"上一条/下一条"
    //   按钮的激活状态与 DOM 实际位置脱节：新加载出的用户消息无法被
    //   导航到（filter(idx < viewportIdx) 的 viewportIdx 已变但按钮状态
    //   还是按旧索引算）。
    // ★ 修复：loadingMore false→true→false 时（即一次向前分页完成），
    //   等 React 重渲染 + content-visibility 布局稳定后，用
    //   findViewportTopMsgIdx 重读视口顶部的真实索引，重校准
    //   currentMsgIdx 与 lastNavigatedMsgIdxRef。
    useEffect(() => {
        if (prevLoadingMoreRef.current === loadingMore || !loadingMore) return
        prevLoadingMoreRef.current = loadingMore
        if (!loadingMore) {
            // 加载完成：双 rAF 确保 DOM 已更新且 content-visibility 布局稳定
            requestAnimationFrame(() => requestAnimationFrame(() => {
                const container = containerRef.current
                if (!container || !container.isConnected) return
                const idx = findViewportTopMsgIdx(container)
                if (idx !== null) {
                    setCurrentMsgIdx(idx)
                    // 若上一次导航目标因头部插入消息而偏移，清除旧标记
                    lastNavigatedMsgIdxRef.current = null
                }
            }))
        }
    }, [loadingMore])

    // 流式内容更新时自动跟随（收到新内容但消息数不变）
    // ★ 使用 MutationObserver 仅在 DOM 实际变化时触发，避免无依赖 useEffect 每次渲染后强制布局
    // ★ rAF 节流：流式期间 DOM 高频变化（每 text/thinking chunk 一次 characterData 变更），
    //   MutationObserver 回调可能非常密集；el.scrollTop 写入会触发同步布局，
    //   用 requestAnimationFrame 合并到每帧最多一次，避免布局抖动与主线程占用
    useEffect(() => {
        const el = containerRef.current
        if (!el || !streamingMessageId) return
        // 非活跃会话不监听滚动跟随
        if (conversationId !== useConversationStore.getState().activeConversationId) return

        let rafId = 0
        const scheduleScroll = () => {
            if (rafId) return
            rafId = requestAnimationFrame(() => {
                rafId = 0
                if (!userScrolledAwayRef.current) {
                    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
                    if (dist < 200) {
                        el.scrollTop = el.scrollHeight - el.clientHeight
                    }
                }
            })
        }

        const observer = new MutationObserver(scheduleScroll)

        observer.observe(el, {childList: true, subtree: true, characterData: true})
        return () => {
            observer.disconnect()
            if (rafId) cancelAnimationFrame(rafId)
        }
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

    // ── 最后一条助手消息的状态注记（重试/错误提示） ─────────
    // 只挂"当前最后一条助手消息"：用户滚动历史时干净，新消息成为最后一条后自动转移。
    // 错误优先（handleError 已清 executingToolsMessage，两者互斥）。
    const visibleMessages = useMemo(
        () => messages
            .map((message, origIdx) => ({message, origIdx}))
            .filter(({message}) => message.role === 'user' || message.role === 'assistant'),
        [messages],
    )
    const lastAssistantId = useMemo(() => {
        for (let i = visibleMessages.length - 1; i >= 0; i--) {
            if (visibleMessages[i].message.role === 'assistant') return visibleMessages[i].message.id
        }
        return null
    }, [visibleMessages])
    // ★ agentState 字段级解耦：流式事件（thinking/text chunk）频繁生成新
    //   agentState 对象引用，但 status/phase/model 字段值不变。若 useMemo 依赖
    //   整个 convAgentState，每次流式更新都会重算出新 statusNote 对象 → 传给
    //   StatusNote 的引用变化 → memo 失效 → 气泡重渲染连带 statusNote 重渲染
    //   （流式闪烁）。取字段做依赖：字段值不变则 statusNote 引用稳定。
    const agentStatus = convAgentState?.status
    const agentPhase = convAgentState?.phase
    const agentModelProvider = convAgentState?.currentModelProvider
    const agentModelName = convAgentState?.currentModelName
    // 运行中标志（含 executing_tools：tool 阶段 status 为 'running'）：
    // 传给最后一条助手气泡做行级 min-w 兜底，statusNote 暂时为 null 时行宽不回缩。
    const isAgentRunning = agentStatus === 'running' || agentStatus === 'thinking'
    const statusNote = useMemo<{type: 'retry' | 'error' | 'phase'; label: string; urgent?: boolean} | null>(() => {
        if (lastAssistantId === null) return null
        // 1. 错误（最终失败态；handleError 已清 executingToolsMessage，互斥）
        if (convErrorMsg) return {type: 'error', label: convErrorMsg}
        // 2. 重试进度（retry 对象/字符串）
        if (typeof convExecMsg === 'string') {
            if (convExecMsg.startsWith('重试')) return {type: 'retry', label: convExecMsg}
        } else if (convExecMsg && typeof convExecMsg.label === 'string' && convExecMsg.label.startsWith('重试')) {
            return {type: 'retry', label: convExecMsg.label, urgent: convExecMsg.urgent}
        }
        // 3. 阶段文案（思考中/响应中/等待响应中…），带当前模型名前缀
        //    （合并原 InputToolbar 底部"模型 运行中..."显示）；执行工具中留左下角
        //    （气泡内已有 tool 卡片显示进度，避免双份提示）
        //    ★ thinking 状态（思考块流式期间，handleThinking 设 status='thinking'）
        //    也必须显示：若仅认 running，思考块出现时 statusNote 消失 → 时间戳行
        //    收缩 → 气泡宽度回缩，与思考块/文案交替出现形成高频闪烁。
        //    （复用上方已算好的 isAgentRunning，避免 running||thinking 重复判断）
        if (isAgentRunning && agentPhase && agentPhase !== 'idle' && agentPhase !== 'executing_tools') {
            // 兜底 '思考中'：running/thinking 期间 statusNote 永不返回 null，
            // 保证行宽稳定（min-w-[16rem]），仅文案切换不引起气泡伸缩
            const phaseLabel = getPhaseLabel(agentPhase) || (convIsThinkingAfterTools ? '等待响应中...' : '思考中')
            if (phaseLabel) {
                const modelLabel = agentModelProvider
                    ? `${agentModelProvider}/${agentModelName}`
                    : agentModelName
                return {type: 'phase', label: modelLabel ? `${modelLabel} ${phaseLabel}` : phaseLabel}
            }
        }
        return null
    }, [lastAssistantId, convErrorMsg, convExecMsg, agentStatus, agentPhase, agentModelProvider, agentModelName, convIsThinkingAfterTools])

    // ── 触底跟随补丁：statusNote 无→有 / 类型切换时高度突变 ──
    // 气泡底部插入提示无 scroll 事件、不走"新消息"effect（messages.length 不变），
    // 用户停在底部时提示会被推出视口 → 主动跟随一次。
    // 倒计时同类型文本变化（高度不变，单行 truncate）不重复滚动。
    const prevStatusTypeRef = useRef<string | null>(null)
    useEffect(() => {
        const type = statusNote?.type ?? null
        const prev = prevStatusTypeRef.current
        prevStatusTypeRef.current = type
        if (type && type !== prev && !userScrolledAwayRef.current) {
            requestAnimationFrame(() => scrollToBottom('smooth'))
        }
    }, [statusNote, scrollToBottom])

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
                data-name="message-list-scroll-container"
                className="relative flex-1 overflow-y-auto overflow-x-hidden"
            >
                <div data-name="message-list-inner" className="px-4 py-4">
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
                    {visibleMessages.map(({message, origIdx}) => (
                        <div
                            key={message.id}
                            data-msg-idx={origIdx}
                            data-name={`message-row-${message.role}`}
                            style={{contentVisibility: 'auto', containIntrinsicSize: 'auto 200px'}}
                        >
                            <MessageBubble
                                message={message}
                                isAgentRunning={message.id === lastAssistantId && isAgentRunning}
                                statusNote={message.id === lastAssistantId ? statusNote : null}
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
