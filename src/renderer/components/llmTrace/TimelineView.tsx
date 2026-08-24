/**
 * LLM 调用轨迹时间线主区
 *
 * conversation → turn 两层分组；call 行含状态色点/时间/model chip/context 标签/
 * attempt 徽章/耗时+TTFB。重试链（同 conversation+turn+step 多 attempt）收进
 * 红色竖线容器。点击 call 行选中并回调 onOpenDetail 打开底部详情面板。
 */
import {useMemo, useState} from 'react'
import type {LlmCallRecord, LlmTraceProjection, TimelineNode, TraceFilter} from './types'

interface TimelineViewProps {
    projection: LlmTraceProjection
    filter: TraceFilter
    onOpenDetail: (record: LlmCallRecord) => void
}

/** ── 记录收集与过滤（LlmLogsWindow 导出按钮复用同一口径）── */

/** 展平 timeline 中所有 call 节点的 record */
export function collectRecords(timeline: TimelineNode[]): LlmCallRecord[] {
    const out: LlmCallRecord[] = []
    const walk = (nodes: TimelineNode[]) => {
        for (const n of nodes) {
            if (n.kind === 'call' && n.record) out.push(n.record)
            if (n.children) walk(n.children)
        }
    }
    walk(timeline)
    return out
}

/** 按过滤条条件筛选记录；retries 语义 = attempt>0 或处于多 attempt 重试链中 */
export function applyTraceFilter(records: LlmCallRecord[], filter: TraceFilter): LlmCallRecord[] {
    let list = records
    if (filter.conversationId) list = list.filter(r => r.conversationId === filter.conversationId)
    if (filter.model) list = list.filter(r => r.model === filter.model)
    if (filter.status === 'failed') {
        list = list.filter(r => r.status !== 'ok')
    } else if (filter.status === 'retries') {
        // 按 (conv,turn,step) 统计出现次数，仅保留重试链相关记录
        const count = new Map<string, number>()
        for (const r of list) {
            const k = `${r.conversationId}:${r.turn}:${r.step}`
            count.set(k, (count.get(k) ?? 0) + 1)
        }
        list = list.filter(r => r.attempt > 0 || (count.get(`${r.conversationId}:${r.turn}:${r.step}`) ?? 0) > 1)
    }
    return list
}

const STATUS_DOT: Record<LlmCallRecord['status'], string> = {
    ok: 'bg-[var(--success)] shadow-[0_0_6px_rgba(16,185,129,.5)]',
    error: 'bg-[var(--error)] shadow-[0_0_6px_rgba(239,68,68,.5)]',
    aborted: 'bg-[var(--text-muted)]',
}
const STATUS_TXT: Record<LlmCallRecord['status'], string> = {ok: '成功', error: '失败', aborted: '中断'}

function fmtMs(ms: number): string {
    return ms >= 10000 ? `${(ms / 1000).toFixed(1)}s` : ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`
}
function fmtTime(ts: number): string {
    return new Date(ts).toLocaleTimeString('zh-CN', {hour12: false})
}

export function TimelineView({projection, filter, onOpenDetail}: TimelineViewProps) {
    const [expandedId, setExpandedId] = useState<string | null>(null)

    // 过滤 + 分组：conversation → turn，组内按 ts 排序
    const groups = useMemo(() => {
        const filtered = applyTraceFilter(collectRecords(projection.timeline), filter)
            .sort((a, b) => a.ts - b.ts)
        const byConv = new Map<string, Map<number, LlmCallRecord[]>>()
        for (const r of filtered) {
            let turns = byConv.get(r.conversationId)
            if (!turns) { turns = new Map(); byConv.set(r.conversationId, turns) }
            const list = turns.get(r.turn) ?? []
            list.push(r); turns.set(r.turn, list)
        }
        return [...byConv.entries()]
    }, [projection, filter])

    if (groups.length === 0) {
        return (
            <div className="flex-1 flex items-center justify-center text-sm text-[var(--text-muted)]">
                暂无符合条件的调用记录
            </div>
        )
    }

    return (
        <div className="flex-1 overflow-y-auto px-4 pt-3 pb-10">
            {groups.map(([convId, turns]) => (
                <div key={convId}>
                    {/* conversation 头 */}
                    <div className="flex items-baseline gap-2.5 mt-4 mb-2 pb-1.5 border-b border-dashed border-[var(--border)] first:mt-0">
                        <span className="font-semibold text-[13px] text-[var(--text-primary)]">{convId}</span>
                        <span className="text-[11px] font-mono text-[var(--text-muted)]">
                            {[...turns.values()].reduce((s, l) => s + l.length, 0)} 次调用 · {turns.size} 个 turn
                        </span>
                    </div>
                    {[...turns.entries()].sort((a, b) => a[0] - b[0]).map(([turn, records]) => (
                        <TurnGroup key={turn} turn={turn} records={records}
                            expandedId={expandedId} onToggle={(id) => {
                                setExpandedId(prev => prev === id ? null : id)
                                const rec = records.find(r => r.id === id)
                                if (rec && expandedId !== id) onOpenDetail(rec)
                            }} />
                    ))}
                </div>
            ))}
        </div>
    )
}

/** turn 组：左侧竖线 + 圆点标记；内部按 (turn,step) 归出重试链 */
function TurnGroup({turn, records, expandedId, onToggle}: {
    turn: number
    records: LlmCallRecord[]
    expandedId: string | null
    onToggle: (id: string) => void
}) {
    // 同 conversation+turn+step 多 attempt → 重试链容器
    const steps = new Map<number, LlmCallRecord[]>()
    for (const r of records) {
        const list = steps.get(r.step) ?? []
        list.push(r); steps.set(r.step, list)
    }
    const totalMs = records.reduce((s, r) => s + r.totalMs, 0)

    return (
        <div className="relative ml-2.5 pl-6">
            <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded bg-[var(--border)]" aria-hidden />
            <div className="flex items-center gap-2.5 mt-3 mb-1.5 text-xs text-[var(--text-secondary)] select-none">
                <span className="absolute -left-[7px] w-2.5 h-2.5 rounded-full bg-[var(--border)] border-2 border-[var(--surface)]" />
                <b className="text-[var(--text-primary)]">Turn {turn}</b>
                <span>{steps.size} 个步骤 · 总耗时 {(totalMs / 1000).toFixed(1)}s</span>
            </div>
            {[...steps.entries()].sort((a, b) => a[0] - b[0]).map(([step, list]) => (
                list.length > 1 ? (
                    <div key={step} className="border-l-2 border-[var(--error)] ml-1">
                        <div className="text-[11px] font-mono mt-2 mb-0.5 ml-2.5 text-red-400">
                            ↻ 重试链 · step {step} · 共 {list.length} 次 attempt
                        </div>
                        {list.map(r => (
                            <CallRow key={r.id} record={r} selected={expandedId === r.id}
                                onClick={() => onToggle(r.id)} />
                        ))}
                    </div>
                ) : (
                    <CallRow key={list[0].id} record={list[0]} selected={expandedId === list[0].id}
                        onClick={() => onToggle(list[0].id)} />
                )
            ))}
        </div>
    )
}

/** 单次调用行 */
function CallRow({record: r, selected, onClick}: {
    record: LlmCallRecord
    selected: boolean
    onClick: () => void
}) {
    return (
        <div>
            <div
                className={`flex items-center gap-2.5 py-2 px-3 my-1.5 rounded-lg bg-[var(--surface-elevated)] border cursor-pointer select-none transition-colors hover:border-[var(--text-muted)] ${selected ? 'border-[var(--brand-primary)]' : 'border-[var(--border)]'}`}
                onClick={onClick}
            >
                <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[r.status]}`} title={STATUS_TXT[r.status]} />
                <span className="font-mono text-[11px] text-[var(--text-muted)] w-16 shrink-0 tabular-nums">{fmtTime(r.ts)}</span>
                <span className="font-mono text-[11px] py-0.5 px-2 rounded bg-[var(--brand-muted)] text-[var(--brand-primary)] whitespace-nowrap">{r.model}</span>
                <span className="text-[10.5px] py-px px-1.5 rounded border border-[var(--border)] text-[var(--text-muted)] whitespace-nowrap">{r.context}</span>
                {r.attempt > 0 && (
                    <span className="text-[10.5px] font-mono py-px px-1.5 rounded bg-[var(--error-muted)] text-[var(--error)]">attempt {r.attempt}</span>
                )}
                {r.truncated && (
                    <span className="text-[10.5px] py-px px-1.5 rounded bg-[var(--warning-muted)] text-[var(--warning)]" title="响应流中断，文件不完整">截断</span>
                )}
                <span className="ml-auto flex gap-3.5 font-mono text-[11px] text-[var(--text-secondary)] whitespace-nowrap tabular-nums">
                    <span>{fmtMs(r.totalMs)} <span className="text-[var(--text-muted)]">TTFB {fmtMs(r.firstByteMs)}</span></span>
                </span>
                <span className={`text-[10px] text-[var(--text-muted)] transition-transform ${selected ? 'rotate-90' : ''}`}>▶</span>
            </div>
            {selected && r.error && (
                <div className="mx-3 my-1 py-2 px-3 rounded-md font-mono text-xs bg-[var(--error-muted)] border border-[var(--error)]/35 text-[var(--error)]">
                    {r.error.message}
                </div>
            )}
        </div>
    )
}
