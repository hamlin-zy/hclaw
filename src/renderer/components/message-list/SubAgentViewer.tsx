/**
 * SubAgentViewer — 子 Agent 输出查看弹窗
 *
 * 特性：
 * - 无幕布，可拖拽标题栏移动，可拖拽边缘/角落缩放
 * - 已完成 Agent 卡片只展示最终输出（+ Token 用量），不展示思考、工具执行等过程细节
 */

import {useCallback, useEffect, useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import type {ExtendedToolResult} from '../../stores/toolCallsStore'
import MarkdownRenderer from './MarkdownRenderer'

// ── 类型 ──

interface Props {
    title: string
    agentType?: string | null
    result?: ExtendedToolResult | null
    tokenUsage?: { inputTokens: number; outputTokens: number; totalTokens: number } | null
    onClose: () => void
    /** 跳转到对应子会话（由父组件在 taskId 存在时传入；不传则隐藏按钮） */
    onJumpToSession?: () => void
}

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
    return {sz, onStart}
}

// ── 主组件 ─────────────────────────────────

export default function SubAgentViewer({
                                           title,
                                           agentType,
                                           result,
                                           tokenUsage,
                                           onClose,
                                           onJumpToSession,
                                       }: Props) {
    // ★ 弹窗初始位置：主窗口水平垂直居中（需求：查看弹窗居中显示）。
    //   弹窗为条件渲染，每次打开重新挂载，初始值重新计算 → 每次打开均居中；
    //   Math.max 兜底防止窗口过小时弹窗溢出视口
    const {pos, dragging, onStart: onDragStart} = useDrag({
        x: Math.max((window.innerWidth - DEF_W) / 2, 8),
        y: Math.max((window.innerHeight - DEF_H) / 2, 80),
    })
    const {sz, onStart: onResizeStart} = useResize({w: DEF_W, h: DEF_H})

    // ESC 关闭
    useEffect(() => {
        const h = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', h)
        return () => window.removeEventListener('keydown', h)
    }, [onClose])

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
                    {/* ★ 代理机器人图标（与全站 agent 卡片 🤖 保持一致，原为齿轮图标） */}
                    <span className="w-4 h-4 shrink-0 text-[var(--brand-primary)] text-sm leading-none">🤖</span>
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
                    {onJumpToSession && (
                        <button
                            onClick={onJumpToSession}
                            className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium hover:bg-[var(--surface-muted)] transition-colors"
                            style={{color: 'var(--brand-primary)'}}
                            title="跳转到子会话"
                         data-name="sub-agent-viewer-button">
                            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                                <polyline points="15 3 21 3 21 9"/>
                                <line x1="10" y1="14" x2="21" y2="3"/>
                            </svg>
                            跳转
                        </button>
                    )}
                    <button onClick={onClose}
                            className="w-6 h-6 flex items-center justify-center rounded-md hover:bg-[var(--surface-muted)] transition-colors"
                            style={{color: 'var(--text-muted)'}} aria-label="关闭" data-name="sub-agent-viewer-close-button">
                        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M18 6L6 18M6 6l12 12"/>
                        </svg>
                    </button>
                </div>
            </div>

            {/* ── 内容区：只展示最终输出（已完成 Agent 不展示思考、工具执行等过程细节） ── */}
            <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-3"
                 style={{backgroundColor: 'var(--surface)'}}>
                {result?.output ? (
                    <div className="space-y-2">
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
                            <MarkdownRenderer>{String(result.output)}</MarkdownRenderer>
                        </div>
                    </div>
                ) : (
                    <div className="text-center py-8 text-sm" style={{color: 'var(--text-muted)'}}>
                        暂无最终输出
                    </div>
                )}

                {result?.error && (
                    <div className="space-y-2">
                        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider"
                             style={{color: 'var(--error)'}}>
                            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                 strokeWidth="2">
                                <circle cx="12" cy="12" r="10"/>
                                <line x1="15" y1="9" x2="9" y2="15"/>
                                <line x1="9" y1="9" x2="15" y2="15"/>
                            </svg>
                            错误
                        </div>
                        <pre className="rounded-lg p-3 text-xs leading-relaxed whitespace-pre-wrap break-all"
                             style={{
                                 backgroundColor: 'var(--error-muted)/15',
                                 border: '1px solid rgba(239,68,68,0.2)',
                                 color: 'var(--error)',
                                 maxHeight: 300,
                                 overflow: 'auto'
                             }}>
                            {String(result.error)}
                        </pre>
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
