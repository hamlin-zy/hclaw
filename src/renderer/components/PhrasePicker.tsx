import {motion} from 'framer-motion'
import {useEffect, useMemo, useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import type {PhraseItem} from '@shared/types/phrase'
import {usePhraseStore} from '../stores/phraseStore'
import {filterPhrases} from '../utils/phrase'

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

    useEffect(() => {
        if (open) {
            void load()
            setQuery('')
            setSel(0)
            requestAnimationFrame(() => searchRef.current?.focus())
        }
    }, [open, load])

    // 关闭时把焦点还给锚定 textarea（Esc 关闭/未选中即关闭的场景下避免焦点丢失）
    useEffect(() => {
        if (!open) anchorRef.current?.focus()
    }, [open, anchorRef])

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
        if (keyMap[e.key]) { e.preventDefault(); e.stopPropagation(); keyMap[e.key]() }
    }

    if (!open) return null

    const rect = anchorRef.current?.getBoundingClientRect()
    const dropUp = rect ? rect.top > window.innerHeight / 2 : false
    const style: React.CSSProperties = rect
        ? (dropUp
            ? {left: rect.left, bottom: window.innerHeight - rect.top + 6}
            : {left: rect.left, top: rect.bottom + 6})
        : {left: 0, top: 0}

    return createPortal(
        <div className="fixed z-[9999]" style={style}>
            <motion.div
                initial={{opacity: 0, y: -6}}
                animate={{opacity: 1, y: 0}}
                transition={{duration: 0.12}}
                className="w-[380px] bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-2xl overflow-hidden"
                onKeyDown={onKeyDown}
                data-name="phrase-picker-panel"
            >
                <div className="flex items-center gap-2 px-3 py-2.5 border-b border-[var(--border)] bg-[var(--surface-muted)]">
                    <svg className="w-4 h-4 text-[var(--text-muted)] shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2" aria-hidden="true">
                        <circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>
                    </svg>
                    <input
                        ref={searchRef}
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        placeholder="搜索快捷短语…"
                        className="flex-1 bg-transparent text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none"
                    />
                </div>

                <div ref={listRef} className="max-h-64 overflow-y-auto py-1">
                    {filtered.length === 0 ? (
                        <div className="p-6 text-center text-sm text-[var(--text-muted)]">
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
                                i === sel ? 'bg-[var(--brand-primary)]/15 border-l-2 border-l-[var(--brand-primary)]' : 'hover:bg-[var(--surface-muted)]'
                            }`}
                            data-name="phrase-picker-item"
                        >
                            <span className={`flex-1 min-w-0 truncate text-sm ${i === sel ? 'text-[var(--brand-primary)]' : 'text-[var(--text-primary)]'}`}>
                                {p.content}
                            </span>
                        </div>
                    ))}
                </div>

                <div className="px-3 py-2 border-t border-[var(--border)] flex gap-4 text-[10px] text-[var(--text-muted)]">
                    {[['↑↓', '导航'], ['Enter', '粘贴'], ['Esc', '关闭']].map(([k, l]) => (
                        <span key={k}><kbd className="px-1 py-0.5 bg-[var(--surface-muted)] border border-[var(--border)] rounded font-mono">{k}</kbd> {l}</span>
                    ))}
                </div>
            </motion.div>
        </div>,
        document.body,
    )
}
