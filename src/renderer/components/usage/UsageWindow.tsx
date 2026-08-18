import {useEffect, useState} from 'react'
import {formatTokenCompact, formatCost, USD_TO_CNY_RATE, type Currency} from '../../lib/format'
import {useThemeSync} from '../../lib/theme'
import type {GlobalUsageStats, TimeRange} from '@shared/types'

type View = 'provider' | 'model'

/** 已知服务商类型的规范展示名（openai → OpenAI 等首字母缩写） */
const PROVIDER_DISPLAY: Record<string, string> = {
    anthropic: 'Anthropic',
    openai: 'OpenAI',
    google: 'Google',
    ollama: 'Ollama',
}

/** 分段控件按钮统一样式（时间范围 / 分组视图 / 货币切换三处复用） */
const SEGMENT_BTN = 'px-2.5 py-1 text-xs rounded-md transition-colors'
const SEGMENT_ACTIVE = 'bg-[var(--surface-elevated)] shadow-sm text-[var(--text-primary)] font-medium'
const SEGMENT_INACTIVE = 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'

/** 分组名称展示：provider 视图用规范名（未知类型回退首字母大写），model 视图原样 */
function displayName(key: string, view: View): string {
    if (view === 'provider') {
        return PROVIDER_DISPLAY[key] ?? (key.length > 0 ? key[0].toUpperCase() + key.slice(1) : key)
    }
    return key
}

/** 趋势柱状条（纯 CSS，零图表库） */
function TrendBar({value, max, day, isToday}: {value: number; max: number; day: string; isToday: boolean}) {
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
            <div className={`text-[9.5px] tabular-nums ${isToday ? 'text-[var(--text-primary)] font-medium' : 'text-[var(--text-muted)]'}`}>{day}</div>
        </div>
    )
}

export default function UsageWindow() {
    useThemeSync()
    const [range, setRange] = useState<TimeRange>('7d')
    const [view, setView] = useState<View>('provider')
    const [currency, setCurrency] = useState<Currency>('USD')
    const [data, setData] = useState<GlobalUsageStats | null>(null)
    const [error, setError] = useState(false)
    const [isMaximized, setIsMaximized] = useState(false)

    // 无边框窗口：最大化状态同步（更新最大化/还原按钮）
    useEffect(() => {
        const api = window.electronAPI
        if (!api?.usageWindowIsMaximized) return
        void api.usageWindowIsMaximized().then(setIsMaximized)
        return api.onUsageWindowMaximizedChange?.(setIsMaximized)
    }, [])

    useEffect(() => {
        let cancelled = false
        setError(false)
        window.electronAPI?.usageStatsQuery?.({range, view})
            .then((d) => { if (!cancelled) setData(d) })
            .catch(() => { if (!cancelled) setError(true) })
        return () => { cancelled = true }
    }, [range, view])

    const maxTrend = data ? Math.max(...data.trend.map(t => t.inputTokens + t.outputTokens + t.cacheReadTokens), 1) : 1
    const grandTotal = data ? data.breakdown.reduce((s, b) => s + b.totalTokens, 0) : 0

    return (
        <div className="h-screen flex flex-col bg-[var(--surface)] text-[var(--text-primary)] font-['Inter',sans-serif]">
            {/* 自定义标题栏（无边框窗口拖拽 + 窗口控制） */}
            <header className="titlebar shrink-0">
                <div className="titlebar-content">
                    <div className="titlebar-left no-drag">
                        <div className="logo-container">
                            <span className="logo-icon">
                                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                                    <line x1="4" y1="20" x2="4" y2="14"/><line x1="10" y1="20" x2="10" y2="4"/><line x1="16" y1="20" x2="16" y2="10"/>
                                </svg>
                            </span>
                            <span className="logo-text">用量统计</span>
                        </div>
                    </div>
                    <div className="titlebar-center drag-region" />
                    <div className="titlebar-right no-drag">
                        <div className="window-controls">
                            <button className="window-control-btn" onClick={() => window.electronAPI?.usageWindowMinimize?.()} aria-label="最小化">
                                <MinimizeIcon/>
                            </button>
                            <button className="window-control-btn" onClick={() => window.electronAPI?.usageWindowMaximize?.()} aria-label={isMaximized ? '还原' : '最大化'}>
                                {isMaximized ? <RestoreIcon/> : <MaximizeIcon/>}
                            </button>
                            <button className="window-control-btn window-control-btn--close" onClick={() => window.electronAPI?.usageWindowClose?.()} aria-label="关闭">
                                <CloseIcon/>
                            </button>
                        </div>
                    </div>
                </div>
            </header>

            {/* 工具栏：时间范围 + 分组视图 + 货币切换 */}
            <div className="flex items-center gap-3 px-5 py-2.5 border-b border-[var(--border)] shrink-0 flex-wrap">
                <div className="flex gap-1 p-0.5 rounded-lg bg-[var(--surface-muted)] border border-[var(--border-muted)]">
                    {(['today', '7d', '30d', 'all'] as TimeRange[]).map(r => (
                        <button key={r} data-testid={`range-${r}`} onClick={() => setRange(r)}
                                className={`${SEGMENT_BTN} ${range === r ? SEGMENT_ACTIVE : SEGMENT_INACTIVE}`}>
                            {{today: '今天', '7d': '近 7 天', '30d': '近 30 天', all: '全部'}[r]}
                        </button>
                    ))}
                </div>
                <div className="flex gap-1 p-0.5 rounded-lg bg-[var(--surface-muted)] border border-[var(--border-muted)]">
                    {(['provider', 'model'] as View[]).map(v => (
                        <button key={v} onClick={() => setView(v)}
                                className={`${SEGMENT_BTN} ${view === v ? SEGMENT_ACTIVE : SEGMENT_INACTIVE}`}>
                            {v === 'provider' ? '按服务商' : '按模型'}
                        </button>
                    ))}
                </div>
                {/* 美元 / 人民币切换 */}
                <div className="flex items-center gap-1 p-0.5 rounded-lg bg-[var(--surface-muted)] border border-[var(--border-muted)] ml-auto">
                    {(['USD', 'CNY'] as Currency[]).map(c => (
                        <button key={c} onClick={() => setCurrency(c)} data-testid={`currency-${c.toLowerCase()}`}
                                className={`${SEGMENT_BTN} ${currency === c ? SEGMENT_ACTIVE : SEGMENT_INACTIVE}`}>
                            {c === 'USD' ? '$ 美元' : '¥ 人民币'}
                        </button>
                    ))}
                </div>
                <InfoTip text="成本为估算值，仅供对照：输入 / 输出 / 缓存命中 token 分别按模型单价计费；未定价模型显示「—」，不计入合计；人民币按固定汇率 7.2 折算，非实时行情。实际账单请以服务商官方为准。" />
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
                        <section className="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] overflow-hidden">
                            <div className="grid grid-cols-2 md:grid-cols-4">
                                <div className="p-4">
                                    <div className="text-[11px] text-[var(--text-muted)]">总成本</div>
                                    <div className="mt-1 text-2xl font-semibold tabular-nums leading-none text-[var(--brand-primary)]">
                                        {formatCost(data.kpi.totalCostUsd, currency)}
                                    </div>
                                    <div className="mt-1.5 text-[10px] text-[var(--text-muted)]">
                                        {currency === 'USD' ? '美元计价' : `按 1 USD ≈ ${USD_TO_CNY_RATE} CNY`}
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
                            </div>
                        </section>

                        {/* 趋势 */}
                        <section className="rounded-lg border border-[var(--border)] overflow-hidden">
                            <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--border)] bg-[var(--surface-muted)]">
                                <div className="text-xs font-semibold text-[var(--text-primary)]">Token 消耗趋势</div>
                                <div className="text-[11px] text-[var(--text-muted)]">按天</div>
                            </div>
                            <div className="px-4 pt-4 pb-2">
                                <div className="flex items-end gap-2 h-32 border-b border-[var(--border)]">
                                    {data.trend.map((t, i) => (
                                        <TrendBar key={t.day} value={t.inputTokens + t.outputTokens + t.cacheReadTokens}
                                                  max={maxTrend} day={t.day.slice(5)} isToday={i === data.trend.length - 1}/>
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
                                                <th key={h} className="text-right font-medium px-3 py-2.5 first:text-left first:px-4">{h}</th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {data.breakdown.map(b => {
                                            const pct = grandTotal > 0 ? Math.round(b.totalTokens / grandTotal * 100) : 0
                                            // 唯一 React key：provider 视图 key 已是 providerType（唯一）；
                                            // model 视图 key 是模型名，同名模型可能跨服务商出现（如 deepseek-v4-flash），
                                            // 需组合 providerType 避免 key 冲突导致 reconciliation 错乱、数据叠加。
                                            const rowKey = b.providerType ? `${b.providerType}\u0000${b.key}` : b.key
                                            return (
                                                <tr key={rowKey} className="border-t border-[var(--border-muted)] tabular-nums hover:bg-[var(--surface-muted)] transition-colors">
                                                    <td className="px-4 py-2.5 font-medium text-left">
                                                        <div className="flex items-center gap-2">
                                                            <span className="w-1.5 h-1.5 rounded-full bg-[var(--brand-primary)] shrink-0"/>
                                                            <div>
                                                                <div>{view === 'provider' ? (b.providerName || displayName(b.key, view)) : displayName(b.key, view)}</div>
                                                                {view === 'model' && b.providerType && (
                                                                    <div className="text-[10px] font-normal text-[var(--text-muted)]">{b.providerName || b.providerType}</div>
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
                    </>
                )}
            </div>
        </div>
    )
}

// ========================================
// 窗口控制 SVG 图标
// ========================================

function MinimizeIcon() {
    return (
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M20 12H4"/>
        </svg>
    )
}

function MaximizeIcon() {
    return (
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="4" y="4" width="16" height="16" rx="2"/>
        </svg>
    )
}

function RestoreIcon() {
    return (
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="6" y="6" width="12" height="12" rx="1"/>
            <path d="M8 6V5a1 1 0 011-1h10a1 1 0 011 1v10a1 1 0 01-1 1h-1"/>
        </svg>
    )
}

function CloseIcon() {
    return (
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12"/>
        </svg>
    )
}

// ========================================
// 信息提示（圆圈问号 + hover tooltip）
// ========================================

function InfoTip({text}: {text: string}) {
    return (
        <div className="relative group shrink-0">
            <span
                role="img"
                aria-label="成本口径说明"
                className="w-4 h-4 rounded-full border border-[var(--border-emphasis)] text-[var(--text-muted)] flex items-center justify-center text-[10px] leading-none cursor-help select-none group-hover:text-[var(--text-secondary)] group-hover:border-[var(--text-secondary)] transition-colors"
            >
                ?
            </span>
            <div className="absolute right-0 top-full mt-1.5 w-72 rounded-lg border border-[var(--border)] bg-[var(--surface-elevated)] shadow-elevated px-3 py-2.5 text-[11px] leading-relaxed text-[var(--text-secondary)] opacity-0 pointer-events-none translate-y-0.5 group-hover:opacity-100 group-hover:translate-y-0 transition-all duration-150 z-50">
                {text}
            </div>
        </div>
    )
}
