import {useEffect, useLayoutEffect, useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import {AnimatePresence, motion} from 'framer-motion'

/** 弹层面板最大高度，同时用于判断是否向上翻转（与 ThemedSelect 对齐） */
const PANEL_MAX_H = 240
/** 弹层出现/消失动画的垂直偏移量 */
const PANEL_SLIDE = 6

/**
 * 主题化组合输入框（自由输入 + 建议下拉）
 *
 * 与 ThemedSelect 同风格：
 * - 触发器为真实 input（可自由输入任意值，不限于建议列表）
 * - 聚焦/输入时弹出过滤后的建议面板
 * - 面板 createPortal 挂到 body（脱离弹窗 backdrop-filter stacking context）
 * - fixed 定位 + 空间检测自动上/下翻转 + 毛玻璃面板 + 品牌色高亮
 */
export default function ThemedCombobox({
                                           value,
                                           onChange,
                                           suggestions = [],
                                           placeholder = '',
                                           disabled = false,
                                           className = '',
                                           ariaLabel,
                                       }: {
    value: string
    onChange: (value: string) => void
    /** 建议项（按输入过滤，子串匹配，大小写不敏感）；空列表 = 纯输入框 */
    suggestions?: string[]
    placeholder?: string
    disabled?: boolean
    className?: string
    ariaLabel?: string
}) {
    const [open, setOpen] = useState(false)
    const [activeIdx, setActiveIdx] = useState(-1)
    const [pos, setPos] = useState<{top: number; left: number; width: number; dropUp: boolean} | null>(null)
    const inputRef = useRef<HTMLInputElement>(null)
    const panelRef = useRef<HTMLDivElement>(null)

    const q = value.trim().toLowerCase()
    const filtered = q
        ? suggestions.filter(s => s.toLowerCase().includes(q) && s.toLowerCase() !== q)
        : suggestions

    // 计算面板位置：默认向下弹出，剩余空间不足时向上
    useLayoutEffect(() => {
        if (!open || !inputRef.current) return
        const rect = inputRef.current.getBoundingClientRect()
        const dropUp = window.innerHeight - rect.bottom < PANEL_MAX_H && rect.top > PANEL_MAX_H
        setPos({
            top: dropUp ? rect.top - 6 : rect.bottom + 6,
            left: rect.left,
            width: rect.width,
            dropUp,
        })
    }, [open])

    // 面板宽度以触发输入框为下限，随内容自适应，溢出时向左收拢钳制在视口内
    useLayoutEffect(() => {
        if (!open || !pos || !panelRef.current) return
        const pw = panelRef.current.offsetWidth
        const maxLeft = window.innerWidth - pw - 8
        if (pos.left > maxLeft) {
            setPos(p => (p ? {...p, left: Math.max(8, maxLeft)} : p))
        }
    }, [open, pos])

    useEffect(() => {
        if (!open) return
        const handleOutside = (e: MouseEvent) => {
            if (
                panelRef.current && !panelRef.current.contains(e.target as Node) &&
                inputRef.current && !inputRef.current.contains(e.target as Node)
            ) {
                setOpen(false)
            }
        }
        document.addEventListener('mousedown', handleOutside)
        return () => {
            document.removeEventListener('mousedown', handleOutside)
        }
    }, [open])

    const pick = (v: string) => {
        setOpen(false)
        inputRef.current?.blur()
        onChange(v)
    }

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            if (filtered.length === 0) return
            setOpen(true)
            setActiveIdx(e.key === 'ArrowDown' ? 0 : filtered.length - 1)
            e.preventDefault()
            return
        }
        if (!open) return
        if (e.key === 'Escape') {
            setOpen(false)
            return
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            setActiveIdx(i => {
                const next = e.key === 'ArrowDown' ? i + 1 : i - 1
                return (next + filtered.length) % filtered.length
            })
            e.preventDefault()
            return
        }
        if (e.key === 'Enter' && activeIdx >= 0 && activeIdx < filtered.length) {
            pick(filtered[activeIdx])
            e.preventDefault()
        }
    }

    return (
        <>
            <input
                ref={inputRef}
                type="text"
                value={value}
                disabled={disabled}
                placeholder={placeholder}
                aria-label={ariaLabel}
                onChange={(e) => {
                    onChange(e.target.value)
                    if (!open && filtered.length > 0) setOpen(true)
                }}
                onFocus={() => filtered.length > 0 && setOpen(true)}
                onKeyDown={handleKeyDown}
                role="combobox"
                aria-expanded={open}
                aria-autocomplete="list"
                className={`px-2 py-1.5 text-xs bg-[var(--surface)] border border-gray-200 rounded text-left text-[var(--text-primary)] placeholder-gray-400 transition-colors focus:outline-none focus:border-brand-300 hover:border-gray-300 disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
             data-name="themed-combobox-input"/>

            {open && createPortal(
                <AnimatePresence>
                    <motion.div
                        ref={panelRef}
                        initial={{opacity: 0, y: PANEL_SLIDE, scale: 0.97}}
                        animate={{opacity: 1, y: 0, scale: 1}}
                        exit={{opacity: 0, y: PANEL_SLIDE, scale: 0.97}}
                        transition={{duration: 0.15, ease: [0.4, 0, 0.2, 1]}}
                        onMouseDown={(e) => e.stopPropagation()}
                        role="listbox"
                        style={{
                            position: 'fixed',
                            top: pos?.dropUp ? undefined : pos?.top,
                            bottom: pos?.dropUp ? window.innerHeight - (pos?.top ?? 0) : undefined,
                            left: pos?.left,
                            width: 'max-content',
                            minWidth: pos?.width,
                            maxWidth: 'min(480px, calc(100vw - 16px))',
                        }}
                        className="z-[100002]"
                    >
                        <div className="bg-[var(--surface-elevated)] border border-[var(--border)] rounded-xl shadow-2xl shadow-black/20 overflow-hidden max-h-[240px] overflow-y-auto">
                            <div className="p-1.5 flex flex-col">
                                {filtered.map((s, i) => (
                                    <button
                                        key={s}
                                        type="button"
                                        onMouseEnter={() => setActiveIdx(i)}
                                        onClick={() => pick(s)}
                                        role="option"
                                        aria-selected={i === activeIdx}
                                        className={`w-full px-2.5 py-2 text-left text-[11px] rounded-lg transition-colors ${
                                            i === activeIdx
                                                ? 'bg-[var(--brand-primary)]/15 text-[var(--brand-primary)] font-medium'
                                                : 'text-[var(--text-primary)] hover:bg-[var(--surface-muted)]'
                                        }`}
                                     data-name={`themed-combobox-option-${i}`}>
                                        <span className="block truncate">{s}</span>
                                    </button>
                                ))}
                                {filtered.length === 0 && (
                                    <div className="px-2.5 py-3 text-center text-[11px] text-[var(--text-muted)]">
                                        无匹配建议
                                    </div>
                                )}
                            </div>
                        </div>
                    </motion.div>
                </AnimatePresence>,
                document.body,
            )}
        </>
    )
}
