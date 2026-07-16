import {memo, useMemo, useRef, useState, useCallback, useEffect} from 'react'
import {createPortal} from 'react-dom'
import {useConversationStore} from '../stores/conversationStore'

/** 格式化 token 数为可读形式 */
const formatTokenCount = (n: number): string => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`

/**
 * 缓存命中率显示组件
 * 显示缓存命中百分比，悬停时展示详细统计
 * 累计值 = 本次会话所有请求的汇总
 * 当前值 = 最后一次请求的明细
 *
 * tooltip 通过 Portal 渲染到 document.body，突破祖先容器的 overflow: hidden 裁剪
 */
const CacheRateTooltip = memo(function CacheRateTooltip() {
    const loadedMessages = useConversationStore(s => s.loadedMessages)
    const triggerRef = useRef<HTMLSpanElement>(null)
    const [show, setShow] = useState(false)
    const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const [pos, setPos] = useState({bottom: 0, right: 0})

    const stats = useMemo(() => {
        let requestCount = 0
        let totalInputTokens = 0
        let totalOutputTokens = 0
        let totalCacheReadTokens = 0
        let toolCallCount = 0
        let currentInputTokens = 0
        let currentOutputTokens = 0
        let currentCacheReadTokens = 0

        for (const msg of loadedMessages) {
            if (msg.role !== 'assistant') continue
            const statsList = Array.isArray(msg.llmStats) ? msg.llmStats : []
            requestCount += statsList.length
            for (const s of statsList) {
                totalInputTokens += s.inputTokens || 0
                totalOutputTokens += s.outputTokens || 0
                totalCacheReadTokens += s.cacheReadTokens || 0
                currentInputTokens = s.inputTokens || 0
                currentOutputTokens = s.outputTokens || 0
                currentCacheReadTokens = s.cacheReadTokens || 0
            }
            if (msg.toolCalls?.length) {
                toolCallCount += msg.toolCalls.length
            }
        }

        return {
            requestCount,
            totalInputTokens,
            totalOutputTokens,
            totalCacheReadTokens,
            toolCallCount,
            currentInputTokens,
            currentOutputTokens,
            currentCacheReadTokens,
        }
    }, [loadedMessages])

    const cacheRead = stats.totalCacheReadTokens
    const denominator = Math.max(stats.totalInputTokens + cacheRead, 1)
    const rate = (cacheRead / denominator * 100).toFixed(0)
    const currentTotalTokens = stats.currentInputTokens + stats.currentCacheReadTokens

    const updatePosition = useCallback(() => {
        if (!triggerRef.current) return
        const rect = triggerRef.current.getBoundingClientRect()
        setPos({
            bottom: window.innerHeight - rect.top + 8,
            right: window.innerWidth - rect.right,
        })
    }, [])

    const scheduleShow = useCallback(() => {
        if (hideTimerRef.current) {
            clearTimeout(hideTimerRef.current)
            hideTimerRef.current = null
        }
        updatePosition()
        setShow(true)
    }, [updatePosition])

    const scheduleHide = useCallback(() => {
        hideTimerRef.current = setTimeout(() => setShow(false), 100)
    }, [])

    const handleTooltipEnter = useCallback(() => {
        if (hideTimerRef.current) {
            clearTimeout(hideTimerRef.current)
            hideTimerRef.current = null
        }
    }, [])

    useEffect(() => {
        return () => {
            if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
        }
    }, [])

    // 窗口 resize 时更新 tooltip 位置
    useEffect(() => {
        if (!show) return
        const onResize = () => updatePosition()
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
    }, [show, updatePosition])

    if (stats.requestCount === 0) return null

    const tooltipContent = (
        <div
            onMouseEnter={handleTooltipEnter}
            onMouseLeave={scheduleHide}
            className="fixed z-[9999] bg-[var(--surface-elevated)] border border-[var(--border)]
                       rounded-lg shadow-overlay p-3 whitespace-nowrap min-w-[240px]"
            style={{bottom: pos.bottom, right: pos.right}}
        >
            <div className="text-[11px] leading-relaxed text-[var(--text-primary)]">
                <div className="flex items-center gap-2 text-[var(--text-muted)] mb-1.5 pb-1.5 border-b border-[var(--border)]">
                    <span className="font-medium text-[var(--text-primary)]">缓存命中率 {rate}%</span>
                    <span>·</span>
                    <span>上下文窗口 {formatTokenCount(currentTotalTokens)}</span>
                    <span>·</span>
                    <span>LLM {stats.requestCount}次</span>
                    <span>·</span>
                    <span>工具 {stats.toolCallCount}次</span>
                </div>

                <div className="grid grid-cols-[3rem_1fr_1fr] gap-x-3 gap-y-1 text-[10px] text-[var(--text-muted)] mb-1">
                    <span/>
                    <span className="text-right">累计</span>
                    <span className="text-right">当前</span>
                </div>

                <div className="grid grid-cols-[3rem_1fr_1fr] gap-x-3 gap-y-1">
                    <span className="text-[var(--text-muted)]">输入</span>
                    <span className="text-right tabular-nums">{formatTokenCount(stats.totalInputTokens)}</span>
                    <span className="text-right tabular-nums">{formatTokenCount(stats.currentInputTokens)}</span>
                </div>

                <div className="grid grid-cols-[3rem_1fr_1fr] gap-x-3 gap-y-1">
                    <span className="text-[var(--text-muted)]">缓存命中</span>
                    <span className="text-right tabular-nums">{formatTokenCount(stats.totalCacheReadTokens)}</span>
                    <span className="text-right tabular-nums">{formatTokenCount(stats.currentCacheReadTokens)}</span>
                </div>

                <div className="grid grid-cols-[3rem_1fr_1fr] gap-x-3 gap-y-1">
                    <span className="text-[var(--text-muted)]">输出</span>
                    <span className="text-right tabular-nums">{formatTokenCount(stats.totalOutputTokens)}</span>
                    <span className="text-right tabular-nums">{formatTokenCount(stats.currentOutputTokens)}</span>
                </div>

                <div className="mt-2 pt-2 border-t border-[var(--border)] text-[10px] text-[var(--text-muted)] leading-relaxed">
                    <div>
                        命中率 = {formatTokenCount(stats.totalCacheReadTokens)} / ({formatTokenCount(stats.totalInputTokens)} + {formatTokenCount(stats.totalCacheReadTokens)}) = {rate}%
                    </div>
                    <div>
                        上下文 = {formatTokenCount(stats.currentInputTokens)} + {formatTokenCount(stats.currentCacheReadTokens)} = {formatTokenCount(currentTotalTokens)}
                    </div>
                </div>
            </div>
        </div>
    )

    return (
        <>
            <span
                ref={triggerRef}
                className="text-sm text-[var(--text-muted)] cursor-help tabular-nums leading-none"
                onMouseEnter={scheduleShow}
                onMouseLeave={scheduleHide}
            >
                缓存 {rate}% · 上下文 {formatTokenCount(currentTotalTokens)}
            </span>
            {show && createPortal(tooltipContent, document.body)}
        </>
    )
})

export default CacheRateTooltip
