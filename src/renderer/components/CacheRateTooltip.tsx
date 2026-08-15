import {memo, useRef, useState, useCallback, useEffect} from 'react'
import {createPortal} from 'react-dom'
import {formatTokenCount, formatTokensPerSecond, tokensPerSecond} from '../lib/format'
import {useMessageTokenStats} from '../hooks/useMessageTokenStats'
import {useWindowUsage} from '../hooks/useWindowUsage'
import MetricBadge from './MetricBadge'

/**
 * 缓存命中率徽章颜色：≥90 优秀绿 / 70~90 一般黄 / <70 警惕红。
 * 注意：与 MetricBadge 内置分级的阈值方向相反（命中率越高越健康，
 * 内置分级是百分比越高越危险），因此不能复用内置分级，必须显式传入 accent。
 */
function cacheRateAccent(rate: number): string {
    return rate >= 90 ? 'var(--success)' : rate >= 70 ? 'var(--warning)' : 'var(--error)'
}

/** 平均吞吐徽章颜色：>150 高速绿 / 100~150 正常蓝 / 50~100 慢黄 / <=50 太慢红 */
function throughputAccent(tps: number): string {
    return tps > 150 ? 'var(--success)' : tps > 100 ? 'var(--info)' : tps > 50 ? 'var(--warning)' : 'var(--error)'
}

/**
 * 缓存命中率显示组件
 * 显示缓存命中百分比，悬停时展示详细统计
 * 累计值 = 本次会话所有请求的汇总
 * 当前值 = 最后一次请求的明细
 *
 * tooltip 通过 Portal 渲染到 document.body，突破祖先容器的 overflow: hidden 裁剪
 */
const CacheRateTooltip = memo(function CacheRateTooltip() {
    const triggerRef = useRef<HTMLSpanElement>(null)
    const [show, setShow] = useState(false)
    const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const [pos, setPos] = useState({bottom: 0, right: 0})

    const stats = useMessageTokenStats()
    const {contextLength, pct} = useWindowUsage(stats)

    const cacheRead = stats.totalCacheReadTokens
    const denominator = Math.max(stats.totalInputTokens + cacheRead, 1)
    const rate = Math.round(cacheRead / denominator * 100)
    const currentTotalTokens = stats.currentInputTokens + stats.currentCacheReadTokens

    // 平均吞吐 = Σ输出token ÷ Σ解码时长（首 token 之后，不含首字延迟）
    const decodeRate = tokensPerSecond(stats.totalOutputTokens, stats.totalDecodeMs)
    // 平均首字 = Σ首字延迟 ÷ 有效样本数（ttftMs 已排除重试干扰，attempt 级采集）
    const avgTtftSeconds = stats.ttftCount > 0 ? stats.totalTtftMs / stats.ttftCount / 1000 : null

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
                    <span>窗口占用 {formatTokenCount(currentTotalTokens)}</span>
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
                        窗口占用 = 输入 {formatTokenCount(stats.currentInputTokens)} + 缓存命中 {formatTokenCount(stats.currentCacheReadTokens)} = {formatTokenCount(currentTotalTokens)}
                    </div>
                    <div>
                        {contextLength > 0
                            ? `窗口使用率 = ${formatTokenCount(currentTotalTokens)} / ${formatTokenCount(contextLength)} = ${pct}%`
                            : '窗口大小未知'}
                    </div>
                    <div className="mt-1.5 pt-1.5 border-t border-[var(--border-dashed)] flex flex-col gap-1">
                        <div className="flex items-center justify-between gap-8">
                            <span>平均吞吐</span>
                            <span className="tabular-nums text-[var(--text-primary)]">
                                {decodeRate != null ? `${formatTokensPerSecond(decodeRate)} tok/s` : '—'}
                            </span>
                        </div>
                        <div className="flex items-center justify-between gap-8">
                            <span>平均首字</span>
                            <span className="tabular-nums text-[var(--text-primary)]">
                                {avgTtftSeconds != null ? `${avgTtftSeconds.toFixed(1)}s` : '—'}
                            </span>
                        </div>
                    </div>
                    <div className="mt-1.5 pt-1.5 border-t border-[var(--border-dashed)] text-[var(--text-tertiary)]">
                        低价值上下文自动裁剪，上下文数值仅代表末次请求
                    </div>
                </div>
            </div>
        </div>
    )

    return (
        <>
            <span
                data-name="input-toolbar-cache-rate"
                ref={triggerRef}
                className="flex items-center gap-1 text-sm text-[var(--text-muted)] cursor-help tabular-nums leading-none"
                onMouseEnter={scheduleShow}
                onMouseLeave={scheduleHide}
            >
                {/* 缓存命中率徽章（进度环 = 命中率） */}
                <MetricBadge pct={rate} accent={cacheRateAccent(rate)}>
                    缓存 {rate}%
                </MetricBadge>
                {/* 窗口占用徽章（进度环 = 窗口使用率，内置分级） */}
                <MetricBadge pct={pct}>窗口 {formatTokenCount(currentTotalTokens)}</MetricBadge>
                {/* 平均吞吐徽章（静态边框） */}
                {decodeRate != null && (
                    <MetricBadge accent={throughputAccent(decodeRate)}>
                        {formatTokensPerSecond(decodeRate)} tok/s
                    </MetricBadge>
                )}
            </span>
            {show && createPortal(tooltipContent, document.body)}
        </>
    )
})

export default CacheRateTooltip
