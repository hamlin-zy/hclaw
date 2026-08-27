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
import {extractUsage, extractToolCalls, extractTextContent, type TokenUsage} from '@shared/utils/llmUsageParser'
import {tokensPerSecond} from '@shared/llmUsage'
import {confirm} from './ConfirmDialog'
import {CopyButton} from './common/CopyButton'
import type {LlmCallRecord, LlmTraceProjection, TraceFilter} from './llmTrace/types'

type DetailTab = 'request' | 'response' | 'usage' | 'tools'
type RequestSubTab = 'overview' | 'body'

interface LlmConversationRef { id: string; title: string }

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
    const [conversations, setConversations] = useState<LlmConversationRef[]>([])
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
        const cacheTokens = projection.summaryTokens.reduce((a, t) => a + t.cacheReadTokens + t.cacheWriteTokens, 0)
        const outputTokens = projection.summaryTokens.reduce((a, t) => a + t.outputTokens, 0)
        const toolsCount = projection.summaryTokens.reduce((a, t) => a + t.toolsCount, 0)
        // 首字耗时按 calls 加权平均；无数据（0）显示 "—"
        const firstByteMs = calls > 0
            ? Math.round(s.reduce((a, g) => a + g.avgFirstByteMs * g.calls, 0) / calls)
            : 0
        return {calls, errors, aborts, retries, avgMs, inputTokens, cacheTokens, outputTokens, toolsCount, firstByteMs}
    }, [projection])

    const models = useMemo(
        () => [...new Set(projection.summary.map(g => g.model))].sort(),
        [projection],
    )

    const conversationTitlesMap = useMemo(
        () => new Map(conversations.map(c => [c.id, c.title])),
        [conversations],
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
                    {conversations.map(c => (
                        <option key={c.id} value={c.id}>{c.title.length > 30 ? `${c.title.slice(0, 30)}…` : c.title}</option>
                    ))}
                </select>
            </div>

            {/* ── 摘要条 ── */}
            <div className="flex gap-3 px-4 py-3 border-b border-[var(--border)] bg-[var(--surface-muted)]/50 shrink-0 flex-wrap">
                <StatCard value={String(stats.calls)} label="总调用" />
                <StatCard value={String(stats.errors + stats.aborts)} label="失败 / 中断" tone={stats.errors + stats.aborts > 0 ? 'err' : 'ok'} />
                <StatCard value={fmtCompact(stats.inputTokens)} label="输入 tokens" />
                <StatCard value={fmtCompact(stats.outputTokens)} label="输出 tokens" />
                <StatCard value={fmtCompact(stats.cacheTokens)} label="缓存命中 tokens" />
                <StatCard value={stats.avgMs ? fmtMs(stats.avgMs) : '-'} label="平均耗时" />
                <StatCard value={stats.firstByteMs ? fmtMs(stats.firstByteMs) : '—'} label="平均首字耗时" />
                <StatCard value={String(stats.retries)} label="重试次数" />
                <StatCard value={String(stats.toolsCount)} label="工具调用次数" />
            </div>

            {/* ── 时间线主区 ── */}
            <TimelineView projection={projection} filter={filter} onOpenDetail={openDetail}
                conversationTitles={conversationTitlesMap} />

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
        conv.children.sort((a, b) => (b.turn ?? 0) - (a.turn ?? 0))
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

/** 修复式解析截断 JSON：补齐未闭合的 { / [ 后再 parse；不可修复返回 undefined */
function parseRepairedJson(text: string): unknown {
    const stack: Array<'{' | '['> = []
    let inStr = false
    let esc = false
    for (const ch of text) {
        if (inStr) {
            if (esc) esc = false
            else if (ch === '\\') esc = true
            else if (ch === '"') inStr = false
            continue
        }
        if (ch === '"') inStr = true
        else if (ch === '{' || ch === '[') stack.push(ch)
        else if (ch === '}' || ch === ']') stack.pop()
    }
    // 字符串中截断或无未闭合括号：修复无意义，交回 raw 兜底
    if (inStr || stack.length === 0) return undefined
    let out = text.replace(/[\s,:]+$/, '')
    for (let i = stack.length - 1; i >= 0; i--) out += stack[i] === '{' ? '}' : ']'
    try { return JSON.parse(out) } catch { return undefined }
}

/** 详情面板：请求 wire JSON / 响应原文 / 解析 usage / 工具调用 四 tab */
function DetailView({state, tab, onTab, onClose}: {
    state: DetailState
    tab: DetailTab
    onTab: (t: DetailTab) => void
    onClose: () => void
}) {
    const {record: r, reqText, resText, loading} = state

    // 面板固定高度：受控像素，切换 tab 时不随内容变化；顶部把手可拖拽调整
    const [height, setHeight] = useState(() => Math.round(window.innerHeight * 0.45))
    const dragRef = useRef<{startY: number; startH: number} | null>(null)

    const MIN_H = 120
    const clampHeight = useCallback((h: number) => {
        return Math.min(Math.max(h, MIN_H), Math.round(window.innerHeight * 0.8))
    }, [])

    const onResizeStart = useCallback((e: React.PointerEvent) => {
        e.preventDefault()
        dragRef.current = {startY: e.clientY, startH: height}
        document.body.style.userSelect = 'none'
    }, [height])

    // pointermove / pointerup 挂 window：拖出把手区域也能继续拖动；松开或卸载时清理
    useEffect(() => {
        const onMove = (e: PointerEvent) => {
            if (!dragRef.current) return
            // 向上拖（dy<0）增大高度
            setHeight(clampHeight(dragRef.current.startH + (dragRef.current.startY - e.clientY)))
        }
        const onUp = () => {
            dragRef.current = null
            document.body.style.userSelect = ''
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        return () => {
            window.removeEventListener('pointermove', onMove)
            window.removeEventListener('pointerup', onUp)
            document.body.style.userSelect = ''
        }
    }, [clampHeight])

    const reqBody = useMemo<{kind: 'json'; data: unknown} | {kind: 'raw'; text: string} | {kind: 'missing'}>(() => {
        if (loading) return {kind: 'missing'}
        if (reqText == null) return {kind: 'missing'}
        try { return {kind: 'json', data: JSON.parse(reqText)} } catch {
            const repaired = parseRepairedJson(reqText)
            return repaired !== undefined ? {kind: 'json', data: repaired} : {kind: 'raw', text: reqText}
        }
    }, [reqText, loading])

    const usage = useMemo<TokenUsage | null>(
        () => (resText && !loading) ? extractUsage(r.apiStyle, resText) : null,
        [resText, r.apiStyle, loading],
    )

    const toolCalls = useMemo(
        () => (resText && !loading) ? extractToolCalls(r.apiStyle, resText) : null,
        [resText, r.apiStyle, loading],
    )

    const TABS: Array<[DetailTab, string]> =
        [['request', '请求'], ['response', '响应原文'], ['usage', '解析 usage'], ['tools', '工具调用']]

    return (
        <div className="shrink-0 border-t border-[var(--border)] bg-[var(--surface-muted)] flex flex-col" style={{height}}>
            {/* 顶部拖拽把手：上下拖调整面板高度，双击恢复默认 */}
            <div
                className="shrink-0 h-1.5 cursor-row-resize hover:bg-[var(--border)]/60 transition-colors"
                title="拖动调整高度，双击恢复默认"
                onPointerDown={onResizeStart}
                onDoubleClick={() => setHeight(Math.round(window.innerHeight * 0.45))}
            />
            <div className="flex items-center gap-0.5 px-3 pt-1.5 border-b border-[var(--border)] shrink-0">
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

            <div className="flex-1 min-h-0 overflow-auto p-3 font-mono text-xs leading-relaxed">
                {loading && <div className="text-center text-[var(--text-muted)] py-6">加载原始文件…</div>}
                {!loading && tab === 'request' && (
                    reqBody.kind === 'missing' ? <MissingNote /> : <RequestTab record={r} reqBody={reqBody} />
                )}
                {!loading && tab === 'response' && (
                    r.resFile
                        ? (resText != null
                            // key 重挂载：切换记录时正文/原文视图重置回原文
                            ? <ResponseView key={r.id} apiStyle={r.apiStyle} resText={resText} />
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
                                            {usage.reasoningTokens != null && usage.reasoningTokens > 0 && usage.outputTokens != null && (
                                                <UsageRow label="正文 tokens" value={usage.outputTokens - usage.reasoningTokens} />
                                            )}
                                            <UsageRow label="首字耗时" value={r.firstByteMs} format={fmtMs} />
                                            <UsageRow label="请求耗时" value={r.totalMs} format={fmtMs} />
                                            <tr>
                                                <td className="pr-4 py-0.5 text-[var(--text-secondary)]">吞吐速度</td>
                                                <td className="py-0.5 font-mono text-[var(--text-primary)] tabular-nums">
                                                    {tokensPerSecond(usage.outputTokens ?? 0, r.totalMs)?.toFixed(1) ?? '-'} tok/s
                                                </td>
                                            </tr>
                                            <UsageRow label="工具调用次数" value={toolCalls?.length} />
                                        </tbody>
                                    </table>
                                </div>
                            )
                            : <div className="text-center text-[var(--text-muted)] py-6">未能从响应原文解析出 usage（格式不匹配或字段缺失）</div>)
                        : <MissingNote />
                )}
                {!loading && tab === 'tools' && renderToolsTab(r, toolCalls)}
            </div>
        </div>
    )
}

/** 请求 tab：拆为「概览 / 请求体」两个子 tab（Chrome DevTools Headers/Payload 布局） */
function RequestTab({record: r, reqBody}: {
    record: LlmCallRecord
    reqBody: {kind: 'json'; data: unknown} | {kind: 'raw'; text: string} | {kind: 'missing'}
}) {
    const [subTab, setSubTab] = useState<RequestSubTab>('overview')

    // reqJson = req.json 的字段提取（url/headers/bodyRaw）；raw 形态或缺字段时概览显示 "—"
    const reqJson = useMemo(() => {
        if (reqBody.kind !== 'json' || typeof reqBody.data !== 'object' || reqBody.data === null) return undefined
        const d = reqBody.data as {url?: unknown; headers?: unknown; bodyRaw?: unknown}
        return {
            url: typeof d.url === 'string' ? d.url : '',
            headers: (typeof d.headers === 'object' && d.headers !== null && !Array.isArray(d.headers))
                ? d.headers as Record<string, string> : undefined,
            bodyRaw: typeof d.bodyRaw === 'string' ? d.bodyRaw : '',
        }
    }, [reqBody])

    const SUB_TABS: Array<[RequestSubTab, string]> = [['overview', '概览'], ['body', '请求体']]

    return (
        <div>
            <div className="flex gap-0.5 mb-2">
                {SUB_TABS.map(([key, label]) => (
                    <button
                        key={key}
                        onClick={() => setSubTab(key)}
                        className={`py-0.5 px-2.5 text-[11px] rounded-full border-none cursor-pointer select-none transition-colors ${
                            subTab === key
                                ? 'bg-[var(--surface-elevated)] text-[var(--text-primary)]'
                                : 'bg-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                        }`}
                    >{label}</button>
                ))}
            </div>
            {subTab === 'overview'
                ? <RequestOverview record={r} url={reqJson?.url} headers={reqJson?.headers} />
                : <RequestBodyView text={reqJson?.bodyRaw ?? (reqBody.kind === 'raw' ? reqBody.text : '')} />}
        </div>
    )
}

/** 概览：URL 单行 + 复制、HTTP 状态码徽章、请求头名值两列表格（DevTools Headers 风格） */
function RequestOverview({record: r, url, headers}: {
    record: LlmCallRecord
    url?: string
    headers?: Record<string, string>
}) {
    return (
        <div className="space-y-2">
            {/* URL 行 */}
            <div className="flex items-start gap-2">
                <span className="text-[11px] text-[var(--text-muted)] shrink-0 mt-px">URL</span>
                <span className="flex-1 break-all text-[var(--text-primary)]">{url || '—'}</span>
                {url ? <CopyButton name={url} size="sm" /> : null}
            </div>
            {/* HTTP 状态码徽章：statusCode 客观着色；error 记录附错误信息 */}
            <div className="flex items-center gap-2">
                <span className="text-[11px] text-[var(--text-muted)] shrink-0">状态</span>
                {r.statusCode != null ? (
                    <span
                        className={`font-mono text-[10.5px] py-px px-1.5 rounded border ${
                            r.statusCode >= 200 && r.statusCode < 300
                                ? 'border-[var(--success)]/45 text-[var(--success)]'
                                : 'border-[var(--error)]/45 text-[var(--error)]'
                        }`}
                    >
                        HTTP {r.statusCode}
                    </span>
                ) : <span className="font-mono text-[var(--text-primary)]">—</span>}
                {r.error && (
                    <span className="break-all" title={r.error.message}>
                        <span className="text-[10.5px] px-1.5 py-px rounded bg-[var(--error-muted)] text-[var(--error)]">{r.status}</span>
                    </span>
                )}
            </div>
            {/* 请求头表格 */}
            {headers && Object.keys(headers).length > 0 ? (
                <table className="w-full border-separate" style={{borderSpacing: '0 1px'}}>
                    <tbody>
                        {Object.entries(headers).map(([k, v]) => (
                            <tr key={k} className="odd:bg-[var(--surface-elevated)]">
                                <td className="py-1 px-2 w-56 align-top font-semibold text-[var(--text-secondary)] break-all">{k}</td>
                                <td className="py-1 px-2 align-top break-all whitespace-pre-wrap text-[var(--text-primary)]">{String(v)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            ) : <div className="text-[var(--text-muted)]">请求头 —</div>}
        </div>
    )
}

/** 请求体：bodyRaw 解析 JSON 树（截断修复）/ 原文；空字符串显示提示 */
function RequestBodyView({text}: {text: string}) {
    if (!text) return <div className="text-center text-[var(--text-muted)] py-6">无请求体（body 为空）</div>
    try { return <JsonTree data={JSON.parse(text)} /> } catch {
        const repaired = parseRepairedJson(text)
        if (repaired !== undefined) return <JsonTree data={repaired} />
        return <pre className="whitespace-pre-wrap break-all text-[var(--text-primary)]">{text}</pre>
    }
}

/** 响应 tab：原文 / 连贯正文 双视图切换（软胶囊按钮 + CopyButton） */
function ResponseView({apiStyle, resText}: {apiStyle: string; resText: string}) {
    const [showText, setShowText] = useState(false)
    const text = useMemo(() => extractTextContent(apiStyle, resText), [apiStyle, resText])
    return (
        <div className="space-y-1.5">
            {text != null && (
                <button
                    onClick={() => setShowText(s => !s)}
                    className="py-0.5 px-2 text-[11px] rounded-full border-none bg-[var(--surface-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer transition-colors"
                >{showText ? '查看原文' : '查看正文'}</button>
            )}
            <div className="relative">
                {!showText || text == null ? (
                    <pre className="whitespace-pre-wrap break-all text-[var(--text-primary)]">{resText}</pre>
                ) : (
                    <div>
                        <span className="absolute top-0 right-0"><CopyButton name={text} size="sm" /></span>
                        <pre className="whitespace-pre-wrap break-all text-[var(--text-primary)]">{text}</pre>
                    </div>
                )}
            </div>
        </div>
    )
}

/** 工具调用 tab：本次响应新增的工具调用明细（名称 + 参数 JSON 树） */
function renderToolsTab(r: LlmCallRecord, toolCalls: Array<{name: string; args: string}> | null) {
    if (!r.resFile) return <MissingNote />
    if (!toolCalls || toolCalls.length === 0) {
        return <div className="text-center text-[var(--text-muted)] py-6">未解析到工具调用</div>
    }
    return (
        <div className="space-y-2">
            {toolCalls.map((tc, i) => (
                <div key={i} className="rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] p-2">
                    <div className="text-[11.5px] font-semibold text-[var(--brand-primary)] mb-1">🔧 {tc.name}</div>
                    {(() => {
                        try { return <JsonTree data={JSON.parse(tc.args)} /> }
                        catch { return <pre className="whitespace-pre-wrap break-all text-[var(--text-primary)]">{tc.args}</pre> }
                    })()}
                </div>
            ))}
        </div>
    )
}

function UsageRow({label, value, format}: {label: string; value?: number; format?: (n: number) => string}) {
    return (
        <tr>
            <td className="pr-4 py-0.5 text-[var(--text-secondary)]">{label}</td>
            <td className="py-0.5 font-mono text-[var(--text-primary)] tabular-nums">
                {typeof value === 'number' ? (format ? format(value) : value.toLocaleString()) : '-'}
            </td>
        </tr>
    )
}

function MissingNote() {
    return <div className="text-center text-[var(--text-muted)] py-6">{FILE_MISSING_NOTE}</div>
}
