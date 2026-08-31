import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {AnimatePresence, motion} from 'framer-motion'
import type {ConversationUsageStats, UsageBreakdown} from '@shared/types'
import {formatTokenCount, formatTokenCompact, formatTokensPerSecond, formatCost, type Currency} from '../../lib/format'
import {computeKpis, duplicatedModelKeys, mergeByProvider} from '@shared/llmUsage'
import {KpiCard, StatRow, GroupTitle, providerDisplayName, ClientStatsNotice, InfoTip, getCostDisclaimer, CurrencyToggle, formatPricePerMillionTokens} from '../usage/statsParts'
import {useDraggableDialog} from '../../hooks/useDraggableDialog'

export interface UsageStatsOptions {
    convId: string
    title: string
}

/**
 * 显示用量统计弹窗
 * @param options 目标会话
 */
export function showUsageStats(options: UsageStatsOptions): void {
    window.dispatchEvent(
        new CustomEvent('hclaw:show-usage-stats', {detail: options})
    )
}

type LoadState =
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'done'; data: ConversationUsageStats }

/** 会话用量统计弹窗
 * App 级渲染（App.tsx），CustomEvent 触发，与 ConfirmDialog 同体系
 */
export default function UsageStatsDialog() {
    const [options, setOptions] = useState<UsageStatsOptions | null>(null)
    const [load, setLoad] = useState<LoadState>({status: 'loading'})
    const [groupView, setGroupView] = useState<'provider' | 'model'>('provider')
    const [currency, setCurrency] = useState<Currency>('CNY')

    // 弹窗可拖动：每次打开居中，拖动时边界约束（hook 管理 ARIA 角色与定位）
    // recenterSignal：数据加载完成后弹窗高度定型，重新居中一次（初始居中测量于 loading 态，高度偏小会偏下）
    const {dialogRef, position, isDragging, handleDragStart} = useDraggableDialog({
        visible: !!options,
        ariaLabelledBy: 'usage-stats-title',
        recenterSignal: load.status,
    })

    useEffect(() => {
        const handleShow = (e: CustomEvent<UsageStatsOptions>) => {
            setOptions(e.detail)
            setLoad({status: 'loading'})
        }
        window.addEventListener('hclaw:show-usage-stats', handleShow as EventListener)
        return () => window.removeEventListener('hclaw:show-usage-stats', handleShow as EventListener)
    }, [])

    const requestSeqRef = useRef(0)

    /** 分组卡片数据：按服务商聚合（shared mergeByProvider：成本求和、totalTokens 降序）或按模型展开 */
    const breakdownCards = useMemo<UsageBreakdown[]>(() => {
        if (load.status !== 'done' || load.data.breakdown.length === 0) return []
        const d = load.data
        return groupView === 'model' ? d.breakdown : mergeByProvider(d.breakdown)
    }, [load, groupView])

    const loadData = useCallback(async (convId: string) => {
        const seq = ++requestSeqRef.current
        setLoad({status: 'loading'})
        try {
            const data = await window.electronAPI?.conversationUsageStats?.(convId)
            if (seq !== requestSeqRef.current) return // 竞态：已有更新的请求发出
            if (!data) {
                setLoad({status: 'error', message: '统计数据加载失败'})
            } else {
                setLoad({status: 'done', data})
            }
        } catch (err) {
            if (seq !== requestSeqRef.current) return
            console.error('[UsageStatsDialog] load failed:', err)
            setLoad({status: 'error', message: '统计数据加载失败'})
        }
    }, [])

    // 打开时请求数据
    useEffect(() => {
        if (!options) return
        void loadData(options.convId)
    }, [options, loadData])

    const handleClose = useCallback(() => {
        setOptions(null)
    }, [])

    // ESC 关闭
    useEffect(() => {
        if (!options) return
        const onEsc = (e: KeyboardEvent) => {
            if (e.key === 'Escape') handleClose()
        }
        document.addEventListener('keydown', onEsc)
        return () => document.removeEventListener('keydown', onEsc)
    }, [options, handleClose])

    // 总 token = 输入 + 输出 + 缓存命中 + 缓存写入（含全部 token 流量）
    const totalTokens = (d: ConversationUsageStats) =>
        d.totalInputTokens + d.totalOutputTokens + d.totalCacheReadTokens + d.totalCacheWriteTokens

    const renderBody = () => {
        if (load.status === 'loading') {
            return (
                <div className="flex items-center justify-center py-10">
                    <div className="w-6 h-6 border-2 border-[var(--brand-primary)] border-t-transparent rounded-full animate-spin"/>
                </div>
            )
        }
        if (load.status === 'error') {
            return (
                <div className="py-6 text-center">
                    <p className="text-sm text-[var(--text-secondary)]">{load.message}</p>
                    <button
                        onClick={() => options && void loadData(options.convId)}
                        className="mt-3 px-4 py-1.5 text-xs font-medium rounded-lg border border-[var(--border)] text-[var(--text-primary)] hover:bg-[var(--surface-muted)] transition-colors"
                     data-name="usage-stats-dialog-button">
                        重试
                    </button>
                </div>
            )
        }
        const d = load.data
        const scope = `${d.parentCount} 个父会话 + ${d.childCount} 个子会话`
        // KPI 统一口径（shared computeKpis，与独立窗口一致）：缓存命中率 / 平均吞吐 / 平均首字
        const kpis = computeKpis({
            inputTokens: d.totalInputTokens, outputTokens: d.totalOutputTokens,
            cacheReadTokens: d.totalCacheReadTokens, totalDecodeMs: d.totalDecodeMs,
            totalTtftMs: d.totalTtftMs, ttftCount: d.ttftCount,
        })
        const rate = kpis.cacheHitRate != null ? `${kpis.cacheHitRate}%` : null
        const avgDecodeRate = kpis.avgDecodeRate
        const avgTtftSeconds = kpis.avgTtftSeconds
        return (
            <div className="space-y-3">
                {/* 数据口径提示：客户端侧统计，非服务商账单 */}
                <ClientStatsNotice/>

                {/* 统计范围 */}
                <div className="flex items-center gap-2 rounded-lg bg-[var(--surface-muted)] px-3 py-2">
                    <svg className="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="3" width="7" height="7" rx="1.5"/>
                        <rect x="14" y="3" width="7" height="7" rx="1.5"/>
                        <rect x="3" y="14" width="7" height="7" rx="1.5"/>
                        <rect x="14" y="14" width="7" height="7" rx="1.5"/>
                    </svg>
                    <span className="text-xs text-[var(--text-muted)]">统计范围</span>
                    <span className="ml-auto text-xs font-medium text-[var(--text-primary)] tabular-nums">{scope}</span>
                </div>

                {/* 关键指标 KPI */}
                <div className="grid grid-cols-2 gap-2">
                    <KpiCard label="总 token（含缓存）" value={formatTokenCompact(totalTokens(d))} accent/>
                    <KpiCard label="缓存命中率" value={rate ?? '-'}/>
                    <KpiCard label="平均吞吐" value={avgDecodeRate != null ? `${formatTokensPerSecond(avgDecodeRate)} t/s` : '—'}/>
                    <KpiCard label="平均首字" value={avgTtftSeconds != null ? `${avgTtftSeconds.toFixed(1)}s` : '—'}/>
                </div>

                {/* Token 明细（两列并排压缩纵向空间，每项带边框） */}
                <GroupTitle>Token 明细</GroupTitle>
                <div className="grid grid-cols-2 gap-1.5">
                    <StatRow bordered label="输入" value={formatTokenCount(d.totalInputTokens)}/>
                    <StatRow bordered label="输出" value={formatTokenCount(d.totalOutputTokens)}/>
                </div>

                {/* 缓存（每项带边框） */}
                <GroupTitle>缓存</GroupTitle>
                <div className="space-y-1.5">
                    <StatRow bordered label="缓存命中" value={formatTokenCount(d.totalCacheReadTokens)}/>
                    {d.totalCacheWriteTokens > 0 && (
                        <StatRow bordered label="缓存写入" value={formatTokenCount(d.totalCacheWriteTokens)}/>
                    )}
                </div>

                {/* 调用（一行两列，每项带边框） */}
                <GroupTitle>调用</GroupTitle>
                <div className="grid grid-cols-2 gap-1.5">
                    <StatRow bordered label="LLM 请求" value={`${d.requestCount} 次`}/>
                    <StatRow bordered label="工具调用" value={`${d.toolCallCount} 次`}/>
                </div>

                {/* 分组用量（会话运行期间切换服务商/模型的用量下钻） */}
                {load.status === 'done' && load.data.breakdown.length > 0 && (
                    <>
                        <div className="my-3 border-t border-dashed border-[var(--border-dashed)]"/>
                        <div className="flex items-center justify-between pt-2 pb-1">
                            <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">分组用量</span>
                            <div className="flex gap-0.5 p-0.5 rounded-lg bg-[var(--surface-muted)] border border-[var(--border-muted)]">
                                <button onClick={() => setGroupView('provider')}
                                        className={`px-2 py-0.5 text-[11px] rounded-md transition-colors ${groupView === 'provider' ? 'bg-[var(--surface-elevated)] shadow-sm' : 'text-[var(--text-muted)]'}`} data-name="usage-stats-dialog-group-provider-button">
                                    按服务商
                                </button>
                                <button onClick={() => setGroupView('model')}
                                        className={`px-2 py-0.5 text-[11px] rounded-md transition-colors ${groupView === 'model' ? 'bg-[var(--surface-elevated)] shadow-sm' : 'text-[var(--text-muted)]'}`} data-name="usage-stats-dialog-group-model-button">
                                    按模型
                                </button>
                            </div>
                            {/* 美元 / 人民币切换（共享 CurrencyToggle，与独立窗口同口径，启动时同步实时汇率） */}
                            <CurrencyToggle currency={currency} onChange={setCurrency} size="sm"/>
                        </div>
                        <div className="space-y-2">
                            {(() => {
                                const grand = breakdownCards.reduce((s, b) => s + b.totalTokens, 0)
                                // 同名模型跨服务商检测：模型视图下同名模型多行 → 小字 via 高亮 + 「同名」徽章
                                const dupModels = duplicatedModelKeys(breakdownCards)
                                const isDupModel = (key: string) => dupModels.has(key)
                                return breakdownCards.map((b) => {
                                    const pct = grand > 0 ? Math.round(b.totalTokens / grand * 100) : 0
                                    const modelCount = groupView === 'provider'
                                        ? load.data.breakdown.filter(x => (x.providerName ?? x.providerType ?? 'unknown') === b.key).length
                                        : 1
                                    const title = groupView === 'provider'
                                        ? (b.providerName || providerDisplayName(b.key))
                                        : b.key
                                    const dupModel = groupView === 'model' && isDupModel(b.key)
                                    return (
                                        <div key={`${b.providerName ?? b.providerType ?? 'unknown'}-${b.key}`} className="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5">
                                            <div className="flex items-center gap-2">
                                                <span className="w-2 h-2 rounded-full bg-[var(--brand-primary)] shrink-0"/>
                                                <span className="text-xs font-medium text-[var(--text-primary)]">{title}</span>
                                                {dupModel && (
                                                    <span title="同名模型由不同服务商提供，价格/延迟可能不同"
                                                          className="rounded border border-[var(--border)] bg-[var(--surface-muted)] px-1 py-px text-[9px] font-medium text-[var(--brand-primary)]">
                                                        同名
                                                    </span>
                                                )}
                                                <span className={`text-[10px] ${dupModel ? 'font-medium text-[var(--brand-primary)]' : 'text-[var(--text-tertiary)]'}`}>
                                                    {groupView === 'provider' ? `${modelCount} 个模型` : (dupModel ? `via ${b.providerName || b.providerType}` : (b.providerName || b.providerType))}
                                                </span>
                                                <span className="ml-auto text-xs font-semibold tabular-nums text-[var(--brand-primary)]">{pct}%</span>
                                            </div>
                                            <div className="h-[5px] rounded-sm bg-[var(--border)] mt-2 overflow-hidden">
                                                <div className="h-full rounded-sm bg-[var(--brand-primary)]" style={{width: `${Math.max(pct, 2)}%`}}/>
                                            </div>
                                            <div className="mt-2 text-[11px] text-[var(--text-secondary)] tabular-nums">
                                                请求 <b className="text-[var(--text-primary)]">{b.requestCount}</b> 次 · 合计 <b className="text-[var(--text-primary)]">{formatTokenCount(b.totalTokens)}</b>
                                            </div>
                                            <div className="grid grid-cols-5 gap-2 mt-2 pt-2 border-t border-[var(--border-muted)]">
                                                <div><div className="text-[9px] text-[var(--text-muted)]">输入</div><div className="text-xs tabular-nums">{formatTokenCount(b.inputTokens)}</div></div>
                                                <div><div className="text-[9px] text-[var(--text-muted)]">输出</div><div className="text-xs tabular-nums">{formatTokenCount(b.outputTokens)}</div></div>
                                                <div><div className="text-[9px] text-[var(--text-muted)]">缓存命中</div><div className="text-xs tabular-nums">{b.cacheReadTokens > 0 ? formatTokenCount(b.cacheReadTokens) : '—'}</div></div>
                                                <div>
                                                    <div className="text-[9px] text-[var(--text-muted)]">综合价格/M</div>
                                                    <div className="text-xs tabular-nums text-[var(--brand-primary)]">
                                                        {formatPricePerMillionTokens(b.costUsd, b.inputTokens, b.outputTokens, b.cacheReadTokens, b.cacheWriteTokens, currency)}
                                                    </div>
                                                </div>
                                                <div>
                                                    <div className="flex items-center gap-0.5 text-[9px] text-[var(--text-muted)]">
                                                        成本
                                                        <InfoTip text={getCostDisclaimer()} placement="top"/>
                                                    </div>
                                                    <div className="text-xs tabular-nums text-[var(--brand-primary)]">{formatCost(b.costUsd, currency)}</div>
                                                </div>
                                            </div>
                                        </div>
                                    )
                                })
                            })()}
                        </div>
                    </>
                )}
            </div>
        )
    }

    return (
        <AnimatePresence>
            {options && (
                <>
                    <motion.div
                        initial={{opacity: 0}}
                        animate={{opacity: 1}}
                        exit={{opacity: 0}}
                        transition={{duration: 0.15}}
                        className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[99998]"
                        onClick={handleClose}
                    />
                    <motion.div
                        initial={{scale: 0.95, opacity: 0}}
                        animate={{scale: 1, opacity: 1}}
                        exit={{scale: 0.95, opacity: 0}}
                        transition={{duration: 0.15, ease: 'easeOut'}}
                        className="fixed inset-0 pointer-events-none z-[99999]"
                    >
                        <div
                            ref={dialogRef}
                            role="dialog"
                            aria-modal="true"
                            aria-labelledby="usage-stats-title"
                            className={`absolute pointer-events-auto bg-[var(--surface)] rounded-xl border border-[var(--border)] overflow-hidden w-[560px] max-w-[calc(100vw-2rem)] transition-shadow duration-100 ${isDragging ? 'scale-[1.02]' : 'shadow-elevated'}`}
                            style={{left: position.x, top: position.y}}
                            onClick={(e) => e.stopPropagation()}
                         data-name="usage-stats-dialog-div">
                            {/* 头部：图标 + 标题 + 快捷关闭（拖动手柄） */}
                            <div
                                onMouseDown={handleDragStart}
                                onTouchStart={handleDragStart}
                                className={`px-5 py-4 border-b border-[var(--border)] bg-[var(--surface-elevated)] select-none ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
                            >
                                <div className="flex items-center gap-3">
                                    <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 bg-[var(--brand-muted)]">
                                        <svg className="w-4.5 h-4.5 text-[var(--brand-primary)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            <line x1="18" y1="20" x2="18" y2="10"/>
                                            <line x1="12" y1="20" x2="12" y2="4"/>
                                            <line x1="6" y1="20" x2="6" y2="14"/>
                                        </svg>
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <h2 id="usage-stats-title" className="text-sm font-semibold text-[var(--text-primary)] truncate">
                                            用量统计 · {options.title}
                                        </h2>
                                        <p className="text-xs text-[var(--text-muted)] mt-0.5">会话 token 消耗与缓存概览</p>
                                    </div>
                                    <button
                                        onClick={handleClose}
                                        aria-label="关闭"
                                        className="p-1.5 -mr-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)] transition-colors"
                                     data-name="usage-stats-dialog-close-button">
                                        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                                            <line x1="18" y1="6" x2="6" y2="18"/>
                                            <line x1="6" y1="6" x2="18" y2="18"/>
                                        </svg>
                                    </button>
                                </div>
                            </div>

                            <div className="px-5 py-4 max-h-[60vh] overflow-y-auto">
                                {renderBody()}
                            </div>
                        </div>
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    )
}
