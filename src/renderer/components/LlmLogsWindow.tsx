/**
 * LLM 调用轨迹窗口（时间线视图，Task 7 重写）
 *
 * 四区布局（对照 temp/llm-log-ui-demo.html，Tailwind 化对齐 UsageWindow 设计语言）：
 * 顶栏（标题+录制状态灯+导出+清空）/ 过滤条（状态 chips+模型+会话下拉）/
 * 摘要条（统计卡）/ TimelineView 主区 + 底部详情面板三 tab。
 *
 * 数据流：getLlmTraceProjection 拉投影 → onLlmTraceRecord 实时插头部 →
 * 防抖重取保持摘要口径一致；onLlmTraceEvent(paused) 显示横幅、状态灯转灰。
 * 录制开关为本地单向 state（默认 false），不读持久化状态。
 */

import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {JsonTree} from './llmTrace/JsonTree'
import {TimelineView, collectRecords, applyTraceFilter} from './llmTrace/TimelineView'
import {extractUsage, type TokenUsage} from '@shared/utils/llmUsageParser'
import {confirm} from './ConfirmDialog'
import type {LlmCallRecord, LlmTraceProjection, TraceFilter} from './llmTrace/types'

type DetailTab = 'request' | 'response' | 'usage'

interface DetailState {
    record: LlmCallRecord
    reqText: string | null
    resText: string | null
    loading: boolean
}

const FILE_MISSING_NOTE = '原始文件缺失（可能录制中断）'

function fmtCompact(n: number): string {
    return n >= 1000000 ? `${(n / 1000000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

export default function LlmLogsWindow() {
    const [enabled, setEnabled] = useState(false)
    const [pausedReason, setPausedReason] = useState<string | null>(null)
    const [projection, setProjection] = useState<LlmTraceProjection>({timeline: [], summary: [], summaryTokens: []})
    const [conversations, setConversations] = useState<string[]>([])
    const [filter, setFilter] = useState<TraceFilter>({status: 'all', model: '', conversationId: ''})
    const [detail, setDetail] = useState<DetailState | null>(null)
    const [detailTab, setDetailTab] = useState<DetailTab>('request')
    // 实时 record 插入后防抖重取投影，让摘要/token 卡片最终收敛到主进程口径
    const refetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    const recording = enabled && !pausedReason

    const loadProjection = useCallback(async (convIds?: string[]) => {
        try {
            const result = await window.electronAPI?.getLlmTraceProjection?.(convIds)
            if (result && Array.isArray(result.timeline)) {
                setProjection({timeline: result.timeline ?? [], summary: result.summary ?? [], summaryTokens: result.summaryTokens ?? []})
            }
        } catch {
            /* IPC 失败静默保留旧数据 */
        }
    }, [])

    const loadConversations = useCallback(async () => {
        try {
            const list = await window.electronAPI?.listLlmTraceConversations?.()
            if (Array.isArray(list)) setConversations(list)
        } catch {
            /* ignore */
        }
    }, [])

    useEffect(() => {
        loadConversations()
    }, [loadConversations])

    // 会话过滤变化时按该会话拉投影；否则全量
    useEffect(() => {
        loadProjection(filter.conversationId ? [filter.conversationId] : undefined)
    }, [filter.conversationId, loadProjection])

    // 实时上屏：新 record 插入对应会话分组头部 + 防抖重取摘要
    useEffect(() => {
        const offRecord = window.electronAPI?.onLlmTraceRecord?.((record) => {
            if (!record?.id) return
            setProjection(prev => ({...prev, timeline: insertRecord(prev.timeline, record)}))
            if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current)
            refetchTimerRef.current = setTimeout(() => {
                loadProjection(filter.conversationId ? [filter.conversationId] : undefined)
            }, 1500)
        })
        return () => {
            offRecord?.()
            if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current)
        }
    }, [filter.conversationId, loadProjection])

    // 暂停事件（磁盘失败等 failPause）：横幅 + 状态灯转灰
    useEffect(() => {
        const offEvent = window.electronAPI?.onLlmTraceEvent?.((ev) => {
            if (ev?.type === 'paused') setPausedReason(ev.reason || '未知原因')
        })
        return () => { offEvent?.() }
    }, [])

    const toggleRecording = useCallback(async () => {
        try {
            const next = !enabled
            await window.electronAPI?.toggleLlmTrace?.(next)
            setEnabled(next)
            if (next) {
                setPausedReason(null)
                loadProjection(filter.conversationId ? [filter.conversationId] : undefined)
                loadConversations()
            }
        } catch {
            /* ignore */
        }
    }, [enabled, filter.conversationId, loadProjection, loadConversations])

    const handleClear = useCallback(async () => {
        const ok = await confirm({
            title: '清空调用日志',
            message: '清空所有调用日志文件？录制将同时停止。',
            confirmText: '清空',
            confirmVariant: 'danger',
        })
        if (!ok) return
        try {
            await window.electronAPI?.clearLlmTrace?.()
            setEnabled(false)
            setPausedReason(null)
            setDetail(null)
            setProjection({timeline: [], summary: [], summaryTokens: []})
            loadConversations()
        } catch {
            /* ignore */
        }
    }, [loadConversations])

    // 导出当前过滤范围的记录 JSON
    const handleExport = useCallback(() => {
        const records = applyTraceFilter(collectRecords(projection.timeline), filter)
        const blob = new Blob([JSON.stringify({exportedAt: new Date().toISOString(), filter, records}, null, 2)],
            {type: 'application/json'})
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `llm-trace-${Date.now()}.json`
        a.click()
        URL.revokeObjectURL(url)
    }, [projection, filter])

    const openDetail = useCallback((record: LlmCallRecord) => {
        setDetail({record, reqText: null, resText: null, loading: true})
        setDetailTab('request')
    }, [])

    // 详情文件懒加载：选中记录变化即拉 req/res 原文
    useEffect(() => {
        if (!detail) return
        let cancelled = false
        const {record} = detail
        Promise.all([
            window.electronAPI?.getLlmTraceFile?.(record.conversationId, record.reqFile) ?? Promise.resolve(null),
            record.resFile
                ? window.electronAPI?.getLlmTraceFile?.(record.conversationId, record.resFile) ?? Promise.resolve(null)
                : Promise.resolve(null),
        ]).then(([reqText, resText]) => {
            if (!cancelled) setDetail({record, reqText, resText, loading: false})
        }).catch(() => {
            if (!cancelled) setDetail({record, reqText: null, resText: null, loading: false})
        })
        return () => { cancelled = true }
    }, [detail?.record.id]) // eslint-disable-line react-hooks/exhaustive-deps

    // ── 摘要统计卡（token 总量由 renderer 对 summaryTokens 求和）──
    const stats = useMemo(() => {
        const s = projection.summary
        const calls = s.reduce((a, g) => a + g.calls, 0)
        const errors = s.reduce((a, g) => a + g.errors, 0)
        const aborts = s.reduce((a, g) => a + g.aborts, 0)
        const retries = s.reduce((a, g) => a + g.retries, 0)
        const totalMs = s.reduce((a, g) => a + g.avgTotalMs * g.calls, 0)
        const avgMs = calls > 0 ? Math.round(totalMs / calls) : 0
        const inputTokens = projection.summaryTokens.reduce((a, t) => a + t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens, 0)
        const outputTokens = projection.summaryTokens.reduce((a, t) => a + t.outputTokens, 0)
        return {calls, errors, aborts, retries, avgMs, inputTokens, outputTokens}
    }, [projection])

    const models = useMemo(
        () => [...new Set(projection.summary.map(g => g.model))].sort(),
        [projection],
    )

    return (
        <div className="h-full flex flex-col">
            {/* ── 顶栏 ── */}
            <div className="flex items-center gap-3 px-4 py-2.5 border-b border-[var(--border)] shrink-0 flex-wrap">
                <h1 className="text-sm font-semibold text-[var(--text-primary)]">LLM 调用日志</h1>
                {/* 录制状态灯：录制中红色呼吸；点击切换 */}
                <button
                    onClick={toggleRecording}
                    title={recording ? '点击停止录制' : '点击开始录制'}
                    className={`inline-flex items-center gap-1.5 py-0.5 px-2.5 rounded-full text-xs border cursor-pointer select-none transition-colors ${
                        recording
                            ? 'border-[var(--error)]/45 text-[var(--error)]'
                            : 'border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                    }`}
                >
                    <span className={`w-2 h-2 rounded-full shrink-0 ${recording ? 'bg-[var(--error)] animate-pulse' : pausedReason ? 'bg-[var(--text-muted)]' : 'bg-[var(--text-muted)]'}`} />
                    {recording ? '录制中' : pausedReason ? `已暂停 · ${pausedReason}` : '未录制'}
                </button>
                <span className="flex-1" />
                <button
                    onClick={handleExport}
                    className="px-3 py-1 text-xs rounded-md border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)] transition-colors"
                >导出</button>
                <button
                    onClick={handleClear}
                    className="px-3 py-1 text-xs rounded-md border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--error)] hover:text-[var(--error)] transition-colors"
                >清空</button>
            </div>

            {/* ── 过滤条 ── */}
            <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--border)] shrink-0 flex-wrap">
                {([['all', '全部状态'], ['failed', '仅失败'], ['retries', '含重试']] as const).map(([key, label]) => (
                    <button
                        key={key}
                        onClick={() => setFilter(f => ({...f, status: key}))}
                        className={`py-0.5 px-2.5 rounded-full text-xs cursor-pointer select-none border transition-colors ${
                            filter.status === key
                                ? 'border-[var(--brand-primary)] text-[var(--brand-primary)] bg-[var(--brand-muted)]'
                                : 'border-[var(--border)] text-[var(--text-secondary)]'
                        }`}
                    >{label}</button>
                ))}
                <select
                    value={filter.model}
                    onChange={e => setFilter(f => ({...f, model: e.target.value}))}
                    className="bg-[var(--surface-elevated)] text-[var(--text-primary)] text-xs border border-[var(--border)] rounded-md px-2 py-1 outline-none"
                >
                    <option value="">全部模型</option>
                    {models.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
                <select
                    value={filter.conversationId}
                    onChange={e => setFilter(f => ({...f, conversationId: e.target.value}))}
                    className="bg-[var(--surface-elevated)] text-[var(--text-primary)] text-xs border border-[var(--border)] rounded-md px-2 py-1 outline-none max-w-52"
                >
                    <option value="">全部会话</option>
                    {conversations.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
            </div>

            {/* ── 摘要条 ── */}
            <div className="flex gap-3 px-4 py-3 border-b border-[var(--border)] bg-[var(--surface-muted)]/50 shrink-0 flex-wrap">
                <StatCard value={String(stats.calls)} label="总调用" />
                <StatCard value={String(stats.errors + stats.aborts)} label="失败 / 中断" tone={stats.errors + stats.aborts > 0 ? 'err' : 'ok'} />
                <StatCard value={fmtCompact(stats.inputTokens)} label="输入 tokens" />
                <StatCard value={fmtCompact(stats.outputTokens)} label="输出 tokens" />
                <StatCard value={stats.avgMs ? fmtMs(stats.avgMs) : '-'} label="平均耗时" />
                <StatCard value={String(stats.retries)} label="重试次数" />
            </div>

            {/* ── 时间线主区 ── */}
            <TimelineView projection={projection} filter={filter} onOpenDetail={openDetail} />

            {/* ── 详情面板（三 tab）── */}
            {detail && (
                <DetailView
                    state={detail}
                    tab={detailTab}
                    onTab={setDetailTab}
                    onClose={() => setDetail(null)}
                />
            )}
        </div>
    )
}

/** 实时插入：找到（或创建）对应 conversation → turn 分组，把 record 放到该 turn 头部 */
function insertRecord(timeline: LlmTraceProjection['timeline'], record: LlmCallRecord): LlmTraceProjection['timeline'] {
    const next = structuredClone(timeline)
    let conv = next.find(n => n.kind === 'conversation' && n.title === record.conversationId)
    if (!conv) {
        conv = {kind: 'conversation', title: record.conversationId, children: []}
        next.unshift(conv)
    }
    conv.children = conv.children ?? []
    let turn = conv.children.find(n => n.kind === 'turn' && n.turn === record.turn)
    if (!turn) {
        turn = {kind: 'turn', turn: record.turn, children: []}
        conv.children.push(turn)
        conv.children.sort((a, b) => (a.turn ?? 0) - (b.turn ?? 0))
    }
    turn.children = turn.children ?? []
    turn.children.unshift({kind: 'call', record})
    return next
}

function StatCard({value, label, tone}: {value: string; label: string; tone?: 'err' | 'ok'}) {
    return (
        <div className="bg-[var(--surface-elevated)] border border-[var(--border)] rounded-lg py-2 px-3.5 min-w-27">
            <div className={`text-base font-semibold font-mono ${
                tone === 'err' ? 'text-[var(--error)]' : tone === 'ok' ? 'text-[var(--success)]' : 'text-[var(--text-primary)]'}`}>
                {value}
            </div>
            <div className="text-[11px] text-[var(--text-muted)] mt-0.5">{label}</div>
        </div>
    )
}

function fmtMs(ms: number): string {
    return ms >= 10000 ? `${(ms / 1000).toFixed(1)}s` : ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`
}

/** 详情面板：请求 wire JSON / 响应原文 / 解析 usage 三 tab */
function DetailView({state, tab, onTab, onClose}: {
    state: DetailState
    tab: DetailTab
    onTab: (t: DetailTab) => void
    onClose: () => void
}) {
    const {record: r, reqText, resText, loading} = state

    const reqBody = useMemo<{kind: 'json'; data: unknown} | {kind: 'raw'; text: string} | {kind: 'missing'}>(() => {
        if (loading) return {kind: 'missing'}
        if (reqText == null) return {kind: 'missing'}
        try { return {kind: 'json', data: JSON.parse(reqText)} } catch { return {kind: 'raw', text: reqText} }
    }, [reqText, loading])

    const usage = useMemo<TokenUsage | null>(
        () => (resText && !loading) ? extractUsage(r.apiStyle, resText) : null,
        [resText, r.apiStyle, loading],
    )

    const TABS: Array<[DetailTab, string]> = [['request', '请求 wire JSON'], ['response', '响应原文'], ['usage', '解析 usage']]

    return (
        <div className="shrink-0 border-t border-[var(--border)] bg-[var(--surface-muted)]" style={{maxHeight: '45vh'}}>
            <div className="flex items-center gap-0.5 px-3 pt-1.5 border-b border-[var(--border)]">
                {TABS.map(([key, label]) => (
                    <button
                        key={key}
                        onClick={() => onTab(key)}
                        className={`py-1.5 px-3.5 text-xs rounded-t-md cursor-pointer select-none transition-colors ${
                            tab === key
                                ? 'text-[var(--brand-primary)] bg-[var(--surface-elevated)] shadow-[inset_0_-2px_0_var(--brand-primary)]'
                                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                        }`}
                    >{label}</button>
                ))}
                <span className="font-mono text-[10.5px] text-[var(--text-muted)] ml-2 truncate">{r.id}</span>
                <button
                    onClick={onClose}
                    className="ml-auto p-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
                    title="关闭详情"
                >✕</button>
            </div>

            <div className="overflow-auto p-3 font-mono text-xs leading-relaxed" style={{maxHeight: 'calc(45vh - 40px)'}}>
                {loading && <div className="text-center text-[var(--text-muted)] py-6">加载原始文件…</div>}
                {!loading && tab === 'request' && (
                    reqBody.kind === 'missing' ? <MissingNote /> :
                    reqBody.kind === 'json' ? <JsonTree data={reqBody.data} /> :
                    <pre className="whitespace-pre-wrap break-all text-[var(--text-primary)]">{reqBody.text}</pre>
                )}
                {!loading && tab === 'response' && (
                    r.resFile
                        ? (resText != null
                            ? <pre className="whitespace-pre-wrap break-all text-[var(--text-primary)]">{resText}</pre>
                            : <MissingNote />)
                        : <div className="text-center text-[var(--text-muted)] py-6">本次调用无响应文件（连接未建立或用户中断）</div>
                )}
                {!loading && tab === 'usage' && (
                    r.resFile
                        ? (resText == null
                            // resFile 存在但读不到原文：文件实际缺失（可能录制中断），先判缺失再判解析失败
                            ? <MissingNote />
                            : usage
                            ? (
                                <div className="space-y-2">
                                    <div className="text-[11px] text-[var(--text-muted)]">
                                        解析自 <span className="text-[var(--brand-primary)]">{r.apiStyle}</span> 格式响应（apiStyle 来源：index.jsonl 记录）
                                    </div>
                                    <table className="text-xs">
                                        <tbody>
                                            <UsageRow label="输入 tokens" value={usage.inputTokens} />
                                            <UsageRow label="输出 tokens" value={usage.outputTokens} />
                                            <UsageRow label="缓存读取" value={usage.cacheReadTokens} />
                                            <UsageRow label="缓存写入" value={usage.cacheWriteTokens} />
                                            <UsageRow label="推理 tokens" value={usage.reasoningTokens} />
                                        </tbody>
                                    </table>
                                </div>
                            )
                            : <div className="text-center text-[var(--text-muted)] py-6">未能从响应原文解析出 usage（格式不匹配或字段缺失）</div>)
                        : <MissingNote />
                )}
            </div>
        </div>
    )
}

function UsageRow({label, value}: {label: string; value?: number}) {
    return (
        <tr>
            <td className="pr-4 py-0.5 text-[var(--text-secondary)]">{label}</td>
            <td className="py-0.5 font-mono text-[var(--text-primary)] tabular-nums">{typeof value === 'number' ? value.toLocaleString() : '-'}</td>
        </tr>
    )
}

function MissingNote() {
    return <div className="text-center text-[var(--text-muted)] py-6">{FILE_MISSING_NOTE}</div>
}
