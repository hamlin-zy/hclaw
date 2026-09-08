import {useEffect, useRef, useState} from 'react'
import clsx from 'clsx'
import type {MemoPriority} from '@shared/types/memo'

interface PrioritySelectProps {
    value?: MemoPriority
    onChange: (p: MemoPriority) => void
    size?: 'sm' | 'md'
    disabled?: boolean
}

interface PriorityOption {
    value: MemoPriority
    label: string
    /** 颜色圆点（跟随现有 CSS 变量） */
    dot: string
}

const OPTIONS: PriorityOption[] = [
    {value: 'urgent', label: '紧急', dot: 'var(--error)'},
    {value: 'high', label: '高', dot: 'var(--warning, #f59e0b)'},
    {value: 'normal', label: '普通', dot: 'var(--text-muted)'},
    {value: 'low', label: '低', dot: 'var(--border-emphasis)'},
]

/** 徽章式优先级下拉（缺省 value 显示"普通"）。需自行 stopPropagation，避免触发行级 onClick */
export function PrioritySelect({value, onChange, size = 'sm', disabled = false}: PrioritySelectProps) {
    const [open, setOpen] = useState(false)
    const rootRef = useRef<HTMLDivElement>(null)
    // 缺省 value 视为 normal（老数据无 priority 字段）
    const normalized = value ?? 'normal'
    const current = OPTIONS.find(o => o.value === normalized)!

    // 点击外部关闭
    useEffect(() => {
        if (!open) return
        const onDocClick = (e: MouseEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
        }
        document.addEventListener('mousedown', onDocClick)
        return () => document.removeEventListener('mousedown', onDocClick)
    }, [open])

    return (
        <div
            ref={rootRef}
            data-testid="priority-select"
            className={clsx('relative shrink-0', disabled && 'pointer-events-none opacity-50')}
        >
            <button
                type="button"
                aria-label="优先级"
                data-testid="priority-trigger"
                disabled={disabled}
                onClick={(e) => {
                    e.stopPropagation()
                    setOpen(o => !o)
                }}
                className={clsx(
                    'inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text-muted)] hover:text-[var(--brand-primary)] transition-colors cursor-pointer',
                    size === 'sm' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-1 text-xs',
                )}
            >
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{background: current.dot}}/>
                <span className="leading-none">{current.label}</span>
            </button>
            {open && (
                <div
                    data-testid="priority-menu"
                    onClick={(e) => e.stopPropagation()}
                    className="absolute right-0 top-full mt-1 z-50 min-w-[76px] rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] py-1"
                    style={{boxShadow: 'var(--shadow-overlay)'}}
                >
                    {OPTIONS.map(opt => (
                        <button
                            key={opt.value}
                            type="button"
                            data-testid={`priority-option-${opt.value}`}
                            onClick={(e) => {
                                e.stopPropagation()
                                onChange(opt.value)
                                setOpen(false)
                            }}
                            className={clsx(
                                'w-full flex items-center gap-1.5 px-2 py-1 text-[11px] text-left cursor-pointer hover:bg-[var(--surface-muted)]',
                                opt.value === normalized ? 'text-[var(--brand-primary)] font-medium' : 'text-[var(--text-primary)]',
                            )}
                        >
                            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{background: opt.dot}}/>
                            {opt.label}
                        </button>
                    ))}
                </div>
            )}
        </div>
    )
}
