/**
 * SubAgentViewer — 子 Agent 输出查看弹窗
 *
 * 特性：
 * - 无幕布，可拖拽标题栏移动，可拖拽边缘/角落缩放
 * - 双标签页：时间轴 / 详细输出（思考/工具调用/正文）
 */

import {useCallback, useEffect, useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import type {ExtendedToolResult, ProgressEntry, SubAgentStreamEntry} from '../../stores/toolCallsStore'
import {truncate} from '../../lib/format'
import {StreamEntryCard, mergeTimeline, mergeConsecutiveTextEntries, getLastActiveTime} from './StreamEntryRenderer'
import MarkdownRenderer from './MarkdownRenderer'

const fmtTime = (ts: number) => {
    const d = new Date(ts)
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`
}

// ── 类型 ──

interface Props {
    title: string
    agentType?: string | null
    progressLog?: ProgressEntry[]
    subAgentStream?: SubAgentStreamEntry[]
    result?: ExtendedToolResult | null
    tokenUsage?: { inputTokens: number; outputTokens: number; totalTokens: number } | null
    onClose: () => void
}

type TabId = 'timeline' | 'stream'

const MIN_W = 420, MIN_H = 320, DEF_W = 680, DEF_H = 520

// ── 自定义拖拽 Hook ─────────────────────────

function useDrag(init: { x: number; y: number }) {
    const [pos, setPos] = useState(init)
    const [drag, setDrag] = useState(false)
    const ref = useRef({x: 0, y: 0, pos: {x: 0, y: 0}})
    const onStart = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        setDrag(true)
        ref.current = {x: e.clientX, y: e.clientY, pos: {...pos}}
    }, [pos])
    useEffect(() => {
        if (!drag) return
        const mv = (e: MouseEvent) => setPos({
            x: ref.current.pos.x + e.clientX - ref.current.x,
            y: ref.current.pos.y + e.clientY - ref.current.y
        })
        const up = () => setDrag(false)
        window.addEventListener('mousemove', mv);
        window.addEventListener('mouseup', up)
        return () => {
            window.removeEventListener('mousemove', mv);
            window.removeEventListener('mouseup', up)
        }
    }, [drag])
    return {pos, dragging: drag, onStart}
}

// ── 自定义缩放 Hook ─────────────────────────

function useResize(init: { w: number; h: number }) {
    const [sz, setSz] = useState(init)
    const [resize, setResize] = useState<'se' | 's' | 'e' | null>(null)
    const ref = useRef({x: 0, y: 0, sz: {w: 0, h: 0}})
    const onStart = useCallback((e: React.MouseEvent, dir: 'se' | 's' | 'e') => {
        e.preventDefault();
        e.stopPropagation()
        setResize(dir);
        ref.current = {x: e.clientX, y: e.clientY, sz: {...sz}}
    }, [sz])
    useEffect(() => {
        if (!resize) return
        const mv = (e: MouseEvent) => {
            const dx = e.clientX - ref.current.x, dy = e.clientY - ref.current.y
            let w = ref.current.sz.w, h = ref.current.sz.h
            if (resize === 'e' || resize === 'se') w = Math.max(MIN_W, ref.current.sz.w + dx)
            if (resize === 's' || resize === 'se') h = Math.max(MIN_H, ref.current.sz.h + dy)
            setSz({w, h})
        }
        const up = () => setResize(null)
        window.addEventListener('mousemove', mv);
        window.addEventListener('mouseup', up)
        return () => {
            window.removeEventListener('mousemove', mv);
            window.removeEventListener('mouseup', up)
        }
    }, [resize])
    return {sz, resizing: resize, onStart}
}



// ── 主组件 ─────────────────────────────────

export default function SubAgentViewer({
                                           title,
                                           agentType,
                                           progressLog,
                                           subAgentStream,
                                           result,
                                           tokenUsage,
                                           onClose
                                       }: Props) {
    const entries = subAgentStream ? mergeConsecutiveTextEntries(subAgentStream) : []
    const logs = progressLog || []

    const {pos, dragging, onStart: onDragStart} = useDrag({x: 120, y: 80})
    const {sz, resizing, onStart: onResizeStart} = useResize({w: DEF_W, h: DEF_H})
    const [activeTab, setActiveTab] = useState<TabId>(entries.length > 0 ? 'stream' : 'timeline')
    const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
    const streamEndRef = useRef<HTMLDivElement>(null)

    // ESC 关闭
    useEffect(() => {
        const h = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', h)
        return () => window.removeEventListener('keydown', h)
    }, [onClose])

    // 自动滚动
    useEffect(() => {
        if (activeTab === 'stream' && streamEndRef.current) streamEndRef.current.scrollIntoView({behavior: 'smooth'})
    }, [activeTab, subAgentStream?.length])

    const toggleThinking = useCallback((idx: number) => setCollapsed(p => {
        const n = new Set(p);
        n.has(idx) ? n.delete(idx) : n.add(idx);
        return n
    }), [])

    const tabs: { id: TabId; label: string; count: number }[] = [
        {id: 'timeline', label: '时间轴', count: logs.length},
        {id: 'stream', label: '详细输出', count: entries.length},
    ]

    return createPortal(
        <div className="fixed z-[9999] rounded-xl overflow-hidden shadow-2xl border flex flex-col"
             style={{
                 left: pos.x, top: pos.y, width: sz.w, height: sz.h,
                 minWidth: MIN_W, minHeight: MIN_H,
                 backgroundColor: 'var(--surface)', borderColor: 'var(--border)',
                 boxShadow: '0 8px 32px rgba(0,0,0,0.3), 0 2px 8px rgba(0,0,0,0.15)',
                 cursor: dragging ? 'grabbing' : 'default',
             }}
        >
            {/* ── 标题栏（拖拽区域） ── */}
            <div className="h-10 flex items-center justify-between px-3 shrink-0 select-none"
                 style={{
                     backgroundColor: 'var(--surface-elevated)',
                     borderBottom: '1px solid var(--border)',
                     cursor: 'grab'
                 }}
                 onMouseDown={onDragStart}>
                <div className="flex items-center gap-2 min-w-0">
                    <svg className="w-4 h-4 shrink-0" style={{color: 'var(--brand-primary)'}} viewBox="0 0 24 24"
                         fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="3"/>
                        <path
                            d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
                    </svg>
                    <span className="text-sm font-semibold truncate" style={{color: 'var(--text-primary)'}}>
                        {title.length > 50 ? title.slice(0, 50) + '...' : title}
                    </span>
                    {agentType && (
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0"
                              style={{backgroundColor: 'var(--brand-muted)/30', color: 'var(--brand-primary)'}}>
                            {agentType}
                        </span>
                    )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                    <span className="text-[10px] select-none" style={{color: 'var(--text-muted)'}}>{sz.w}×{sz.h}</span>
                    <button onClick={onClose}
                            className="w-6 h-6 flex items-center justify-center rounded-md hover:bg-[var(--surface-muted)] transition-colors"
                            style={{color: 'var(--text-muted)'}} aria-label="关闭">
                        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M18 6L6 18M6 6l12 12"/>
                        </svg>
                    </button>
                </div>
            </div>

            {/* ── 标签页（数据驱动） ── */}
            <div className="flex items-center gap-1 px-3 py-1.5 shrink-0"
                 style={{borderBottom: '1px solid var(--border)'}}>
                {tabs.map(t => (
                    <button key={t.id} onClick={() => setActiveTab(t.id)}
                            className={`px-3 py-1 rounded text-[11px] font-medium transition-all ${activeTab === t.id ? 'bg-[var(--brand-primary)]/15 text-[var(--brand-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'}`}>
                        {t.label}
                        {t.count > 0 && <span className="ml-1.5 text-[10px] opacity-60">{t.count}</span>}
                    </button>
                ))}
            </div>

            {/* ── 内容区 ── */}
            <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-3"
                 style={{backgroundColor: 'var(--surface)'}}>
                {activeTab === 'timeline' ? (
                    /* 时间轴标签页 — 进度 + 流式条目按真实时间序交织渲染 */
                    (logs.length > 0 || (subAgentStream && subAgentStream.length > 0)) ? (
                        <div className="space-y-2">
                            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider"
                                 style={{color: 'var(--text-muted)'}}>
                                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                     strokeWidth="2">
                                    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
                                </svg>
                                执行时间轴
                            </div>
                            {(() => {
                                const merged = mergeTimeline(logs, subAgentStream || [])
                                const lastTime = getLastActiveTime(logs, subAgentStream || [])
                                return (
                                    <div className="relative pl-4 ml-1 space-y-1"
                                         style={{borderLeft: '2px solid var(--border-muted)'}}>
                                        {merged.map((e, i) => {
                                            const ts = e.kind === 'progress' ? e.log.timestamp : e.entry.timestamp
                                            const active = ts === lastTime
                                            if (e.kind === 'progress') {
                                                return (
                                                    <div key={`p-${i}`} className="relative flex items-start gap-3 py-1">
                                                        <div className="absolute -left-[17px] top-2.5 w-2 h-2 rounded-full shrink-0"
                                                             style={{
                                                                 backgroundColor: active ? 'var(--brand-primary)' : 'var(--border-muted)',
                                                                 boxShadow: active ? '0 0 6px rgba(91,141,217,0.5)' : 'none'
                                                             }}/>
                                                        <span className="text-[10px] font-mono mt-1 shrink-0"
                                                              style={{color: 'var(--text-muted)'}}>{fmtTime(ts)}</span>
                                                        <span className="text-xs leading-relaxed" style={{
                                                            color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                                                            fontWeight: active ? 500 : 400
                                                        }}>
                                                            {e.log.text.replace(/^子 Agent /, '')}
                                                        </span>
                                                    </div>
                                                )
                                            }
                                            return (
                                                <div key={`s-${i}`}>
                                                    <StreamEntryCard entry={e.entry} variant="viewer"
                                                                     collapsed={collapsed.has(-i - 1)}
                                                                     onToggle={() => {}}/>
                                                </div>
                                            )
                                        })}
                                    </div>
                                )
                            })()}
                        </div>
                    ) : (
                        <div className="text-center py-8 text-sm"
                             style={{color: 'var(--text-muted)'}}>暂无时间轴数据</div>
                    )
                ) : (
                    /* 详细输出标签页 */
                    entries.length > 0 ? (
                        entries.map((entry, idx) => (
                            <StreamEntryCard key={idx} entry={entry} variant="viewer"
                                             collapsed={collapsed.has(idx)}
                                             onToggle={() => toggleThinking(idx)}/>
                        ))
                    ) : (
                        <div className="text-center py-8 text-sm" style={{color: 'var(--text-muted)'}}>子 Agent
                            正在运行中，暂无详细输出...</div>
                    )
                )}

                {/* 自动滚动锚点（仅 stream tab） */}
                {activeTab === 'stream' && <div ref={streamEndRef}/>}

                {/* 最终输出 + Token（双标签页共用） */}
                {result?.output && (
                    <div className={`space-y-2 ${activeTab === 'stream' ? 'pt-3 border-t' : 'pt-2'}`}
                         style={activeTab === 'stream' ? {borderColor: 'var(--border)'} : undefined}>
                        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider"
                             style={{color: 'var(--text-muted)'}}>
                            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                 strokeWidth="2">
                                <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
                            </svg>
                            最终输出
                        </div>
                        <div className="rounded-lg p-3 text-xs leading-relaxed" style={{
                            backgroundColor: 'var(--surface-muted)',
                            border: '1px solid var(--border)',
                            color: 'var(--text-primary)',
                            maxHeight: 300,
                            overflow: 'auto'
                        }}>
                            <MarkdownRenderer>{truncate(String(result.output), 10000)}</MarkdownRenderer>
                        </div>
                    </div>
                )}

                {tokenUsage && (
                    <div className="flex items-center gap-3 text-[10px] font-mono px-3 py-2 rounded-lg" style={{
                        backgroundColor: 'var(--surface-muted)',
                        border: '1px solid var(--border)',
                        color: 'var(--text-muted)'
                    }}>
                        <span>Token:</span>
                        <span style={{color: 'var(--success)'}}>IN {tokenUsage.inputTokens.toLocaleString()}</span>
                        <span
                            style={{color: 'var(--brand-primary)'}}>OUT {tokenUsage.outputTokens.toLocaleString()}</span>
                        <span>TOTAL {tokenUsage.totalTokens.toLocaleString()}</span>
                    </div>
                )}
            </div>

            {/* ── 缩放把手 ── */}
            <div className="absolute bottom-0 right-0 w-4 h-4" style={{cursor: 'se-resize'}}
                 onMouseDown={e => onResizeStart(e, 'se')}>
                <svg className="w-3 h-3 absolute bottom-1 right-1" viewBox="0 0 12 12"
                     style={{color: 'var(--text-muted)'}}>
                    <path d="M12 12V9L3 12H0l12-9v9z" fill="currentColor" opacity="0.4"/>
                </svg>
            </div>
            <div className="absolute bottom-0 left-1 right-5 h-2" style={{cursor: 's-resize'}}
                 onMouseDown={e => onResizeStart(e, 's')}/>
            <div className="absolute top-1 bottom-5 right-0 w-2" style={{cursor: 'e-resize'}}
                 onMouseDown={e => onResizeStart(e, 'e')}/>
        </div>,
        document.body
    )
}


