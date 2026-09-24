import {useEffect, useRef, type ReactNode} from 'react'
import {createPortal} from 'react-dom'
import clsx from 'clsx'
import {motion} from 'framer-motion'
import {fade, scaleFade} from '../../lib/motionPresets'

/**
 * 尺寸档位：只沿用既有档位，不发明新尺寸体系。
 * - md = 580px：AgentsDialog / CommandsDialog / MCPEditModal 的既有对话框基准档
 * - lg = 700px：PromptConfigDialog 既有档
 * 面板用 max-w + w-full，天然随视口收缩（等价既有 max-w-[90vw] 的做法）。
 */
const SIZE_CLASS = {
    md: 'max-w-[580px]',
    lg: 'max-w-[700px]',
} as const

/** 初始聚焦目标：首个可聚焦元素（不做完整 focus trap，见任务决策） */
const FOCUSABLE = [
    'button:not([disabled])',
    '[href]',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(',')

interface ModalProps {
    open: boolean
    onClose: () => void
    size?: 'md' | 'lg'
    /** 无障碍名（role="dialog" 的 aria-label） */
    ariaLabel?: string
    /** 点击遮罩是否关闭（默认 true）。表单类弹窗可设 false 防误触丢失输入 */
    closeOnOverlay?: boolean
    children: ReactNode
}

/**
 * 通用弹窗：portal 渲染 + Esc 关闭 + 遮罩点击关闭 + 焦点回归触发元素。
 *
 * 只提供外壳与焦点/键盘语义，内容布局由 children 决定（不在本组件内建 header/footer）。
 */
export function Modal({open, onClose, size = 'md', ariaLabel, closeOnOverlay = true, children}: ModalProps) {
    const panelRef = useRef<HTMLDivElement>(null)
    const restoreRef = useRef<HTMLElement | null>(null)

    // 打开时记住触发元素并初始聚焦；关闭/卸载时焦点回归触发元素
    useEffect(() => {
        if (!open) return
        const active = document.activeElement
        restoreRef.current = active instanceof HTMLElement ? active : null

        const panel = panelRef.current
        const target = panel?.querySelector<HTMLElement>(FOCUSABLE) ?? panel
        target?.focus()

        return () => {
            restoreRef.current?.focus()
            restoreRef.current = null
        }
    }, [open])

    // Esc 关闭
    useEffect(() => {
        if (!open) return
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [open, onClose])

    if (!open) return null

    return createPortal(
        <motion.div
            {...fade}
            transition={{duration: 0.15}}
            className="fixed inset-0 z-[var(--z-overlay)] flex items-center justify-center p-4"
        >
            {/* 遮罩：点击面板以外区域关闭 */}
            <div
                aria-hidden="true"
                onClick={(e) => {
                    if (closeOnOverlay && e.target === e.currentTarget) onClose()
                }}
                className="absolute inset-0 bg-black/50"
                data-name="modal-backdrop"
            />
            <motion.div
                {...scaleFade}
                transition={{duration: 0.15, ease: 'easeOut'}}
                ref={panelRef}
                role="dialog"
                aria-modal="true"
                aria-label={ariaLabel}
                tabIndex={-1}
                className={clsx(
                    'relative flex w-full max-h-[85vh] flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-elevated focus:outline-none',
                    SIZE_CLASS[size],
                    'select-text',
                )}
                data-name="modal-panel"
            >
                {children}
            </motion.div>
        </motion.div>,
        document.body,
    )
}
