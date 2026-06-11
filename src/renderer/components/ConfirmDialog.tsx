import {useCallback, useEffect, useState} from 'react'
import {AnimatePresence, motion} from 'framer-motion'

/**
 * 确认弹窗选项接口
 */
export interface ConfirmDialogOptions {
    title: string
    message: string
    confirmText?: string
    cancelText?: string
    confirmVariant?: 'danger' | 'primary' | 'warning'
    onConfirm?: () => void | Promise<void>
    onCancel?: () => void
}

/**
 * 确认弹窗状态管理
 */
let showConfirmDialog: ((options: ConfirmDialogOptions) => Promise<boolean>) | null = null

// 内部状态
let resolvePromise: ((value: boolean) => void) | null = null

/**
 * 显示确认弹窗
 * @param options 确认弹窗选项
 * @returns Promise<boolean> 用户确认返回 true，取消返回 false
 */
export function confirm(options: ConfirmDialogOptions): Promise<boolean> {
    return new Promise((resolve) => {
        resolvePromise = resolve
        window.dispatchEvent(
            new CustomEvent('hclaw:show-confirm-dialog', {detail: options})
        )
    })
}

// 导出给全局使用
if (typeof window !== 'undefined') {
    (window as any).hclawConfirm = confirm
}

/**
 * 确认弹窗组件
 * 用于需要用户确认的危险操作（如删除）
 */
export default function ConfirmDialog() {
    const [isOpen, setIsOpen] = useState(false)
    const [options, setOptions] = useState<ConfirmDialogOptions | null>(null)
    const [isLoading, setIsLoading] = useState(false)

    // 监听显示确认弹窗事件
    useEffect(() => {
        const handleShowDialog = (e: CustomEvent<ConfirmDialogOptions>) => {
            setOptions(e.detail)
            setIsOpen(true)
            setIsLoading(false)
        }

        window.addEventListener('hclaw:show-confirm-dialog', handleShowDialog as EventListener)
        return () => {
            window.removeEventListener('hclaw:show-confirm-dialog', handleShowDialog as EventListener)
        }
    }, [])

    const handleConfirm = useCallback(async () => {
        if (!options) return

        // Guard: if onConfirm is not a function, just close and resolve true
        if (typeof options.onConfirm !== 'function') {
            setIsOpen(false)
            resolvePromise?.(true)
            return
        }

        setIsLoading(true)

        try {
            // 执行确认回调
            await options.onConfirm()
            // 关闭弹窗并返回 true
            setIsOpen(false)
            resolvePromise?.(true)
        } catch (err) {
            // 即使回调出错也要关闭弹窗
            setIsLoading(false)
            console.error('[ConfirmDialog] onConfirm error:', err)
        }
    }, [options])

    const handleCancel = useCallback(() => {
        options?.onCancel?.()
        setIsOpen(false)
        resolvePromise?.(false)
    }, [options])

    // 按 ESC 关闭
    useEffect(() => {
        const handleEsc = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && isOpen) {
                handleCancel()
            }
        }
        document.addEventListener('keydown', handleEsc)
        return () => document.removeEventListener('keydown', handleEsc)
    }, [isOpen, handleCancel])

    // 配置按钮样式
    const confirmVariants = {
        danger: 'bg-red-500 hover:bg-red-600 text-white',
        warning: 'bg-orange-500 hover:bg-orange-600 text-white',
        primary: 'bg-[var(--brand-primary)] hover:bg-[var(--brand-primary)]/80 text-white',
    }

    const variant = options?.confirmVariant || 'primary'
    const confirmClassName = confirmVariants[variant] || confirmVariants.primary

    return (
        <AnimatePresence>
            {isOpen && options && (
                <>
                    {/* 背景遮罩 */}
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.15 }}
                        className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[99998]"
                        onClick={handleCancel}
                    />

                    {/* 弹窗主体 */}
                    <motion.div
                        initial={{ scale: 0.95, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0.95, opacity: 0 }}
                        transition={{ duration: 0.15, ease: 'easeOut' }}
                        className="fixed inset-0 flex items-center justify-center p-4 pointer-events-none z-[99999]"
                    >
                        <div
                            className="w-full max-w-sm bg-[var(--surface)] rounded-xl shadow-elevated overflow-hidden pointer-events-auto"
                            role="alertdialog"
                            aria-modal="true"
                            aria-labelledby="confirm-dialog-title"
                            onClick={(e) => e.stopPropagation()}
                        >
                            {/* Header */}
                            <div className="px-5 py-4 border-b border-[var(--border)] bg-[var(--surface-elevated)]">
                                <div className="flex items-center gap-3">
                                    {/* 图标 */}
                                    <div
                                        className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${
                                            variant === 'danger' ? 'bg-red-500/10' :
                                            variant === 'warning' ? 'bg-orange-500/10' :
                                            'bg-[var(--brand-primary)]/10'
                                        }`}
                                    >
                                        {variant === 'danger' ? (
                                            <svg className="w-5 h-5 text-red-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                <path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6m8 0V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
                                                <line x1="10" y1="11" x2="10" y2="17"/>
                                                <line x1="14" y1="11" x2="14" y2="17"/>
                                            </svg>
                                        ) : variant === 'warning' ? (
                                            <svg className="w-5 h-5 text-orange-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                                                <line x1="12" y1="9" x2="12" y2="13"/>
                                                <line x1="12" y1="17" x2="12.01" y2="17"/>
                                            </svg>
                                        ) : (
                                            <svg className="w-5 h-5 text-[var(--brand-primary)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                <circle cx="12" cy="12" r="10"/>
                                                <line x1="12" y1="8" x2="12" y2="12"/>
                                                <line x1="12" y1="16" x2="12.01" y2="16"/>
                                            </svg>
                                        )}
                                    </div>

                                    {/* 标题和描述 */}
                                    <div className="flex-1 min-w-0">
                                        <h2 id="confirm-dialog-title" className="text-sm font-semibold text-[var(--text-primary)]">
                                            {options.title}
                                        </h2>
                                    </div>
                                </div>
                            </div>

                            {/* Content */}
                            <div className="px-5 py-4">
                                <p className="text-sm text-[var(--text-secondary)] leading-relaxed whitespace-pre-wrap">
                                    {options.message}
                                </p>
                            </div>

                            {/* Actions */}
                            <div className="px-5 py-4 border-t border-[var(--border)] bg-[var(--surface-elevated)] flex justify-end gap-3">
                                <button
                                    onClick={handleCancel}
                                    disabled={isLoading}
                                    className="px-4 py-2 text-sm font-medium rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] hover:bg-[var(--surface-muted)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                >
                                    {options.cancelText || '取消'}
                                </button>
                                <button
                                    onClick={handleConfirm}
                                    disabled={isLoading}
                                    className={`px-4 py-2 text-sm font-medium rounded-lg ${confirmClassName} disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2`}
                                >
                                    {isLoading ? (
                                        <>
                                            <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin"/>
                                            处理中...
                                        </>
                                    ) : (
                                        options.confirmText || '确认'
                                    )}
                                </button>
                            </div>
                        </div>
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    )
}