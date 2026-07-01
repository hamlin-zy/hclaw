import {memo, useMemo} from 'react'
import {useConversationStore} from '../stores/conversationStore'

/** 格式化 token 数为可读形式 */
const formatTokenCount = (n: number): string => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`

/**
 * 缓存命中率显示组件
 * 显示缓存命中百分比，悬停时展示详细统计
 * 累计值 = 本次会话所有请求的汇总
 * 当前值 = 最后一次请求的明细
 */
const CacheRateTooltip = memo(function CacheRateTooltip() {
    const loadedMessages = useConversationStore(s => s.loadedMessages)

    const stats = useMemo(() => {
        let requestCount = 0
        let totalInputTokens = 0
        let totalOutputTokens = 0
        let totalCacheReadTokens = 0
        let totalCacheWriteTokens = 0
        let toolCallCount = 0
        let currentInputTokens = 0
        let currentOutputTokens = 0
        let currentCacheReadTokens = 0
        let currentCacheWriteTokens = 0

        for (const msg of loadedMessages) {
            if (msg.role !== 'assistant') continue
            const statsList = Array.isArray(msg.llmStats) ? msg.llmStats : []
            requestCount += statsList.length
            for (const s of statsList) {
                totalInputTokens += s.inputTokens || 0
                totalOutputTokens += s.outputTokens || 0
                totalCacheReadTokens += s.cacheReadTokens || 0
                totalCacheWriteTokens += s.cacheWriteTokens || 0
                // 遍历过程中不断覆盖，最后一条即为最后一次请求
                currentInputTokens = s.inputTokens || 0
                currentOutputTokens = s.outputTokens || 0
                currentCacheReadTokens = s.cacheReadTokens || 0
                currentCacheWriteTokens = s.cacheWriteTokens || 0
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
            totalCacheWriteTokens,
            toolCallCount,
            currentInputTokens,
            currentOutputTokens,
            currentCacheReadTokens,
            currentCacheWriteTokens,
        }
    }, [loadedMessages])

    const cacheRead = stats.totalCacheReadTokens
    const cacheWrite = stats.totalCacheWriteTokens
    const cacheDenominator = cacheRead + cacheWrite
    const rate = cacheDenominator > 0 ? (cacheRead / cacheDenominator * 100).toFixed(0) : null
    const currentTotalTokens = stats.currentInputTokens + stats.currentCacheReadTokens

    if (stats.requestCount === 0) return null

    return (
        <div className="relative group">
            <span className="text-sm text-[var(--text-muted)] cursor-help tabular-nums leading-none">
                缓存 {rate}% · 窗口 {formatTokenCount(currentTotalTokens)}
            </span>
            <div
                className="absolute bottom-full right-0 mb-1 hidden group-hover:block z-50
                           bg-[var(--surface-elevated)] border border-[var(--border)]
                           rounded-lg shadow-overlay p-3 whitespace-nowrap min-w-[240px]">
                <div className="text-[11px] leading-relaxed text-[var(--text-primary)]">
                    {/* 标题行 */}
                    <div className="flex items-center gap-2 text-[var(--text-muted)] mb-1.5 pb-1.5 border-b border-[var(--border)]">
                        <span className="font-medium text-[var(--text-primary)]">缓存命中率 {rate}%</span>
                        <span>·</span>
                        <span>上下文窗口 {formatTokenCount(currentTotalTokens)}</span>
                        <span>·</span>
                        <span>LLM {stats.requestCount}次</span>
                        <span>·</span>
                        <span>工具 {stats.toolCallCount}次</span>
                    </div>

                    {/* 表头 */}
                    <div className="grid grid-cols-[3rem_1fr_1fr] gap-x-3 gap-y-1 text-[10px] text-[var(--text-muted)] mb-1">
                        <span/>
                        <span className="text-right">累计</span>
                        <span className="text-right">当前</span>
                    </div>

                    {/* 输入行 */}
                    <div className="grid grid-cols-[3rem_1fr_1fr] gap-x-3 gap-y-1">
                        <span className="text-[var(--text-muted)]">输入</span>
                        <span className="text-right tabular-nums">{formatTokenCount(stats.totalInputTokens)}</span>
                        <span className="text-right tabular-nums">{formatTokenCount(stats.currentInputTokens)}</span>
                    </div>

                    {/* 缓存读取（命中）行 */}
                    <div className="grid grid-cols-[3rem_1fr_1fr] gap-x-3 gap-y-1">
                        <span className="text-[var(--text-muted)]">读取</span>
                        <span className="text-right tabular-nums">{formatTokenCount(stats.totalCacheReadTokens)}</span>
                        <span className="text-right tabular-nums">{formatTokenCount(stats.currentCacheReadTokens)}</span>
                    </div>

                    {/* 缓存写入（未命中）行 */}
                    <div className="grid grid-cols-[3rem_1fr_1fr] gap-x-3 gap-y-1">
                        <span className="text-[var(--text-muted)]">写入</span>
                        <span className="text-right tabular-nums">{formatTokenCount(stats.totalCacheWriteTokens)}</span>
                        <span className="text-right tabular-nums">{formatTokenCount(stats.currentCacheWriteTokens)}</span>
                    </div>

                    {/* 输出行 */}
                    <div className="grid grid-cols-[3rem_1fr_1fr] gap-x-3 gap-y-1">
                        <span className="text-[var(--text-muted)]">输出</span>
                        <span className="text-right tabular-nums">{formatTokenCount(stats.totalOutputTokens)}</span>
                        <span className="text-right tabular-nums">{formatTokenCount(stats.currentOutputTokens)}</span>
                    </div>
                </div>
            </div>
        </div>
    )
})

export default CacheRateTooltip
