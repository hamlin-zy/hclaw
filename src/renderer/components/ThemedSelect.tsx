import {useEffect, useLayoutEffect, useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import {AnimatePresence, motion} from 'framer-motion'
import {useSettingsStore} from '../stores/settingsStore'

/** 弹层面板最大高度，同时用于判断是否向上翻转 */
const PANEL_MAX_H = 240
/** 弹层出现/消失动画的垂直偏移量（方向依 dropUp 取反） */
const PANEL_SLIDE = 6

export interface ThemedSelectOption {
    value: string
    label: string
    /** 附加说明，显示在 label 下方 */
    hint?: string
    disabled?: boolean
    /** 分组分隔线：在该项上方绘制分隔线 */
    divider?: boolean
}

/**
 * 主题化下拉选择器
 *
 * 与 SchemeSelector / WorkModeSelector 同风格：
 * - 触发按钮样式对齐表单输入框（紧凑尺寸）
 * - 面板 createPortal 挂到 body（脱离弹窗 backdrop-filter stacking context）
 * - fixed 定位 + 空间检测自动上/下翻转
 * - 毛玻璃面板 + 品牌色高亮 + 选中对勾
 */
export default function ThemedSelect({
                                         value,
                                         options,
                                         onChange,
                                         disabled = false,
                                         placeholder = '',
                                         error = false,
                                         className = '',
                                         ariaLabel,
                                         fullWidth = false,
                                     }: {
    value: string
    options: ThemedSelectOption[]
    onChange: (value: string) => void
    disabled?: boolean
    placeholder?: string
    error?: boolean
    className?: string
    ariaLabel?: string
    /** 撑满父容器（表单网格/等宽布局用）；默认宽度随选中项文本自适应，不换行不截断 */
    fullWidth?: boolean
}) {
    const [open, setOpen] = useState(false)
    const [pos, setPos] = useState<{top: number; left: number; width: number; dropUp: boolean} | null>(null)
    const btnRef = useRef<HTMLButtonElement>(null)
    const panelRef = useRef<HTMLDivElement>(null)
    // 用户自定义背景图开启 → 弹层切换毛玻璃；默认主题下用不透明 surface（与弹窗/菜单同原则）
    const bgEnabled = useSettingsStore(s => s.settings.ui.background?.enabled && !!s.settings.ui.background.imagePath)

    const selected = options.find((o) => o.value === value)

    // 计算面板位置：默认向下弹出，剩余空间不足时向上
    useLayoutEffect(() => {
        if (!open || !btnRef.current) return
        const rect = btnRef.current.getBoundingClientRect()
        const dropUp = window.innerHeight - rect.bottom < PANEL_MAX_H && rect.top > PANEL_MAX_H
        setPos({
            top: dropUp ? rect.top - 6 : rect.bottom + 6,
            left: rect.left,
            width: rect.width,
            dropUp,
        })
    }, [open])

    // 面板宽度按内容自适应，靠窗口右缘时可能溢出 → 渲染后实测宽度，向左收拢钳制在视口内
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
                btnRef.current && !btnRef.current.contains(e.target as Node)
            ) {
                setOpen(false)
            }
        }
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', handleOutside)
        document.addEventListener('keydown', handleEscape)
        return () => {
            document.removeEventListener('mousedown', handleOutside)
            document.removeEventListener('keydown', handleEscape)
        }
    }, [open])

    const pick = (v: string) => {
        setOpen(false)
        onChange(v)
    }

    return (
        <>
            <button
                ref={btnRef}
                type="button"
                disabled={disabled}
                onClick={() => setOpen((o) => !o)}
                aria-label={ariaLabel}
                aria-expanded={open}
                aria-haspopup="listbox"
                className={`flex items-center justify-between gap-1.5 px-2 py-1.5 text-[11px] bg-[var(--surface)] border rounded text-left transition-colors focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed ${
                    error
                        ? 'border-[var(--error)] focus:border-[var(--focus-ring)]'
                        : open
                            ? 'border-[var(--brand-border)] focus:border-[var(--focus-ring)]'
                            : 'border-[var(--border)] hover:border-[var(--border-emphasis)] focus:border-[var(--focus-ring)]'
                } ${fullWidth ? 'w-full' : 'w-auto max-w-full whitespace-nowrap'} ${className}`}
             data-name="themed-select-button">
                <span className={`truncate ${selected ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'}`}>
                    {selected?.label || placeholder}
                </span>
                <svg
                    className={`w-3 h-3 shrink-0 text-[var(--text-muted)] transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
                    viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"
                >
                    <polyline points="6 9 12 15 18 9"/>
                </svg>
            </button>

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
                            // 默认：宽度随最长选项文本自适应（限视口内），触发按钮宽度为下限
                            ...(fullWidth
                                ? {width: pos ? Math.max(pos.width, 160) : undefined}
                                : {width: 'max-content', minWidth: pos?.width, maxWidth: 'min(480px, calc(100vw - 16px))'}),
                        }}
                        className="z-[100002]"
                    >
                        <div className={`${bgEnabled
                            ? 'bg-[color-mix(in_srgb,var(--surface-elevated)_92%,transparent)] backdrop-blur-lg'
                            : 'bg-[var(--surface-elevated)]'} border border-[var(--border)] rounded-xl shadow-2xl shadow-black/20 overflow-hidden max-h-[240px] overflow-y-auto`}>
                            <div className="p-1.5 flex flex-col">
                                {options.map((opt, i) => {
                                    const isActive = opt.value === value
                                    return (
                                        <div key={opt.value || '__empty'}>
                                            {opt.divider && <div className="my-1 h-px bg-[var(--border)]"/>}
                                            <button
                                                type="button"
                                                disabled={opt.disabled}
                                                onClick={() => !opt.disabled && pick(opt.value)}
                                                role="option"
                                                aria-selected={isActive}
                                                className={`w-full px-2.5 py-2 text-left text-[11px] rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                                                    isActive
                                                        ? 'bg-[var(--surface-muted)] text-[var(--text-secondary)] font-medium'
                                                        : 'text-[var(--text-primary)] hover:bg-[var(--surface-muted)]'
                                                }`}
                                             data-name={`themed-select-option-${i}`}>
                                                {/*
                                                  选中态（ui-09 复核整改 · C7）：原先把 `--brand-primary`
                                                  当 11px 文字色（`:root` 实测 2.05:1、`.yuanshandai`
                                                  2.41:1），属 C7 母句点名禁止的用法。改为**文字级令牌**
                                                  `--text-secondary`（在 `scripts/audit-contrast.mjs` 的
                                                  14 个令牌之内，四主题 × 三种底色 ≥4.5:1）；「这一项是当前
                                                  选中」不再靠文字色承载，改由 `bg-[var(--surface-muted)]`
                                                  底 + `font-medium` + 行尾对勾图标承载。
                                                  刻意不用品牌**文字**令牌：它的令牌名里含有会被
                                                  tokenCompliance 的 PALETTE 正则当成 Tailwind 调色板类名
                                                  的子串（`brand` 就在词表里），那一版写法在扫描集内不可用。
                                                */}
                                                <div className="flex items-center gap-2">
                                                    <span className="flex-1 truncate">{opt.label}</span>
                                                    {isActive && (
                                                        // 对勾是**图形**不是小字：C7 约束的是 ≤14px 文字色。这里用
                                                        // 非 `text-` 前缀的任意属性写法，把品牌色保留给图形，同时不
                                                        // 触发「调色板类名」扫描（`--brand-primary` 本就不在 PALETTE 词表里）。
                                                        <svg className="w-3.5 h-3.5 [color:var(--brand-primary)] shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                                            <polyline points="20 6 9 17 4 12"/>
                                                        </svg>
                                                    )}
                                                </div>
                                                {opt.hint && (
                                                    <div className="text-2xs text-[var(--text-secondary)] truncate mt-0.5">
                                                        {opt.hint}
                                                    </div>
                                                )}
                                            </button>
                                        </div>
                                    )
                                })}
                                {options.length === 0 && (
                                    <div className="px-2.5 py-3 text-center text-[11px] text-[var(--text-secondary)]">
                                        暂无可选项
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
