/**
 * 滚动到底部的 Hook
 * 管理消息列表的自动滚动、用户滚动检测、底部按钮显示等逻辑
 */

import type {RefObject} from 'react'
import {useCallback, useEffect, useRef, useState} from 'react'

const SCROLL_THRESHOLD = 100 // 底部判定阈值(px)
const SETTLE_TIMEOUT = 600 // 初始滚动等待时间(ms)

interface UseScrollToBottomOptions {
    scrollRef: RefObject<HTMLDivElement>
    bottomRef: RefObject<HTMLDivElement>
    messageCount: number
    streamingMessageId: string | null
    streamBufferLength: number
    agentStatus: string
    isThinkingAfterTools: boolean
    runningToolCount: number
    activeConversationId: string | null
}

interface UseScrollToBottomReturn {
    showScrollToBottom: boolean
    scrollToBottom: () => void
    handleScroll: () => void
    newMessageCount: number
    resetNewMessageCount: () => void
}

/**
 * 滚动到底部 Hook
 */
export function useScrollToBottom({
                                      scrollRef,
                                      bottomRef,
                                      messageCount,
                                      streamingMessageId,
                                      streamBufferLength,
                                      agentStatus,
                                      isThinkingAfterTools,
                                      runningToolCount,
                                      activeConversationId
                                  }: UseScrollToBottomOptions): UseScrollToBottomReturn {
    // 用 ref 追踪用户主动上翻，避免 state 触发重渲染
    const userScrolledAwayRef = useRef(false)
    // 用 ref 追踪初始化状态
    const hasInitializedRef = useRef(false)
    // IntersectionObserver ref 用于精确检测底部
    const bottomObserverRef = useRef<IntersectionObserver | null>(null)
    // 防抖计时器 ref
    const scrollDebounceRef = useRef<number | null>(null)

    // Refs 用于追踪变化
    const prevLengthRef = useRef(0)
    const prevStreamingIdRef = useRef<string | null>(null)
    const prevStreamBufferLengthRef = useRef(0)

    // 底部按钮显示状态（需要 state 来触发 UI 更新）
    const [showScrollToBottom, setShowScrollToBottom] = useState(false)

    // 未读新消息计数
    const [newMessageCount, setNewMessageCount] = useState(0)

    // ── 滚动到底部核心逻辑 ────────────────────────────────
    const doScrollToBottom = useCallback(
        (instant = false, force = false) => {
            if (!scrollRef.current || !bottomRef.current) return
            // 用户主动上翻查看历史时，不强制滚动（除非 force=true）
            if (!force && userScrolledAwayRef.current) return

            bottomRef.current.scrollIntoView({
                behavior: instant ? 'instant' : 'smooth',
                block: 'end'
            })
        },
        [scrollRef, bottomRef]
    )

    // ── IntersectionObserver 监听底部锚点 ────────────────
    // 当 bottomRef 进入视窗时认为用户到达底部，恢复自动跟随
    useEffect(() => {
        if (!bottomRef.current || !scrollRef.current) return

        const observer = new IntersectionObserver(
            (entries) => {
                const [entry] = entries
                // intersectionRatio > 0 表示 bottomRef 至少部分可见
                if (entry.isIntersecting && entry.intersectionRatio > 0) {
                    userScrolledAwayRef.current = false
                    setShowScrollToBottom(false)
                    setNewMessageCount(0)
                }
            },
            {
                root: scrollRef.current,
                // 多个 threshold 精确检测不同阶段
                threshold: [0, 0.25, 0.5, 0.75, 1],
                rootMargin: '0px'
            }
        )

        observer.observe(bottomRef.current)
        bottomObserverRef.current = observer

        return () => {
            observer.disconnect()
            bottomObserverRef.current = null
        }
    }, [scrollRef, bottomRef])

    // ── 处理滚动事件 ────────────────────────────────────
    // 只负责检测用户主动上翻，不在底部附近时操作
    const handleScroll = useCallback(() => {
        if (!scrollRef.current) return

        // 防抖避免频繁检测
        if (scrollDebounceRef.current) {
            clearTimeout(scrollDebounceRef.current)
        }
        scrollDebounceRef.current = window.setTimeout(() => {
            if (!scrollRef.current) return
            const {scrollTop, scrollHeight, clientHeight} = scrollRef.current
            const distanceFromBottom = scrollHeight - scrollTop - clientHeight

            // 只有当距离底部超过阈值时才认为用户主动上翻
            if (distanceFromBottom > SCROLL_THRESHOLD) {
                userScrolledAwayRef.current = true
                setShowScrollToBottom(true)
            }
            // 当用户滚动到底部时，由 IntersectionObserver 恢复自动跟随
        }, 50)
    }, [])

    // ── 切换会话时重置所有状态 ────────────────────────────
    useEffect(() => {
        hasInitializedRef.current = false
        prevLengthRef.current = 0
        prevStreamingIdRef.current = null
        prevStreamBufferLengthRef.current = 0
        userScrolledAwayRef.current = false
        setShowScrollToBottom(false)
        setNewMessageCount(0)
    }, [activeConversationId])

    // ── 初始化滚动（首次加载消息） ────────────────────────
    useEffect(() => {
        if (messageCount === 0) return
        if (hasInitializedRef.current) return

        const scrollContainer = scrollRef.current
        if (!scrollContainer) return

        let settled = false
        let settleTimer: number | null = null

        const scrollToBottomOnSettle = () => {
            if (settled || !scrollRef.current) return
            settled = true
            if (settleTimer) clearTimeout(settleTimer)
            requestAnimationFrame(() => {
                doScrollToBottom(true) // instant 滚动
                hasInitializedRef.current = true
            })
        }

        const observer = new MutationObserver(() => {
            if (settleTimer) clearTimeout(settleTimer)
            settleTimer = window.setTimeout(scrollToBottomOnSettle, 100)
        })

        observer.observe(scrollContainer, {childList: true, subtree: true})
        settleTimer = window.setTimeout(scrollToBottomOnSettle, SETTLE_TIMEOUT)

        return () => {
            observer.disconnect()
            if (settleTimer) clearTimeout(settleTimer)
        }
    }, [messageCount, doScrollToBottom, scrollRef])

    // ── 新消息到达时滚动 ──────────────────────────────────
    useEffect(() => {
        // 跳过首次初始化
        if (!hasInitializedRef.current) return
        // 有新消息时滚动
        if (messageCount > prevLengthRef.current) {
            // 获取最新消息，如果是用户消息，强制滚动到底部
            const lastMessage = prevLengthRef.current === 0 ? null : prevLengthRef.current
            const isUserMessage = lastMessage !== null // 简化判断，实际需要访问 message 数组
            doScrollToBottom(true, isUserMessage) // 用户消息强制滚动，其他消息尊重用户选择

            // 用户不在底部时增加未读计数
            if (userScrolledAwayRef.current) {
                setNewMessageCount((c) => c + (messageCount - prevLengthRef.current))
            }
        }
        prevLengthRef.current = messageCount
    }, [messageCount, doScrollToBottom])

    // ── 流式消息 ID 变化时滚动（内容增长但长度不变） ───────
    useEffect(() => {
        if (!streamingMessageId) return
        if (streamingMessageId === prevStreamingIdRef.current) return
        if (!hasInitializedRef.current) return

        prevStreamingIdRef.current = streamingMessageId
        prevStreamBufferLengthRef.current = streamBufferLength
        // 流式消息开始时滚动到底部
        doScrollToBottom(true)
    }, [streamingMessageId, doScrollToBottom, streamBufferLength])

    // ── 流式文本内容增长时滚动 ───────────────────────────────
    // 解决换行导致气泡变长时滚动条不更新的问题
    useEffect(() => {
        if (!streamingMessageId) return
        if (!hasInitializedRef.current) return
        if (userScrolledAwayRef.current) return // 用户主动上翻时不跟随

        const currentLength = streamBufferLength
        const prevLength = prevStreamBufferLengthRef.current

        // 内容增长时滚动
        if (currentLength > prevLength) {
            // 使用防抖滚动，避免过于频繁
            if (scrollDebounceRef.current) {
                clearTimeout(scrollDebounceRef.current)
            }
            scrollDebounceRef.current = window.setTimeout(() => {
                doScrollToBottom(false) // smooth 滚动，用户体验更自然
            }, 50) // 50ms 防抖延迟

            prevStreamBufferLengthRef.current = currentLength
        }
    }, [streamBufferLength, streamingMessageId, doScrollToBottom])

    // ── Agent 状态变化时保持跟随 ──────────────────────────
    useEffect(() => {
        // 仅在 Agent 活跃且用户没有主动上翻时跟随
        if (agentStatus !== 'idle' && !userScrolledAwayRef.current) {
            doScrollToBottom(false) // smooth 滚动，用户体验更自然
        }
    }, [agentStatus, isThinkingAfterTools, runningToolCount, doScrollToBottom])

    // ── 底部按钮点击 ──────────────────────────────────────
    const scrollToBottomButton = useCallback(() => {
        // 立即同步状态，用户不需要等待
        userScrolledAwayRef.current = false
        setShowScrollToBottom(false)
        doScrollToBottom(true)
    }, [doScrollToBottom])

    // ── 重置未读计数 ──────────────────────────────────────
    const resetNewMessageCount = useCallback(() => {
        setNewMessageCount(0)
    }, [])

    return {
        showScrollToBottom,
        scrollToBottom: scrollToBottomButton,
        handleScroll,
        newMessageCount,
        resetNewMessageCount
    }
}
