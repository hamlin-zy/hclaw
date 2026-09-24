import {AnimatePresence, motion} from 'framer-motion'
import {dropdown} from '../lib/motionPresets'
import {useEffect, useMemo, useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import type {PhraseItem} from '@shared/types/phrase'
import {usePhraseStore} from '../stores/phraseStore'
import {filterPhrases} from '../utils/phrase'
import {INPUT_FOCUS} from '../lib/inputFocus'

interface PhrasePickerProps {
    open: boolean
    anchorRef: React.RefObject<HTMLTextAreaElement | null>
    onClose: () => void
    onPick: (phrase: PhraseItem) => void
}

export default function PhrasePicker({open, anchorRef, onClose, onPick}: PhrasePickerProps) {
    const phrases = usePhraseStore((s) => s.phrases)
    const load = usePhraseStore((s) => s.load)
    const [query, setQuery] = useState('')
    const [sel, setSel] = useState(0)
    const searchRef = useRef<HTMLInputElement>(null)
    const listRef = useRef<HTMLDivElement>(null)
    const panelRef = useRef<HTMLDivElement>(null)
    const onCloseRef = useRef(onClose)
    // 打开时聚焦输入框的一次性 rAF；卸载/关闭时取消，避免对已卸载节点聚焦
    const focusRafRef = useRef<number | null>(null)

    useEffect(() => { onCloseRef.current = onClose }, [onClose])

    useEffect(() => {
        if (open) {
            void load()
            setQuery('')
            setSel(0)
            focusRafRef.current = requestAnimationFrame(() => { focusRafRef.current = null; searchRef.current?.focus() })
        }
        return () => {
            if (focusRafRef.current !== null) { cancelAnimationFrame(focusRafRef.current); focusRafRef.current = null }
        }
    }, [open, load])

    // 关闭时把焦点还给锚定 textarea（Esc 关闭/未选中即关闭的场景下避免焦点丢失）
    useEffect(() => {
        if (!open) anchorRef.current?.focus()
    }, [open, anchorRef])

    // 焦点兜底：面板外的 mousedown 或全局 Esc 都能关闭。
    // 面板内 onKeyDown 已 stopPropagation，document 收不到不会重复触发。
    useEffect(() => {
        if (!open) return
        const handleOutsideDown = (e: MouseEvent) => {
            const panel = panelRef.current
            if (panel && !panel.contains(e.target as Node)) onCloseRef.current()
        }
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onCloseRef.current()
        }
        document.addEventListener('mousedown', handleOutsideDown)
        document.addEventListener('keydown', handleEscape)
        return () => {
            document.removeEventListener('mousedown', handleOutsideDown)
            document.removeEventListener('keydown', handleEscape)
        }
    }, [open])

    const sorted = useMemo(() => [...phrases].sort((a, b) =>
        ((b.lastUsedAt ?? b.createdAt) - (a.lastUsedAt ?? a.createdAt)) || (b.createdAt - a.createdAt),
    ), [phrases])

    const filtered = useMemo(() => filterPhrases(sorted, query), [sorted, query])

    useEffect(() => setSel(0), [query])
    useEffect(() => {
        listRef.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({block: 'nearest'})
    }, [sel, filtered])

    const onKeyDown = (e: React.KeyboardEvent) => {
        const keyMap: Record<string, () => void> = {
            ArrowDown: () => setSel(i => (i + 1) % Math.max(filtered.length, 1)),
            ArrowUp: () => setSel(i => (i - 1 + filtered.length) % Math.max(filtered.length, 1)),
            Enter: () => { const p = filtered[sel]; if (p) onPick(p) },
            Escape: () => onClose(),
        }
        const handler = keyMap[e.key]
        if (handler) { e.preventDefault(); e.stopPropagation(); handler() }
    }

    const rect = open ? anchorRef.current?.getBoundingClientRect() : undefined
    const dropUp = rect ? rect.top > window.innerHeight / 2 : false
    const style: React.CSSProperties = rect
        ? (dropUp
            ? {left: rect.left, bottom: window.innerHeight - rect.top + 6}
            : {left: rect.left, top: rect.bottom + 6})
        : {left: 0, top: 0}

    return createPortal(
        <AnimatePresence>
            {open && (
            <motion.div
                ref={panelRef}
                {...dropdown}
                transition={{duration: 0.12}}
                style={style}
                className="fixed z-[9999] w-[380px] bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-2xl overflow-hidden"
                onKeyDown={onKeyDown}
                data-name="phrase-picker-panel"
            >
                <div className="px-3 py-2.5 border-b border-[var(--border-muted)] bg-[var(--surface-muted)]">
                    <div className="relative">
                        <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)] shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2" aria-hidden="true">
                            <circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>
                        </svg>
                        <input
                            ref={searchRef}
                            value={query}
                            onChange={e => setQuery(e.target.value)}
                            placeholder="搜索快捷短语…"
                            className={`w-full pl-8 pr-3 py-1.5 text-sm bg-[var(--surface)] rounded-lg border border-[var(--border)] text-[var(--text-primary)] placeholder-[var(--text-muted)] ${INPUT_FOCUS}`}
                        />
                    </div>
                </div>

                <div ref={listRef} className="max-h-64 overflow-y-auto py-1 select-text">
                    {filtered.length === 0 ? (
                        <div className="p-6 text-center text-sm text-[var(--text-secondary)]">
                            {phrases.length === 0
                                ? '暂无快捷短语，可在「切换菜单 → 快捷短语」中管理'
                                : `未找到匹配 "${query}" 的短语`}
                        </div>
                    ) : filtered.map((p, i) => (
                        <div
                            key={p.id}
                            data-idx={i}
                            onClick={() => onPick(p)}
                            className={`mx-1 px-2 py-2 rounded-lg cursor-pointer flex items-center gap-2.5 transition-colors ${
                                i === sel ? 'bg-[color-mix(in_srgb,var(--brand-primary)_15%,transparent)] border-l-2 border-l-[var(--brand-primary)]' : 'hover:bg-[var(--surface-muted)]'
                            }`}
                            data-name="phrase-picker-item"
                        >
                            <span className={`flex-1 min-w-0 truncate text-sm ${i === sel ? 'text-[var(--text-brand)]' : 'text-[var(--text-primary)]'}`}>
                                {p.content}
                            </span>
                        </div>
                    ))}
                </div>

                <div className="px-3 py-2 border-t border-[var(--border-muted)] flex gap-4 text-[10px] text-[var(--text-secondary)]">
                    {[['↑↓', '导航'], ['Enter', '粘贴'], ['Esc', '关闭']].map(([k, l]) => (
                        <span key={k}><kbd className="px-1 py-0.5 bg-[var(--surface-muted)] border border-[var(--border)] rounded font-mono">{k}</kbd> {l}</span>
                    ))}
                </div>
            </motion.div>
            )}
        </AnimatePresence>,
        document.body,
    )
}
