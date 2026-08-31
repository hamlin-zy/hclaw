import {useEffect, useMemo, useRef, useState} from 'react'
import {RefreshCw, RotateCcw, Database} from 'lucide-react'
import {formatTokenCompact, formatCost, formatTokensPerSecond, type Currency} from '../../lib/format'
import {useExchangeRateSync} from '../../hooks/useExchangeRateSync'
import {parseLocalDateStartMs} from '@shared/llmUsage'
import {
    ClientStatsNotice,
    InfoTip,
    getCostDisclaimer,
    providerDisplayName,
    CurrencyToggle,
    formatPricePerMillionTokens,
    Toast,
} from './statsParts'
import {UsageFilterBar} from './UsageFilterBar'
import {EMPTY_USAGE_FILTER, filterBreakdown, type UsageFilterState} from './usageFilter'
import type {GlobalUsageStats, TimeRange, TrendGranularity, UsageStatsQueryParams, UsageBreakdown} from '@shared/types'

type View = 'provider' | 'model'

/** 明细表排序键（name/provider 为文本列，其余数值列） */
type SortCol = 'name' | 'provider' | 'conversations' | 'avgSessionCost' | 'request' | 'avgTtft' | 'avgThroughput' | 'avgCacheHit' | 'input' | 'output' | 'cache' | 'total' | 'price' | 'cost' | 'pct'
/** 首次点击列头的默认方向：文本列升序、数值列降序（用量场景最常用） */
const SORT_DEFAULT_DIR: Record<SortCol, 1 | -1> = {
    name: 1, provider: 1, conversations: -1, avgSessionCost: -1, request: -1, avgTtft: -1, avgThroughput: -1, avgCacheHit: -1,
    input: -1, output: -1, cache: -1, total: -1, price: -1, cost: -1, pct: -1,
}
const TEXT_SORT_COLS = new Set<SortCol>(['name', 'provider'])

// ─── 行级指标（排序键与单元格展示共用同口径） ───
/** 平均首字延迟（秒）；无样本返回 0 */
const avgTtftSecondsOf = (b: UsageBreakdown): number => (b.ttftCount ?? 0) > 0 ? (b.ttftMs ?? 0) / (b.ttftCount ?? 1) / 1000 : 0
/** 平均吞吐（t/s）；无解码时长返回 0 */
const avgThroughputOf = (b: UsageBreakdown): number => (b.decodeMs ?? 0) > 0 ? b.outputTokens / ((b.decodeMs ?? 0) / 1000) : 0
/** 平均缓存命中率（%）；输入 + 缓存命中为 0 时返回 null（无法计算，展示为 —） */
const cacheHitPctOf = (b: UsageBreakdown): number | null => {
    const denom = b.inputTokens + b.cacheReadTokens
    return denom > 0 ? b.cacheReadTokens / denom * 100 : null
}

/** 分段控件按钮统一样式（时间范围 / 分组视图 / 货币切换三处复用） */
const SEGMENT_BTN = 'px-2.5 py-1 text-xs rounded-md transition-colors'
const SEGMENT_ACTIVE = 'bg-[var(--surface-elevated)] shadow-sm text-[var(--text-primary)] font-medium'
const SEGMENT_INACTIVE = 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'

/** 时间范围按钮顺序：今天 → 昨天 → 7天 → 30天 → 自定义，默认今天 */
const RANGE_OPTIONS: Array<{range: TimeRange; label: string}> = [
    {range: 'today', label: '今天'},
    {range: 'yesterday', label: '昨天'},
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
 * 趋势分组粒度：今天/昨天 → 按小时；自定义 ≤1 天（同日或相邻两天）→ 按小时；
 * 7天/30天/全部 → 按天；自定义 >1 天 → 按天
 */
function computeGranularity(range: TimeRange, custom: {start: string; end: string}): TrendGranularity {
    if (range === 'today' || range === 'yesterday') return 'hour'
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

/** 工具栏图标按钮（更新汇率 / 更新价目表）共享样式 */
const REFRESH_ICON_BTN_CLS = 'px-2 py-1 text-xs rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors'

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
    const syncedUsdCnyRate = useExchangeRateSync()
    const [usdCnyRate, setUsdCnyRate] = useState(syncedUsdCnyRate)
    const [range, setRange] = useState<TimeRange>('today')
    const [view, setView] = useState<View>('provider')
    const [currency, setCurrency] = useState<Currency>('CNY')
    // 自定义范围：默认最近 7 天（含今天），天级精度
    const [customRange, setCustomRange] = useState<{start: string; end: string}>(() => ({start: daysAgoLocal(6), end: todayLocal()}))
    const [refreshSeq, setRefreshSeq] = useState(0)
    const [refreshing, setRefreshing] = useState(false)
    const [refreshingExchangeRate, setRefreshingExchangeRate] = useState(false)
    const [refreshingModelMeta, setRefreshingModelMeta] = useState(false)
    const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const [data, setData] = useState<GlobalUsageStats | null>(null)
    const [error, setError] = useState(false)
    const [toast, setToast] = useState<{message: string; type: 'success' | 'error'} | null>(null)
    const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    // 同步外部汇率变化（主进程推送或其他窗口修改）
    useEffect(() => {
        setUsdCnyRate(syncedUsdCnyRate)
    }, [syncedUsdCnyRate])

    const showToast = (message: string, type: 'success' | 'error') => {
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
        setToast({message, type})
        toastTimerRef.current = setTimeout(() => setToast(null), 3000)
    }

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

    // 手动刷新（汇率 / 价目表）共用流程：busy 状态 + 结果 Toast；
    // successOf 返回成功文案，res 缺字段或异常时显示 failText
    const runRefresh = async (
        setBusy: (busy: boolean) => void,
        invoke: () => Promise<{rate?: number} | {count?: number} | null | undefined> | undefined,
        successOf: (res: {rate?: number; count?: number}) => string | null,
        failText: string,
    ) => {
        setBusy(true)
        try {
            const res = await invoke()
            const msg = res != null ? successOf(res) : null
            if (msg !== null) showToast(msg, 'success')
            else showToast(failText, 'error')
        } catch {
            showToast(failText, 'error')
        } finally {
            setBusy(false)
        }
    }

    // 更新汇率：调用主进程刷新汇率，成功后更新本地状态触发 UI 重渲染
    const handleExchangeRateRefresh = () => runRefresh(
        setRefreshingExchangeRate,
        () => window.electronAPI?.exchangeRateRefresh?.(),
        res => res.rate != null ? `汇率已更新: 1 USD ≈ ${res.rate.toFixed(4)} CNY` : null,
        '汇率更新失败',
    )

    // 更新价目表：调用主进程刷新模型元数据，成功后 Toast 提示
    const handleModelMetaRefresh = () => runRefresh(
        setRefreshingModelMeta,
        () => window.electronAPI?.modelMetaRefresh?.(),
        res => res.count != null ? `价目表已更新: ${res.count} 个模型` : null,
        '价目表更新失败',
    )

    useEffect(() => () => {
        if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    }, [])

    const granularity = computeGranularity(range, customRange)
    const maxTrend = data ? Math.max(...data.trend.map(t => t.inputTokens + t.outputTokens + t.cacheReadTokens), 1) : 1
    const grandTotal = data ? data.breakdown.reduce((s, b) => s + b.totalTokens, 0) : 0
    // 时序 KPI 直接消费主进程 computeKpis 结果（口径与消息 tooltip 一致，主进程统一计算）
    const avgDecodeRate = data ? (data.kpi.avgDecodeRate ?? null) : null
    const avgTtftSeconds = data ? (data.kpi.avgTtftSeconds ?? null) : null

    // ── 明细表排序：全列可点，本地 state（不持久化）；视图切换时重置（两视图列集不同）──
    const [sort, setSort] = useState<{col: SortCol; dir: 1 | -1} | null>(null)
    // ── 明细表过滤：服务商/模型下拉 + 合计 token 范围（M），仅作用于明细表行，视图切换时重置 ──
    const [filter, setFilter] = useState<UsageFilterState>(EMPTY_USAGE_FILTER)
    useEffect(() => {
        setSort(null)
        setFilter(EMPTY_USAGE_FILTER)
    }, [view])

    const toggleSort = (col: SortCol) => {
        setSort(s => s?.col === col ? {col, dir: (s.dir * -1) as 1 | -1} : {col, dir: SORT_DEFAULT_DIR[col]})
    }

/** 明细表共有列（两视图共用）；会话列 tip 因两视图数据口径不同而异 */
const detailColumns = (view: View): Array<{col: SortCol; label: string; tip?: string}> => [
    {col: 'conversations', label: '会话', tip: view === 'provider'
        ? '按「会话 × 模型」组合计数后跨模型累加：同一会话切换过多个模型或服务商时，会在每个模型/服务商下各计一次（非去重会话数）'
        : '组内去重会话数（同一会话切换模型会分别计入其他模型；历史 llm_stats 回填数据不含会话维度）'},
    {col: 'avgSessionCost', label: '平均会话成本', tip: '成本 ÷ 会话数（当前维度行的合计成本 ÷ 该行会话数）；会话数为 0 或无成本时不计'},
    {col: 'request', label: '请求'},
    {col: 'avgTtft', label: '平均首字', tip: 'Σ首字延迟 ÷ 携带首字延迟的调用数（秒）'},
    {col: 'avgThroughput', label: '平均吞吐', tip: 'Σ输出 tokens ÷ Σ解码时长（t/s）'},
    {col: 'avgCacheHit', label: '平均缓存命中率', tip: '缓存命中 ÷ (输入 + 缓存命中)，与 KPI 口径一致'},
    {col: 'input', label: '输入'},
    {col: 'output', label: '输出'},
    {col: 'cache', label: '缓存命中'},
    {col: 'total', label: '合计'},
    {col: 'price', label: '综合价格/M', tip: '总成本 USD ÷ (综合总 tokens / 1,000,000)，综合总 tokens = 输入 + 输出 + 缓存读取 + 缓存写入'},
    {col: 'cost', label: '成本', tip: getCostDisclaimer()},
    {col: 'pct', label: '占比'},
]

// 分组明细列定义：首列（及模型视图的第二列）按视图切换，其余列两视图共用
const columns: Array<{col: SortCol; label: string; tip?: string}> = [
    ...(view === 'provider'
        ? [{col: 'name' as SortCol, label: '服务商'}]
        : [{col: 'provider' as SortCol, label: '服务商'}, {col: 'name' as SortCol, label: '模型ID'}]),
    ...detailColumns(view),
]

    const breakdown = data?.breakdown ?? []
    // 明细表过滤（纯前端，仅影响明细行；KPI/趋势保持全量口径）
    const filteredBreakdown = useMemo(() => filterBreakdown(breakdown, filter), [breakdown, filter])
    const sortedBreakdown = useMemo(() => {
        if (!sort) return filteredBreakdown
        const {col, dir} = sort
        const text = (b: UsageBreakdown): string =>
            col === 'provider' ? (b.providerName || b.providerType || '')
                : col === 'name' ? (view === 'provider' ? (b.providerName || providerDisplayName(b.key)) : b.key)
                    : (b.providerName || b.providerType || '')
        // 行级均值列的排序键（与单元格展示同口径；无法计算时按 0 处理）
        const num = (b: UsageBreakdown): number => {
            switch (col) {
                case 'conversations': return b.conversationCount ?? 0
                case 'avgSessionCost': return (b.conversationCount ?? 0) > 0 ? b.costUsd / (b.conversationCount ?? 1) : 0 // USD 基准，与展示值同序
                case 'request': return b.requestCount
                case 'avgTtft': return avgTtftSecondsOf(b)
                case 'avgThroughput': return avgThroughputOf(b)
                case 'avgCacheHit': return cacheHitPctOf(b) ?? 0
                case 'input': return b.inputTokens
                case 'output': return b.outputTokens
                case 'cache': return b.cacheReadTokens
                case 'total': case 'pct': return b.totalTokens // 占比 ∝ 合计 tokens，同一排序键
                case 'price': return b.totalTokens > 0 ? b.costUsd / (b.totalTokens / 1_000_000) : 0 // USD 基准，与展示值同序
                case 'cost': return b.costUsd
                default: return 0
            }
        }
        const cmp = TEXT_SORT_COLS.has(col)
            ? (a: UsageBreakdown, b: UsageBreakdown) => text(a).localeCompare(text(b)) * dir
            : (a: UsageBreakdown, b: UsageBreakdown) => (num(a) - num(b)) * dir
        return [...filteredBreakdown].sort(cmp)
    }, [filteredBreakdown, sort, view])

    return (
        <div className="h-full flex flex-col">
            {/* 工具栏：时间范围（含自定义日历）+ 分组视图 + 货币切换 + 刷新 */}
            <div className="flex items-center gap-3 px-5 py-2.5 border-b border-[var(--border)] shrink-0 flex-wrap">
                <div className="flex gap-1 p-0.5 rounded-lg bg-[var(--surface-muted)] border border-[var(--border-muted)]">
                    {RANGE_OPTIONS.map(({range: r, label}) => (
                        <button key={r} data-testid={`range-${r}`} onClick={() => setRange(r)}
                                className={`${SEGMENT_BTN} ${range === r ? SEGMENT_ACTIVE : SEGMENT_INACTIVE}`} data-name="usage-window-button">
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
                        data-name="usage-window-input"/>
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
                        data-name="usage-window-range-end-input"/>
                    </div>
                )}
                <div className="flex gap-1 p-0.5 rounded-lg bg-[var(--surface-muted)] border border-[var(--border-muted)]">
                    {(['provider', 'model'] as View[]).map((v, i) => (
                        <button key={v} onClick={() => setView(v)}
                                className={`${SEGMENT_BTN} ${view === v ? SEGMENT_ACTIVE : SEGMENT_INACTIVE}`} data-name={`usage-window-view-${i}`}>
                            {v === 'provider' ? '按服务商' : '按模型'}
                        </button>
                    ))}
                </div>
                {/* 美元 / 人民币切换（共享 CurrencyToggle，与右键弹窗同口径）+ 成本口径说明 */}
                <CurrencyToggle currency={currency} onChange={setCurrency}/>
                <InfoTip text={getCostDisclaimer()} />
                {/* 更新汇率 / 更新价目表（刷新按钮左侧） */}
                <div className="flex gap-1 ml-2">
                    <button
                        onClick={handleExchangeRateRefresh}
                        disabled={refreshingExchangeRate}
                        aria-label="更新汇率"
                        title="更新汇率（从 currency-api 拉取最新 USD→CNY 汇率）"
                        className={REFRESH_ICON_BTN_CLS}
                     data-name="usage-window-refresh-rate-button">
                        <RotateCcw className={`w-3.5 h-3.5 ${refreshingExchangeRate ? 'animate-spin' : ''}`}/>
                    </button>
                    <button
                        onClick={handleModelMetaRefresh}
                        disabled={refreshingModelMeta}
                        aria-label="更新价目表"
                        title="更新价目表（从 OpenRouter 拉取最新模型定价）"
                        className={REFRESH_ICON_BTN_CLS}
                     data-name="usage-window-refresh-model-meta-button">
                        <Database className={`w-3.5 h-3.5 ${refreshingModelMeta ? 'animate-spin' : ''}`}/>
                    </button>
                </div>
                {/* 刷新按钮（靠右） */}
                <button
                    onClick={handleRefresh}
                    aria-label="刷新"
                    title="刷新统计"
                    className="ml-auto p-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)] transition-colors"
                 data-name="usage-window-refresh-button">
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
                        <section className="rounded-lg border border-[var(--border)]">
                            <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-[var(--border)] bg-[var(--surface-muted)] flex-wrap">
                                <div className="text-xs font-semibold text-[var(--text-primary)]">
                                    {view === 'provider' ? '服务商明细' : '模型明细'}
                                </div>
                                <UsageFilterBar view={view} rows={breakdown} filter={filter} onChange={setFilter}/>
                                <div className="text-[11px] text-[var(--text-muted)]">
                                    {filteredBreakdown.length !== breakdown.length
                                        ? `${filteredBreakdown.length} / ${breakdown.length} 项`
                                        : `${breakdown.length} 项`}
                                </div>
                            </div>
                            {data.breakdown.length === 0 ? (
                                <div className="py-12 text-center text-sm text-[var(--text-muted)]">暂无用量数据</div>
                            ) : filteredBreakdown.length === 0 ? (
                                <div className="py-12 text-center text-sm text-[var(--text-muted)]">无符合过滤条件的数据</div>
                            ) : (
                                <table className="w-full text-xs">
                                    <thead>
                                        <tr className="bg-[var(--surface-muted)] text-[var(--text-muted)] border-b border-[var(--border)]">
                                            {columns.map(({col, label, tip}, idx) => (
                                                <th key={col}
                                                    onClick={() => toggleSort(col)}
                                                    title="点击排序"
                                                    className={`font-medium px-3 py-2.5 select-none cursor-pointer hover:text-[var(--text-primary)] transition-colors text-center ${idx === 0 ? 'px-4' : ''}`} data-name="usage-window-th">
                                                    <span className="inline-flex items-center justify-center gap-1">
                                                        {label}
                                                        {tip && <InfoTip text={tip} placement="top"/>}
                                                        {sort?.col === col && (
                                                            <span className="text-[9px] text-[var(--brand-primary)]">{sort.dir === 1 ? '▲' : '▼'}</span>
                                                        )}
                                                    </span>
                                                </th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {sortedBreakdown.map(b => {
                                            const pct = grandTotal > 0 ? Math.round(b.totalTokens / grandTotal * 100) : 0
                                            // 唯一 React key：SQL GROUP BY 维度 = (provider_id, provider_name, provider_type, model)。
                                            // key 必须含 providerId：同一服务商删除重建后 provider_id 不同、provider_name 相同，
                                            // 仅按 name+model 组键会撞 key → React reconciliation 视图切换时累积重复行。
                                            const rowKey = `${b.providerId ?? ''}\u0000${b.providerName ?? b.providerType ?? ''}\u0000${b.key}`
                                            // 综合百万 Tokens 价格：总成本 / (综合总 tokens / 1_000_000)
                                            // 综合总 tokens = input + output + cacheRead + cacheWrite (即 totalTokens)
                                            // 单位随 currency 切换（USD 显示 $，CNY 显示 ¥，按实时汇率换算）
                                            const pricePerMillion = formatPricePerMillionTokens(
                                                b.costUsd,
                                                b.inputTokens,
                                                b.outputTokens,
                                                b.cacheReadTokens,
                                                b.cacheWriteTokens,
                                                currency
                                            )
                                            return (
                                                <tr key={rowKey} className="border-t border-[var(--border-muted)] tabular-nums hover:bg-[var(--surface-muted)] transition-colors">
                                                    {view === 'provider' ? (
                                                        <td className="px-4 py-2.5 font-medium text-left">
                                                            <div className="flex items-center gap-2">
                                                                <span className="w-1.5 h-1.5 rounded-full bg-[var(--brand-primary)] shrink-0"/>
                                                                <span className="break-all">{b.providerName || providerDisplayName(b.key)}</span>
                                                            </div>
                                                        </td>
                                                    ) : (
                                                        <>
                                                            <td className="px-4 py-2.5 text-left text-[var(--text-secondary)] max-w-[140px] truncate" title={b.providerName || b.providerType || ''}>
                                                                {b.providerName || providerDisplayName(b.providerType || '')}
                                                            </td>
                                                            <td className="px-3 py-2.5 font-medium text-left">
                                                                <div className="flex items-center gap-2">
                                                                    <span className="w-1.5 h-1.5 rounded-full bg-[var(--brand-primary)] shrink-0"/>
                                                                    <span className="break-all">{b.key}</span>
                                                                </div>
                                                            </td>
                                                        </>
                                                    )}
                                                    <td className="px-3 py-2.5 text-right text-[var(--text-secondary)]">{(b.conversationCount ?? 0) > 0 ? b.conversationCount : '—'}</td>
                                                    <td className="px-3 py-2.5 text-right text-[var(--text-secondary)]">
                                                        {(b.conversationCount ?? 0) > 0 && b.costUsd > 0 ? formatCost(b.costUsd / (b.conversationCount ?? 1), currency) : '—'}
                                                    </td>
                                                    <td className="px-3 py-2.5 text-right text-[var(--text-secondary)]">{b.requestCount}</td>
                                                    <td className="px-3 py-2.5 text-right text-[var(--text-secondary)]">
                                                        {(b.ttftCount ?? 0) > 0 ? `${avgTtftSecondsOf(b).toFixed(1)}s` : '—'}
                                                    </td>
                                                    <td className="px-3 py-2.5 text-right text-[var(--text-secondary)]">
                                                        {(b.decodeMs ?? 0) > 0 ? `${formatTokensPerSecond(avgThroughputOf(b))} t/s` : '—'}
                                                    </td>
                                                    <td className="px-3 py-2.5 text-right text-[var(--text-secondary)]">
                                                        {cacheHitPctOf(b) != null ? `${Math.round(cacheHitPctOf(b)!)}%` : '—'}
                                                    </td>
                                                    <td className="px-3 py-2.5 text-right text-[var(--text-secondary)]">{formatTokenCompact(b.inputTokens)}</td>
                                                    <td className="px-3 py-2.5 text-right text-[var(--text-secondary)]">{formatTokenCompact(b.outputTokens)}</td>
                                                    <td className="px-3 py-2.5 text-right text-[var(--text-secondary)]">{b.cacheReadTokens > 0 ? formatTokenCompact(b.cacheReadTokens) : '—'}</td>
                                                    <td className="px-3 py-2.5 text-right font-medium">{formatTokenCompact(b.totalTokens)}</td>
                                                    <td className="px-3 py-2.5 text-right text-[var(--text-primary)] font-medium tabular-nums">{pricePerMillion}</td>
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
            {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)}/>}
        </div>
    )
}
