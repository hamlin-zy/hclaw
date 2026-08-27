/**
 * LLM 调用轨迹时间线主区
 *
 * conversation → turn 两层分组；call 行含状态色点/时间/model chip/context 标签/
 * attempt 徽章/耗时+TTFB。重试（同 conversation+turn+step 多 attempt）合并为
 * 单卡片：主体显示最后一次 attempt + 红色「重试 N 次」徽章，展开内联列出全部尝试。
 */
import {useMemo, useState} from 'react'
import type {LlmCallRecord, LlmTraceProjection, TimelineNode, TraceFilter} from './types'

interface TimelineViewProps {
    projection: LlmTraceProjection
    filter: TraceFilter
    onOpenDetail: (record: LlmCallRecord) => void
    /** conversationId → 会话标题（会话下拉与分组头部展示用，缺省只显示 id） */
    conversationTitles?: Map<string, string>
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
    ok: 'bg-[var(--success)]',
    error: 'bg-[var(--error)]',
    aborted: 'bg-[var(--text-muted)]',
}
const STATUS_TXT: Record<LlmCallRecord['status'], string> = {ok: '成功', error: '失败', aborted: '中断'}

/** conversation 头展示文案：有标题显示「标题 · id 前 8 位」，否则原样显示 id */
function convHeaderLabel(titles: Map<string, string> | undefined, convId: string): string {
    const title = titles?.get(convId)
    return title ? `${title} · ${convId.slice(0, 8)}` : convId
}

function fmtMs(ms: number): string {
    return ms >= 10000 ? `${(ms / 1000).toFixed(1)}s` : ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`
}
function fmtTime(ts: number): string {
    return new Date(ts).toLocaleTimeString('zh-CN', {hour12: false})
}

export function TimelineView({projection, filter, onOpenDetail, conversationTitles}: TimelineViewProps) {
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
                        <span className="font-semibold text-[13px] text-[var(--text-primary)]">
                            {convHeaderLabel(conversationTitles, convId)}
                        </span>
                        <span className="text-[11px] font-mono text-[var(--text-muted)]">
                            {[...turns.values()].reduce((s, l) => s + l.length, 0)} 次调用 · {turns.size} 个 turn
                        </span>
                    </div>
                    {/* turn 降序：最新 turn 在前 */}
                    {[...turns.entries()].sort((a, b) => b[0] - a[0]).map(([turn, records]) => (
                        <TurnGroup key={turn} turn={turn} records={records}
                            expandedId={expandedId} onToggle={(id) => {
                                setExpandedId(prev => prev === id ? null : id)
                                const rec = records.find(r => r.id === id)
                                if (rec && expandedId !== id) onOpenDetail(rec)
                            }}
                            onOpenDetail={onOpenDetail} />
                    ))}
                </div>
            ))}
        </div>
    )
}

/** turn 组：左侧竖线 + 圆点标记；内部按 (turn,step) 归出重试组 */
function TurnGroup({turn, records, expandedId, onToggle, onOpenDetail}: {
    turn: number
    records: LlmCallRecord[]
    expandedId: string | null
    onToggle: (id: string) => void
    onOpenDetail: (record: LlmCallRecord) => void
}) {
    // 同 conversation+turn+step 多 attempt → 重试合并卡片
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
            {[...steps.entries()].sort((a, b) => a[0] - b[0]).map(([step, list]) => {
                const sorted = [...list].sort((a, b) => b.ts - a.ts || b.attempt - a.attempt)
                return sorted.length > 1 ? (
                    <RetryCard key={sorted[0].id} attempts={sorted}
                        onOpenDetail={onOpenDetail} />
                ) : (
                    <CallRow key={sorted[0].id} record={sorted[0]} selected={expandedId === sorted[0].id}
                        onClick={() => onToggle(sorted[0].id)} />
                )
            })}
        </div>
    )
}

/** 重试状态文本颜色：成功绿 / 失败红 / 中断灰（重试链可能以失败或中断收尾） */
const STATUS_TXT_COLOR: Record<LlmCallRecord['status'], string> = {
    ok: 'text-[var(--success)]',
    error: 'text-[var(--error)]',
    aborted: 'text-[var(--text-muted)]',
}

/** 有重试的步骤单卡片：主体 = 最后一次 attempt 数据 + 红色徽章；展开内联列出全部 attempt */
function RetryCard({attempts, onOpenDetail}: {
    /** 按 ts 降序（最新在前），最后尝试即首个元素 */
    attempts: LlmCallRecord[]
    onOpenDetail: (record: LlmCallRecord) => void
}) {
    const [open, setOpen] = useState(false)
    const last = attempts[0]
    const retries = attempts.length - 1
    return (
        <div className="my-1.5">
            {/* 主行：显示最后一次 attempt 数据；点击仅展开/收起，不打开详情 */}
            <div
                className={`flex items-center gap-2.5 py-2 px-3 rounded-lg bg-[var(--surface-elevated)] border cursor-pointer select-none transition-colors hover:border-[var(--text-muted)] ${open ? 'border-[var(--brand-primary)]' : 'border-[var(--border)]'}`}
                onClick={() => setOpen(o => !o)}
            >
                <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[last.status]}`} title={STATUS_TXT[last.status]} />
                <span className="font-mono text-[11px] text-[var(--text-muted)] w-16 shrink-0 tabular-nums">{fmtTime(last.ts)}</span>
                <span className="font-mono text-[11px] py-0.5 px-2 rounded bg-[var(--brand-muted)] text-[var(--brand-primary)] whitespace-nowrap">{last.model}</span>
                <span className="text-[10.5px] py-px px-1.5 rounded border border-[var(--border)] text-[var(--text-muted)] whitespace-nowrap">{last.context}</span>
                {last.truncated && (
                    <span className="text-[10.5px] py-px px-1.5 rounded bg-[var(--warning-muted)] text-[var(--warning)]" title="响应流中断，文件不完整">截断</span>
                )}
                <span className={`text-[10.5px] py-px px-1.5 rounded ${retries > 0 ? 'bg-[var(--error-muted)] text-[var(--error)]' : ''}`}>
                    重试 {retries} 次
                </span>
                <span className="ml-auto flex gap-3.5 font-mono text-[11px] text-[var(--text-secondary)] whitespace-nowrap tabular-nums">
                    <span>{fmtMs(last.totalMs)} <span className="text-[var(--text-muted)]">TTFB {fmtMs(last.firstByteMs)}</span></span>
                </span>
                <span className={`text-[10px] text-[var(--text-muted)] transition-transform ${open ? 'rotate-90' : ''}`}>▶</span>
            </div>
            {open && (
                <div className="ml-4">
                    {attempts.map((r, i) => (
                        <button
                            key={r.id}
                            onClick={() => onOpenDetail(r)}
                            className="flex items-center gap-2 w-full py-1 pl-2 pr-3 mt-0.5 rounded-md text-left cursor-pointer select-none hover:bg-[var(--surface-elevated)] transition-colors"
                        >
                            <span className="font-mono text-[10.5px] text-[var(--text-muted)] w-7 shrink-0">#{r.attempt}</span>
                            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[r.status]}`} title={STATUS_TXT[r.status]} />
                            <span className="text-[10.5px] text-[var(--text-secondary)]">{STATUS_TXT[r.status]}</span>
                            <span className="font-mono text-[10.5px] text-[var(--text-secondary)] tabular-nums">{fmtMs(r.totalMs)}</span>
                            {i === 0 && (
                                <span className={`text-[10px] font-medium ${STATUS_TXT_COLOR[r.status]}`}>最后尝试</span>
                            )}
                        </button>
                    ))}
                </div>
            )}
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
