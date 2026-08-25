import {useEffect, useRef, useState} from 'react'
import {RefreshCw} from 'lucide-react'
import {formatTokenCompact, formatCost, formatTokensPerSecond, type Currency} from '../../lib/format'
import {useExchangeRateSync} from '../../hooks/useExchangeRateSync'
import {duplicatedModelKeys, parseLocalDateStartMs} from '@shared/llmUsage'
import {ClientStatsNotice, InfoTip, getCostDisclaimer, providerDisplayName, CurrencyToggle} from './statsParts'
import type {GlobalUsageStats, TimeRange, TrendGranularity, UsageStatsQueryParams} from '@shared/types'

type View = 'provider' | 'model'

/** 分段控件按钮统一样式（时间范围 / 分组视图 / 货币切换三处复用） */
const SEGMENT_BTN = 'px-2.5 py-1 text-xs rounded-md transition-colors'
const SEGMENT_ACTIVE = 'bg-[var(--surface-elevated)] shadow-sm text-[var(--text-primary)] font-medium'
const SEGMENT_INACTIVE = 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'

/** 时间范围按钮顺序（任务 03a：全部 → 今天 → 7天 → 30天 → 自定义，默认今天） */
const RANGE_OPTIONS: Array<{range: TimeRange; label: string}> = [
    {range: 'all', label: '全部'},
    {range: 'today', label: '今天'},
    {range: '7d', label: '近 7 天'},
    {range: '30d', label: '近 30 天'},
    {range: 'custom', label: '自定义'},
]

/** 本地时区 'YYYY-MM-DD' */
function formatLocalDate(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 本地时区 'YYYY-MM-DD'（今天） */
function todayLocal(): string {
    return formatLocalDate(new Date())
}

/** 本地时区 'YYYY-MM-DD'（n 天前） */
function daysAgoLocal(n: number): string {
    const d = new Date()
    d.setDate(d.getDate() - n)
    return formatLocalDate(d)
}

/**
 * 趋势分组粒度：今天 → 按小时；自定义 ≤1 天（同日或相邻两天）→ 按小时；
 * 7天/30天/全部 → 按天；自定义 >1 天 → 按天
 */
function computeGranularity(range: TimeRange, custom: {start: string; end: string}): TrendGranularity {
    if (range === 'today') return 'hour'
    if (range === 'custom') {
        const dayDiff = Math.round((parseLocalDateStartMs(custom.end) - parseLocalDateStartMs(custom.start)) / 86400000)
        return dayDiff <= 1 ? 'hour' : 'day'
    }
    return 'day'
}

/** 趋势条标签：按小时显示 'HH:00'（数据兼容 day 格式时回退 'MM-DD'），按天显示 'MM-DD' */
function trendLabel(day: string, granularity: TrendGranularity): string {
    if (granularity === 'hour' && day.length > 10) return day.slice(11, 16)
    return day.slice(5)
}

/** 趋势柱状条（纯 CSS，零图表库） */
function TrendBar({value, max, label, isToday}: {value: number; max: number; label: string; isToday: boolean}) {
    const h = Math.max(2, Math.round(value / max * 100))
    return (
        <div className="flex-1 flex flex-col items-center justify-end gap-1.5 h-full" data-testid="trend-bar">
            <div className={`text-[9.5px] tabular-nums ${isToday ? 'text-[var(--brand-primary)] font-semibold' : 'text-[var(--text-tertiary)]'}`}>
                {formatTokenCompact(value)}
            </div>
            <div
                className={`w-full max-w-[42px] rounded-t bg-[var(--brand-primary)] ${isToday ? '' : 'opacity-55'}`}
                style={{height: `${h}%`}}
            />
            <div className={`text-[9.5px] tabular-nums ${isToday ? 'text-[var(--text-primary)] font-medium' : 'text-[var(--text-muted)]'}`}>{label}</div>
        </div>
    )
}

export default function UsageWindow() {
    // 独立窗口为独立渲染进程：挂载时同步主进程实时汇率（与主窗口 App.tsx 同源），
    // 否则 CNY 成本换算 / InfoTip 口径文案恒为默认 7.2，与右键菜单用量统计弹窗不一致
    const usdCnyRate = useExchangeRateSync()
    const [range, setRange] = useState<TimeRange>('today')
    const [view, setView] = useState<View>('provider')
    const [currency, setCurrency] = useState<Currency>('CNY')
    // 自定义范围：默认最近 7 天（含今天），天级精度
    const [customRange, setCustomRange] = useState<{start: string; end: string}>(() => ({start: daysAgoLocal(6), end: todayLocal()}))
    const [refreshSeq, setRefreshSeq] = useState(0)
    const [refreshing, setRefreshing] = useState(false)
    const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const [data, setData] = useState<GlobalUsageStats | null>(null)
    const [error, setError] = useState(false)

    useEffect(() => {
        let cancelled = false
        setError(false)
        const granularity = computeGranularity(range, customRange)
        const params: UsageStatsQueryParams = {
            range, view, granularity,
            ...(range === 'custom' ? {customStart: customRange.start, customEnd: customRange.end} : {}),
        }
        window.electronAPI?.usageStatsQuery?.(params)
            .then((d) => { if (!cancelled) setData(d) })
            .catch(() => { if (!cancelled) setError(true) })
        return () => { cancelled = true }
    }, [range, view, customRange, refreshSeq])

    // 刷新：重新拉取数据（图标转圈 600ms 反馈）
    const handleRefresh = () => {
        setRefreshing(true)
        setRefreshSeq(s => s + 1)
        if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
        refreshTimerRef.current = setTimeout(() => setRefreshing(false), 600)
    }
    useEffect(() => () => {
        if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
    }, [])

    const granularity = computeGranularity(range, customRange)
    const maxTrend = data ? Math.max(...data.trend.map(t => t.inputTokens + t.outputTokens + t.cacheReadTokens), 1) : 1
    const grandTotal = data ? data.breakdown.reduce((s, b) => s + b.totalTokens, 0) : 0
    // 同名模型跨服务商检测：模型视图出现重复模型名（不同服务商提供同名模型）时增强展示，
    // 让用户明确两行同名数据的差异来源是服务商（价格/延迟可能不同）
    const dupModels = duplicatedModelKeys(data?.breakdown ?? [])
    const isDupModel = (key: string) => dupModels.has(key)
    // 时序 KPI 直接消费主进程 computeKpis 结果（口径与消息 tooltip 一致，主进程统一计算）
    const avgDecodeRate = data ? (data.kpi.avgDecodeRate ?? null) : null
    const avgTtftSeconds = data ? (data.kpi.avgTtftSeconds ?? null) : null

    return (
        <div className="h-full flex flex-col">
            {/* 工具栏：时间范围（含自定义日历）+ 分组视图 + 货币切换 + 刷新 */}
            <div className="flex items-center gap-3 px-5 py-2.5 border-b border-[var(--border)] shrink-0 flex-wrap">
                <div className="flex gap-1 p-0.5 rounded-lg bg-[var(--surface-muted)] border border-[var(--border-muted)]">
                    {RANGE_OPTIONS.map(({range: r, label}) => (
                        <button key={r} data-testid={`range-${r}`} onClick={() => setRange(r)}
                                className={`${SEGMENT_BTN} ${range === r ? SEGMENT_ACTIVE : SEGMENT_INACTIVE}`}>
                            {label}
                        </button>
                    ))}
                </div>
                {/* 自定义日期范围选择器（天级精度，闭区间） */}
                {range === 'custom' && (
                    <div className="flex items-center gap-1.5 px-0.5" data-testid="custom-range-picker">
                        <input
                            type="date"
                            data-testid="custom-start"
                            value={customRange.start}
                            max={customRange.end}
                            onChange={(e) => {
                                if (e.target.value) setCustomRange(c => ({...c, start: e.target.value}))
                            }}
                            className="rounded-md border border-[var(--border)] bg-[var(--surface-muted)] px-2 py-1 text-xs text-[var(--text-primary)] tabular-nums outline-none focus:border-[var(--brand-border)] transition-colors"
                        />
                        <span className="text-xs text-[var(--text-muted)]">至</span>
                        <input
                            type="date"
                            data-testid="custom-end"
                            value={customRange.end}
                            min={customRange.start}
                            max={todayLocal()}
                            onChange={(e) => {
                                if (e.target.value) setCustomRange(c => ({...c, end: e.target.value}))
                            }}
                            className="rounded-md border border-[var(--border)] bg-[var(--surface-muted)] px-2 py-1 text-xs text-[var(--text-primary)] tabular-nums outline-none focus:border-[var(--brand-border)] transition-colors"
                        />
                    </div>
                )}
                <div className="flex gap-1 p-0.5 rounded-lg bg-[var(--surface-muted)] border border-[var(--border-muted)]">
                    {(['provider', 'model'] as View[]).map(v => (
                        <button key={v} onClick={() => setView(v)}
                                className={`${SEGMENT_BTN} ${view === v ? SEGMENT_ACTIVE : SEGMENT_INACTIVE}`}>
                            {v === 'provider' ? '按服务商' : '按模型'}
                        </button>
                    ))}
                </div>
                {/* 美元 / 人民币切换（共享 CurrencyToggle，与右键弹窗同口径）+ 成本口径说明 */}
                <CurrencyToggle currency={currency} onChange={setCurrency}/>
                <InfoTip text={getCostDisclaimer()} />
                {/* 刷新按钮（靠右） */}
                <button
                    onClick={handleRefresh}
                    aria-label="刷新"
                    title="刷新统计"
                    className="ml-auto p-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)] transition-colors"
                >
                    <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`}/>
                </button>
            </div>

            {/* 主体 */}
            <div className="flex-1 overflow-y-auto p-5 space-y-5">
                {error && (
                    <div className="rounded-lg border border-[var(--border)] py-12 text-center">
                        <div className="text-sm text-[var(--error)]">统计数据加载失败</div>
                    </div>
                )}
                {!data && !error && (
                    <div className="rounded-lg border border-[var(--border)] py-12 flex items-center justify-center gap-2 text-sm text-[var(--text-muted)]">
                        <div className="w-4 h-4 border-2 border-[var(--brand-primary)] border-t-transparent rounded-full animate-spin"/>
                        加载中…
                    </div>
                )}
                {data && (
                    <>
                        {/* 关键指标：总成本为主，其余为辅助 */}
                        <section className="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)]">
                            <div className="grid grid-cols-2 md:grid-cols-6">
                                <div className="p-4">
                                    <div className="flex items-center gap-1 text-[11px] text-[var(--text-muted)]">
                                        总成本
                                        <InfoTip text={getCostDisclaimer()}/>
                                    </div>
                                    <div className="mt-1 text-2xl font-semibold tabular-nums leading-none text-[var(--brand-primary)]">
                                        {formatCost(data.kpi.totalCostUsd, currency)}
                                    </div>
                                    <div className="mt-1.5 text-[10px] text-[var(--text-muted)]">
                                        {currency === 'USD' ? '美元计价' : `按 1 USD ≈ ${usdCnyRate.toFixed(2)} CNY`}
                                    </div>
                                </div>
                                <div className="p-4 border-l border-[var(--border)]">
                                    <div className="text-[11px] text-[var(--text-muted)]">总 token</div>
                                    <div className="mt-1 text-xl font-semibold tabular-nums leading-none text-[var(--text-primary)]">{formatTokenCompact(data.kpi.totalTokens)}</div>
                                </div>
                                <div className="p-4 border-l border-[var(--border)]">
                                    <div className="text-[11px] text-[var(--text-muted)]">LLM 请求</div>
                                    <div className="mt-1 text-xl font-semibold tabular-nums leading-none text-[var(--text-primary)]">{data.kpi.requestCount} 次</div>
                                </div>
                                <div className="p-4 border-l border-[var(--border)]">
                                    <div className="text-[11px] text-[var(--text-muted)]">缓存命中率</div>
                                    <div className="mt-1 text-xl font-semibold tabular-nums leading-none text-[var(--text-primary)]">{data.kpi.cacheHitRate != null ? `${data.kpi.cacheHitRate}%` : '—'}</div>
                                </div>
                                <div className="p-4 border-l border-[var(--border)]">
                                    <div className="text-[11px] text-[var(--text-muted)]">平均吞吐</div>
                                    <div className="mt-1 text-xl font-semibold tabular-nums leading-none text-[var(--text-primary)]">
                                        {avgDecodeRate != null ? `${formatTokensPerSecond(avgDecodeRate)} t/s` : '—'}
                                    </div>
                                </div>
                                <div className="p-4 border-l border-[var(--border)]">
                                    <div className="text-[11px] text-[var(--text-muted)]">平均首字</div>
                                    <div className="mt-1 text-xl font-semibold tabular-nums leading-none text-[var(--text-primary)]">
                                        {avgTtftSeconds != null ? `${avgTtftSeconds.toFixed(1)}s` : '—'}
                                    </div>
                                </div>
                            </div>
                        </section>

                        {/* 趋势 */}
                        <section className="rounded-lg border border-[var(--border)] overflow-hidden">
                            <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--border)] bg-[var(--surface-muted)]">
                                <div className="text-xs font-semibold text-[var(--text-primary)]">Token 消耗趋势</div>
                                <div className="text-[11px] text-[var(--text-muted)]">{granularity === 'hour' ? '按小时' : '按天'}</div>
                            </div>
                            <div className="px-4 pt-4 pb-2">
                                <div className="flex items-end gap-2 h-32 border-b border-[var(--border)]">
                                    {data.trend.map((t, i) => (
                                        <TrendBar key={`${granularity}-${t.day}`} value={t.inputTokens + t.outputTokens + t.cacheReadTokens}
                                                  max={maxTrend} label={trendLabel(t.day, granularity)} isToday={i === data.trend.length - 1}/>
                                    ))}
                                </div>
                            </div>
                        </section>

                        {/* 分组明细表 */}
                        <section className="rounded-lg border border-[var(--border)] overflow-hidden">
                            <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--border)] bg-[var(--surface-muted)]">
                                <div className="text-xs font-semibold text-[var(--text-primary)]">
                                    {view === 'provider' ? '服务商明细' : '模型明细'}
                                </div>
                                <div className="text-[11px] text-[var(--text-muted)]">{data.breakdown.length} 项</div>
                            </div>
                            {data.breakdown.length === 0 ? (
                                <div className="py-12 text-center text-sm text-[var(--text-muted)]">暂无用量数据</div>
                            ) : (
                                <table className="w-full text-xs">
                                    <thead>
                                        <tr className="bg-[var(--surface-muted)] text-[var(--text-muted)] border-b border-[var(--border)]">
                                            {['名称', '请求', '输入', '输出', '缓存命中', '合计', '成本', '占比'].map(h => (
                                                <th key={h} className="text-right font-medium px-3 py-2.5 first:text-left first:px-4">
                                                    {h === '成本' ? (
                                                        <span className="inline-flex items-center justify-end gap-1">
                                                            成本
                                                            <InfoTip text={getCostDisclaimer()}/>
                                                        </span>
                                                    ) : h}
                                                </th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {data.breakdown.map(b => {
                                            const pct = grandTotal > 0 ? Math.round(b.totalTokens / grandTotal * 100) : 0
                                            // 唯一 React key：provider 视图 key 是服务商名（唯一）；
                                            // model 视图 key 是模型名，同名模型可能跨服务商出现（如 deepseek-v4-flash），
                                            // 需组合服务商名/类型避免 key 冲突导致 reconciliation 错乱、数据叠加。
                                            const rowKey = (b.providerName || b.providerType) ? `${b.providerName ?? b.providerType}\u0000${b.key}` : b.key
                                            // 同名模型跨服务商：小字 via 高亮 + 「同名」徽章，明确两行同名数据的差异来源
                                            const dupModel = view === 'model' && isDupModel(b.key)
                                            return (
                                                <tr key={rowKey} className="border-t border-[var(--border-muted)] tabular-nums hover:bg-[var(--surface-muted)] transition-colors">
                                                    <td className="px-4 py-2.5 font-medium text-left">
                                                        <div className="flex items-center gap-2">
                                                            <span className="w-1.5 h-1.5 rounded-full bg-[var(--brand-primary)] shrink-0"/>
                                                            <div>
                                                                <div className="flex items-center gap-1.5">
                                                                    <span>{view === 'provider' ? (b.providerName || providerDisplayName(b.key)) : b.key}</span>
                                                                    {dupModel && (
                                                                        <span title="同名模型由不同服务商提供，价格/延迟可能不同"
                                                                              className="rounded border border-[var(--border)] bg-[var(--surface-muted)] px-1 py-px text-[9px] font-medium text-[var(--brand-primary)]">
                                                                            同名
                                                                        </span>
                                                                    )}
                                                                </div>
                                                                {view === 'model' && b.providerType && (
                                                                    <div className={`text-[10px] font-normal ${dupModel ? 'font-medium text-[var(--brand-primary)]' : 'text-[var(--text-muted)]'}`}>
                                                                        {dupModel ? `via ${b.providerName || b.providerType}` : (b.providerName || b.providerType)}
                                                                    </div>
                                                                )}
                                                            </div>
                                                        </div>
                                                    </td>
                                                    <td className="px-3 py-2.5 text-right text-[var(--text-secondary)]">{b.requestCount}</td>
                                                    <td className="px-3 py-2.5 text-right text-[var(--text-secondary)]">{formatTokenCompact(b.inputTokens)}</td>
                                                    <td className="px-3 py-2.5 text-right text-[var(--text-secondary)]">{formatTokenCompact(b.outputTokens)}</td>
                                                    <td className="px-3 py-2.5 text-right text-[var(--text-secondary)]">{b.cacheReadTokens > 0 ? formatTokenCompact(b.cacheReadTokens) : '—'}</td>
                                                    <td className="px-3 py-2.5 text-right font-medium">{formatTokenCompact(b.totalTokens)}</td>
                                                    <td className="px-3 py-2.5 text-right text-[var(--brand-primary)] font-medium">{b.costUsd > 0 ? formatCost(b.costUsd, currency) : '—'}</td>
                                                    <td className="px-3 py-2.5 text-right">
                                                        <div className="flex items-center justify-end gap-2">
                                                            <div className="w-12 h-1 rounded-full bg-[var(--border)] overflow-hidden">
                                                                <div className="h-full rounded-full bg-[var(--brand-primary)]" style={{width: `${Math.max(pct, 2)}%`}}/>
                                                            </div>
                                                            <span className="w-8 text-[var(--text-tertiary)]">{pct}%</span>
                                                        </div>
                                                    </td>
                                                </tr>
                                            )
                                        })}
                                    </tbody>
                                </table>
                            )}
                        </section>

                        {/* 数据口径提示：客户端侧统计，非服务商账单 */}
                        <ClientStatsNotice centered/>
                    </>
                )}
            </div>
        </div>
    )
}
