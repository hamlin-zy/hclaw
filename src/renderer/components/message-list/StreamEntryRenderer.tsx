/**
 * StreamEntryRenderer — 共享的子 Agent 流式条目渲染组件
 *
 * 三种 variant（视觉层级）：
 *   detailed — 详细模式（ToolCallBody 内联展开）：SVG 图标、卡片边框、动画指示
 *   viewer   — 独立查看器（SubAgentViewer 弹窗）：大 SVG 图标、可折叠思考、时间戳
 *   popup    — 紧凑弹窗（CompactToolPopup）：纯文本 Unicode、截断、无时间戳
 *
 * 设计原则：
 * - 样式随 variant 切换，不随数据变化
 * - 渲染逻辑写一次（5 种 entry type），避免三处维护
 */

import type {ProgressEntry, SubAgentStreamEntry} from '../../stores/toolCallsStore'
import {truncate} from '../../lib/format'
import MarkdownRenderer from './MarkdownRenderer'

// ── 类型 ─────────────────────────────────────────────

/** 合并后的统一条目（用于按时间序渲染） */
export type MergedTimelineEntry =
    | { kind: 'progress'; log: ProgressEntry }
    | { kind: 'stream'; entry: SubAgentStreamEntry }

/** 渲染层兜底：合并连续 text/thinking 条目，避免 Store 层合并延迟导致逐词/逐 token 换行。 */
export function mergeConsecutiveTextEntries(streams: SubAgentStreamEntry[]): SubAgentStreamEntry[] {
    return streams.reduce<SubAgentStreamEntry[]>((acc, curr) => {
        const prev = acc[acc.length - 1]
        if (prev?.type === 'text' && curr.type === 'text') {
            acc[acc.length - 1] = {...prev, content: (prev.content || '') + (curr.content || '')}
        } else if (prev?.type === 'thinking' && curr.type === 'thinking') {
            acc[acc.length - 1] = {...prev, content: (prev.content || '') + (curr.content || '')}
        } else {
            acc.push(curr)
        }
        return acc
    }, [])
}

/**
 * 将 progressLog 和 subAgentStream 按时间戳合并排序。
 * 用于在 Agent 工具卡片中实现真正的时序交织渲染。
 *
 * 注意：合并前会对 subAgentStream 做文本条目合并兜底，
 * 确保即使 Store 层合并因 IPC 时序未生效，渲染也不会出现逐词换行。
 */
export function mergeTimeline(
    logs?: ProgressEntry[],
    streams?: SubAgentStreamEntry[],
): MergedTimelineEntry[] {
    const entries: MergedTimelineEntry[] = []

    logs?.forEach(log => entries.push({kind: 'progress', log}))
    ;(streams ? mergeConsecutiveTextEntries(streams) : []).forEach(
        entry => entries.push({kind: 'stream', entry}),
    )

    // 按时间戳升序排列
    entries.sort((a, b) => {
        const ta = a.kind === 'progress' ? a.log.timestamp : a.entry.timestamp
        const tb = b.kind === 'progress' ? b.log.timestamp : b.entry.timestamp
        return ta - tb
    })

    return entries
}

/**
 * 从合并后的时间轴条目中提取"最后活跃时间"（用于脉冲动画判断）。
 * 返回最后一条条目的时间戳，无数据时返回 0。
 */
export function getLastActiveTime(
    logs?: ProgressEntry[],
    streams?: SubAgentStreamEntry[],
): number {
    let last = 0
    logs?.forEach(l => { if (l.timestamp > last) last = l.timestamp })
    streams?.forEach(e => { if (e.timestamp > last) last = e.timestamp })
    return last
}

type RenderVariant = 'detailed' | 'viewer' | 'popup'

interface StreamEntryCardProps {
    entry: SubAgentStreamEntry
    variant: RenderVariant
    /** viewer 模式：思考块折叠状态（由父组件管理索引） */
    collapsed?: boolean
    /** viewer 模式：切换折叠回调 */
    onToggle?: () => void
}

interface ProgressTimelineProps {
    logs: ProgressEntry[]
    variant: RenderVariant
    /** 是否处于运行中（用于最后一条脉冲动画） */
    isRunning?: boolean
}

// ── 工具函数 ─────────────────────────────────────────

const fmtTime = (ts: number) => {
    const d = new Date(ts)
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`
}

// ═══════════════════════════════════════════════════════
//  StreamEntryCard
// ═══════════════════════════════════════════════════════

export function StreamEntryCard({entry, variant, collapsed, onToggle}: StreamEntryCardProps) {
    switch (entry.type) {
        // ── thinking ──────────────────────────────────────
        case 'thinking':
            return renderThinking(entry, variant, collapsed, onToggle)

        // ── text ──────────────────────────────────────────
        case 'text':
            return renderText(entry, variant)

        // ── tool_start ────────────────────────────────────
        case 'tool_start':
            return renderToolStart(entry, variant)

        // ── tool_result ───────────────────────────────────
        case 'tool_result':
            return renderToolResult(entry, variant)

        // ── error ─────────────────────────────────────────
        case 'error':
            return renderError(entry, variant)

        default:
            return null
    }
}

// ── 各类型渲染实现 ──────────────────────────────────

function renderThinking(
    entry: SubAgentStreamEntry,
    variant: RenderVariant,
    collapsed?: boolean,
    onToggle?: () => void,
) {
    if (variant === 'viewer') {
        return (
            <div className="space-y-1">
                <button onClick={onToggle} className="flex items-center gap-1.5 text-[11px] font-medium"
                        style={{color: 'var(--text-muted)'}}>
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/>
                    </svg>
                    <span>思考过程</span>
                    <span className="text-[10px]">{collapsed ? '▸' : '▾'}</span>
                    <span className="text-[9px] opacity-50">{fmtTime(entry.timestamp)}</span>
                </button>
                {!collapsed && (
                    <div className="ml-4 p-2.5 rounded-lg text-xs leading-relaxed whitespace-pre-wrap" style={{
                        backgroundColor: 'rgba(251,191,36,0.06)',
                        borderLeft: '3px solid rgba(251,191,36,0.3)',
                        color: 'var(--text-secondary)'
                    }}>
                        {entry.content}
                    </div>
                )}
            </div>
        )
    }

    if (variant === 'popup') {
        return (
            <div className="flex items-start gap-2 pl-4 py-1 text-[10px]">
                <span className="shrink-0 mt-0.5" style={{color: 'rgba(251,191,36,0.7)'}}>💭</span>
                <span className="flex-1 leading-relaxed whitespace-pre-wrap line-clamp-3"
                      style={{color: 'var(--text-secondary)'}}>{entry.content}</span>
            </div>
        )
    }

    // detailed
    return (
        <div className="flex items-start gap-2">
            <svg className="w-3 h-3 mt-1 shrink-0" style={{color: 'rgba(251,191,36,0.7)'}} viewBox="0 0 24 24"
                 fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/>
            </svg>
            <div className="flex-1 text-[11px] leading-relaxed whitespace-pre-wrap rounded-lg p-2" style={{
                backgroundColor: 'rgba(251,191,36,0.06)',
                borderLeft: '2px solid rgba(251,191,36,0.3)',
                color: 'var(--text-secondary)'
            }}>{entry.content}</div>
        </div>
    )
}

function renderText(entry: SubAgentStreamEntry, variant: RenderVariant) {
    if (variant === 'viewer') {
        return (
            <div className="flex items-start gap-2">
                <svg className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{color: 'var(--brand-primary)'}}
                     viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"/>
                </svg>
                <div className="flex-1 text-xs leading-relaxed"
                     style={{color: 'var(--text-primary)'}}>
                    <MarkdownRenderer>{entry.content || ''}</MarkdownRenderer>
                </div>
            </div>
        )
    }

    if (variant === 'popup') {
        return (
            <div className="flex items-start gap-2 pl-4 text-[10px]">
                <span className="flex-1 leading-relaxed whitespace-pre-wrap"
                      style={{color: 'var(--text-primary)'}}>{entry.content}</span>
            </div>
        )
    }

    // detailed
    return (
        <div className="flex items-start gap-2">
            <svg className="w-3 h-3 mt-1 shrink-0" style={{color: 'var(--brand-primary)'}} viewBox="0 0 24 24"
                 fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"/>
            </svg>
            <div className="flex-1 text-[11px] leading-relaxed whitespace-pre-wrap"
                 style={{color: 'var(--text-primary)'}}>{entry.content}</div>
        </div>
    )
}

function renderToolStart(entry: SubAgentStreamEntry, variant: RenderVariant) {
    // 参数格式化：viewer 纵向，popup 横向截断
    const hasArgs = entry.toolArgs && Object.keys(entry.toolArgs).length > 0

    if (variant === 'viewer') {
        return (
            <div className="rounded-lg border overflow-hidden"
                 style={{borderColor: 'var(--border)', backgroundColor: 'var(--surface-muted)'}}>
                <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium" style={{
                    backgroundColor: 'var(--surface-elevated)',
                    borderBottom: '1px solid var(--border)',
                    color: 'var(--info)'
                }}>
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/>
                        <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
                    </svg>
                    <span>{entry.toolName || '工具调用'}</span>
                </div>
                {hasArgs && (
                    <pre className="text-[10px] p-2.5 whitespace-pre-wrap font-mono leading-relaxed"
                         style={{color: 'var(--text-secondary)'}}>
                        {Object.entries(entry.toolArgs!).map(([k, v]) => {
                            const s = typeof v === 'string' ? v : JSON.stringify(v)
                            return `${k}: ${s.length > 80 ? s.slice(0, 80) + '...' : s}`
                        }).join('\n')}
                    </pre>
                )}
            </div>
        )
    }

    if (variant === 'popup') {
        return (
            <div className="flex items-center gap-2 pl-4 py-1 text-[10px]">
                <span className="shrink-0" style={{color: 'var(--info)'}}>🔧</span>
                <span className="font-medium truncate" style={{color: 'var(--info)'}}>{entry.toolName || '工具调用'}</span>
                {hasArgs && (
                    <span className="text-[var(--text-muted)] truncate">
                        {Object.entries(entry.toolArgs!).map(([k, v]) => {
                            const s = typeof v === 'string' ? v : JSON.stringify(v)
                            return `${k}: ${s.length > 30 ? s.slice(0, 30) + '...' : s}`
                        }).join(' | ')}
                    </span>
                )}
            </div>
        )
    }

    // detailed
    return (
        <div className="rounded-lg border overflow-hidden"
             style={{borderColor: 'var(--border)', backgroundColor: 'var(--surface-muted)'}}>
            <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-medium" style={{
                backgroundColor: 'var(--surface-elevated)',
                borderBottom: '1px solid var(--border)',
                color: 'var(--info)'
            }}>
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/>
                    <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
                </svg>
                <span>{entry.toolName || '工具调用'}</span>
            </div>
            {hasArgs && (
                <pre className="text-[9px] p-2 whitespace-pre-wrap font-mono leading-relaxed max-h-32 overflow-y-auto"
                     style={{color: 'var(--text-secondary)'}}>
                    {Object.entries(entry.toolArgs!).map(([k, v]) => {
                        const s = typeof v === 'string' ? v : JSON.stringify(v)
                        return `${k}: ${s.length > 60 ? s.slice(0, 60) + '...' : s}`
                    }).join('\n')}
                </pre>
            )}
        </div>
    )
}

function renderToolResult(entry: SubAgentStreamEntry, variant: RenderVariant) {
    const isErr = entry.isError

    if (variant === 'viewer') {
        return (
            <div className="rounded-lg border overflow-hidden" style={{
                borderColor: isErr ? 'rgba(196,92,92,0.2)' : 'rgba(16,185,129,0.2)',
                backgroundColor: isErr ? 'rgba(196,92,92,0.04)' : 'rgba(16,185,129,0.04)'
            }}>
                <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium" style={{
                    backgroundColor: 'var(--surface-elevated)',
                    borderBottom: `1px solid ${isErr ? 'rgba(196,92,92,0.2)' : 'rgba(16,185,129,0.2)'}`,
                    color: isErr ? 'var(--error)' : 'var(--success)'
                }}>
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        {isErr ? (
                            <><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></>
                        ) : (
                            <><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></>
                        )}
                    </svg>
                    <span>{entry.toolName || '工具结果'}</span>
                    {isErr && <span className="ml-auto text-[10px]">失败</span>}
                </div>
                {entry.content && (
                    <div className="p-2.5 max-h-60 overflow-y-auto"
                         style={{color: isErr ? 'var(--error)' : 'var(--text-secondary)'}}>
                        <MarkdownRenderer>{truncate(entry.content, 3000)}</MarkdownRenderer>
                    </div>
                )}
            </div>
        )
    }

    if (variant === 'popup') {
        return (
            <div className="rounded-lg border overflow-hidden" style={{
                borderColor: isErr ? 'rgba(196,92,92,0.15)' : 'rgba(16,185,129,0.15)',
                backgroundColor: isErr ? 'rgba(196,92,92,0.03)' : 'rgba(16,185,129,0.03)'
            }}>
                <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-medium" style={{
                    backgroundColor: 'var(--surface-elevated)',
                    borderBottom: `1px solid ${isErr ? 'rgba(196,92,92,0.15)' : 'rgba(16,185,129,0.15)'}`,
                    color: isErr ? 'var(--error)' : 'var(--success)'
                }}>
                    <span>{isErr ? '❌' : '✓'}</span>
                    <span>{entry.toolName || '工具结果'}</span>
                    {isErr && <span className="ml-auto">失败</span>}
                </div>
                {entry.content && (
                    <div className="p-1.5 max-h-32 overflow-y-auto text-[10px] leading-relaxed"
                         style={{color: isErr ? 'var(--error)' : 'var(--text-secondary)'}}>
                        <MarkdownRenderer>{truncate(entry.content, 500)}</MarkdownRenderer>
                    </div>
                )}
            </div>
        )
    }

    // detailed
    return (
        <div className="rounded-lg border overflow-hidden" style={{
            borderColor: isErr ? 'rgba(196,92,92,0.2)' : 'rgba(16,185,129,0.2)',
            backgroundColor: isErr ? 'rgba(196,92,92,0.04)' : 'rgba(16,185,129,0.04)'
        }}>
            <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-medium" style={{
                backgroundColor: 'var(--surface-elevated)',
                borderBottom: `1px solid ${isErr ? 'rgba(196,92,92,0.2)' : 'rgba(16,185,129,0.2)'}`,
                color: isErr ? 'var(--error)' : 'var(--success)'
            }}>
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    {isErr ? (
                        <><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></>
                    ) : (
                        <><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></>
                    )}
                </svg>
                <span>{entry.toolName || '工具结果'}</span>
                {isErr && <span className="ml-auto">失败</span>}
            </div>
            {entry.content && (
                <div className="p-2 max-h-48 overflow-y-auto"
                     style={{color: isErr ? 'var(--error)' : 'var(--text-secondary)'}}>
                    <MarkdownRenderer>{truncate(entry.content, 1000)}</MarkdownRenderer>
                </div>
            )}
        </div>
    )
}

function renderError(entry: SubAgentStreamEntry, variant: RenderVariant) {
    if (variant === 'viewer') {
        return (
            <div className="rounded-lg p-2.5 text-xs leading-relaxed" style={{
                backgroundColor: 'rgba(196,92,92,0.08)',
                border: '1px solid rgba(196,92,92,0.2)',
                color: 'var(--error)'
            }}>
                <div className="flex items-center gap-1.5 font-medium mb-1">
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="10"/>
                        <line x1="15" y1="9" x2="9" y2="15"/>
                        <line x1="9" y1="9" x2="15" y2="15"/>
                    </svg>
                    <span>错误</span>
                    <span className="text-[9px] opacity-50 ml-auto">{fmtTime(entry.timestamp)}</span>
                </div>
                <div className="ml-5">{entry.content}</div>
            </div>
        )
    }

    if (variant === 'popup') {
        return (
            <div className="flex items-start gap-2 pl-4 py-1 text-[10px]">
                <span className="shrink-0 mt-0.5" style={{color: 'var(--error)'}}>❌</span>
                <span className="flex-1" style={{color: 'var(--error)'}}>{entry.content}</span>
            </div>
        )
    }

    // detailed
    return (
        <div className="flex items-start gap-2 text-[11px]" style={{color: 'var(--error)'}}>
            <svg className="w-3 h-3 mt-0.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2">
                <circle cx="12" cy="12" r="10"/>
                <line x1="15" y1="9" x2="9" y2="15"/>
                <line x1="9" y1="9" x2="15" y2="15"/>
            </svg>
            <span>{entry.content}</span>
        </div>
    )
}

// ═══════════════════════════════════════════════════════
//  ProgressTimeline
// ═══════════════════════════════════════════════════════

export function ProgressTimeline({logs, variant, isRunning}: ProgressTimelineProps) {
    if (!logs || logs.length === 0) return null

    if (variant === 'viewer') {
        return (
            <div className="relative pl-4 ml-1 space-y-1"
                 style={{borderLeft: '2px solid var(--border-muted)'}}>
                {logs.map((entry, i) => {
                    const active = i === logs.length - 1
                    return (
                        <div key={i} className="relative flex items-start gap-3 py-1">
                            <div className="absolute -left-[17px] top-2.5 w-2 h-2 rounded-full shrink-0"
                                 style={{
                                     backgroundColor: active ? 'var(--brand-primary)' : 'var(--border-muted)',
                                     boxShadow: active ? '0 0 6px rgba(91,141,217,0.5)' : 'none'
                                 }}/>
                            <span className="text-[10px] font-mono mt-1 shrink-0"
                                  style={{color: 'var(--text-muted)'}}>{fmtTime(entry.timestamp)}</span>
                            <span className="text-xs leading-relaxed" style={{
                                color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                                fontWeight: active ? 500 : 400
                            }}>
                                {entry.text.replace(/^子 Agent /, '')}
                            </span>
                        </div>
                    )
                })}
            </div>
        )
    }

    if (variant === 'popup') {
        return (
            <>
                {logs.map((entry, j) => (
                    <div key={j} className="flex items-start gap-2 pl-4 py-1 text-[10px] text-[var(--text-secondary)]">
                        <span className="text-[var(--info)] mt-0.5">●</span>
                        <span className="flex-1">{entry.text.replace(/^子 Agent /, '')}</span>
                    </div>
                ))}
            </>
        )
    }

    // detailed
    return (
        <div className="space-y-0.5">
            {logs.map((entry, i) => {
                const isLast = i === logs.length - 1
                return (
                    <div key={i} className="flex items-start gap-2 text-[11px]">
                        <div className="flex flex-col items-center shrink-0 pt-1">
                            <div className={`w-2 h-2 rounded-full ${
                                isRunning && isLast
                                    ? 'bg-[var(--info)] animate-pulse'
                                    : 'bg-[var(--text-muted)]/40'
                            }`}/>
                            {i < logs.length - 1 && (
                                <div className="w-px h-3 bg-[var(--border-muted)]"/>
                            )}
                        </div>
                        <span className={`${
                            isRunning && isLast
                                ? 'text-[var(--info)]'
                                : 'text-[var(--text-secondary)]'
                        }`}>
                            {entry.text.replace(/^子 Agent /, '')}
                        </span>
                    </div>
                )
            })}
        </div>
    )
}
