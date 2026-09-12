import {useCallback, useEffect, useRef, useState} from 'react'
import {AnimatePresence, motion} from 'framer-motion'
import {fade, scaleFade} from '../lib/motionPresets'

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

// 内部状态：confirm 与 confirmWithInput 共用一个 resolver（泛型化以便返回 string | null）
let resolveFn: ((value: unknown) => void) | null = null

/** 取出并清空当前 pending resolver（模块级单例，取用即消费，避免重复 resolve） */
function takeResolver(): ((value: unknown) => void) | null {
    const resolve = resolveFn
    resolveFn = null
    return resolve
}

/** 挂起 resolver 并广播弹窗事件；事件处理器（ConfirmDialog）负责后续 resolve */
function showDialog(kind: 'confirm' | 'input', options: ConfirmDialogOptions): Promise<unknown> {
    return new Promise((resolve) => {
        resolveFn = resolve
        window.dispatchEvent(
            new CustomEvent('hclaw:show-confirm-dialog', {detail: {kind, ...options}})
        )
    })
}

/**
 * 显示确认弹窗
 * @param options 确认弹窗选项
 * @returns Promise<boolean> 用户确认返回 true，取消返回 false
 */
export function confirm(options: ConfirmDialogOptions): Promise<boolean> {
    return showDialog('confirm', options) as Promise<boolean>
}

export interface ConfirmInputOptions extends Omit<ConfirmDialogOptions, 'onConfirm'> {
    inputLabel?: string
    placeholder?: string
    initialValue?: string
    /** true → 渲染 textarea，Ctrl/Cmd+Enter 提交；缺省 → 单行 input，Enter 提交 */
    multiline?: boolean
}

/** 显示带输入的确认弹窗。返回 trim 后的值；取消 / ESC / 点遮罩 → null */
export function confirmWithInput(options: ConfirmInputOptions): Promise<string | null> {
    return showDialog('input', options) as Promise<string | null>
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
    const [kind, setKind] = useState<'confirm' | 'input'>('confirm')
    const [inputValue, setInputValue] = useState('')
    const [isOpen, setIsOpen] = useState(false)
    const [options, setOptions] = useState<ConfirmDialogOptions | null>(null)
    const [isLoading, setIsLoading] = useState(false)

    // 实时镜像（供 ESC 监听器读取，避免闭包读到过期状态）
    const optionsRef = useRef<ConfirmDialogOptions | null>(null)
    const kindRef = useRef<'confirm' | 'input'>('confirm')

    // 监听显示确认弹窗事件
    useEffect(() => {
        const handleShowDialog = (e: CustomEvent<ConfirmDialogOptions & {kind?: string}>) => {
            const detail = e.detail
            const nextKind = detail.kind === 'input' ? 'input' : 'confirm'
            optionsRef.current = detail
            kindRef.current = nextKind
            setKind(nextKind)
            setOptions(detail)
            setInputValue(nextKind === 'input' ? ((detail as ConfirmInputOptions).initialValue ?? '') : '')
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

        if (kind === 'input') {
            const value = inputValue.trim()
            if (!value) return                      // 空值兜底（按钮本身已 disabled）
            const resolve = takeResolver()
            setIsOpen(false)
            resolve?.(value)
            return
        }

        // Guard: if onConfirm is not a function, just close and resolve true
        if (typeof options.onConfirm !== 'function') {
            const resolve = takeResolver()
            setIsOpen(false)
            resolve?.(true)
            return
        }

        setIsLoading(true)
        try {
            await options.onConfirm()
            const resolve = takeResolver()
            setIsOpen(false)
            resolve?.(true)
        } catch (err) {
            setIsLoading(false)
            console.error('[ConfirmDialog] onConfirm error:', err)
        }
    }, [options, kind, inputValue])

    const handleCancel = useCallback(() => {
        optionsRef.current?.onCancel?.()
        const resolve = takeResolver()
        setIsOpen(false)
        resolve?.(kindRef.current === 'input' ? null : false)
    }, [])

    // 按 ESC 关闭（监听器常驻，经 ref 读取最新状态与 pending resolver）
    useEffect(() => {
        const handleEsc = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && resolveFn) {
                handleCancel()
            }
        }
        document.addEventListener('keydown', handleEsc)
        return () => document.removeEventListener('keydown', handleEsc)
    }, [handleCancel])

    // 配置按钮样式
    const confirmVariants = {
        danger: 'bg-red-500 hover:bg-red-600 text-white',
        warning: 'bg-orange-500 hover:bg-orange-600 text-white',
        primary: 'bg-[var(--brand-primary)] hover:bg-[var(--brand-primary)]/80 text-white',
    }

    const variant = options?.confirmVariant || 'primary'
    const confirmClassName = confirmVariants[variant] || confirmVariants.primary
    // 输入型弹窗的选项视图（非输入型为 null），避免在 JSX 内反复断言 options 类型
    const inputOptions = kind === 'input' ? (options as ConfirmInputOptions) : null

    return (
        <AnimatePresence>
            {isOpen && options && (
                <>
                    {/* 背景遮罩 */}
                    <motion.div
                        {...fade}
                        transition={{ duration: 0.15 }}
                        className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[99998]"
                        onClick={handleCancel}
                        data-testid="confirm-dialog-mask"
                    />

                    {/* 弹窗主体 */}
                    <motion.div
                        {...scaleFade}
                        transition={{ duration: 0.15, ease: 'easeOut' }}
                        className="fixed inset-0 flex items-center justify-center p-4 pointer-events-none z-[99999]"
                    >
                        <div
                            className="dialog-surface w-full max-w-sm bg-[var(--surface)] rounded-xl shadow-elevated overflow-hidden pointer-events-auto"
                            role="alertdialog"
                            aria-modal="true"
                            aria-labelledby="confirm-dialog-title"
                            onClick={(e) => e.stopPropagation()}
                         data-name="confirm-dialog-div">
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
                                {inputOptions && (
                                    <div className="mt-3">
                                        {inputOptions.inputLabel && (
                                            <label htmlFor="confirm-dialog-input" className="block mb-1 text-xs text-[var(--text-muted)]">
                                                {inputOptions.inputLabel}
                                            </label>
                                        )}
                                        {inputOptions.multiline ? (
                                            <textarea
                                                id="confirm-dialog-input"
                                                rows={3}
                                                autoFocus
                                                value={inputValue}
                                                placeholder={inputOptions.placeholder}
                                                onChange={e => setInputValue(e.target.value)}
                                                onKeyDown={e => {
                                                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                                                        e.preventDefault()
                                                        void handleConfirm()
                                                    }
                                                }}
                                                className="w-full resize-none rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--brand-primary)]"
                                             data-name="confirm-dialog-textarea" />
                                        ) : (
                                            <input
                                                id="confirm-dialog-input"
                                                type="text"
                                                autoFocus
                                                value={inputValue}
                                                placeholder={inputOptions.placeholder}
                                                onChange={e => setInputValue(e.target.value)}
                                                onKeyDown={e => {
                                                    if (e.key === 'Enter') {
                                                        e.preventDefault()
                                                        void handleConfirm()
                                                    }
                                                }}
                                                className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--brand-primary)]"
                                             data-name="confirm-dialog-input" />
                                        )}
                                    </div>
                                )}
                            </div>

                            {/* Actions */}
                            <div className="px-5 py-4 border-t border-[var(--border)] bg-[var(--surface-elevated)] flex justify-end gap-3">
                                <button
                                    onClick={handleCancel}
                                    disabled={isLoading}
                                    className="px-4 py-2 text-sm font-medium rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] hover:bg-[var(--surface-muted)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                 data-name="confirm-dialog-button">
                                    {options.cancelText || '取消'}
                                </button>
                                <button
                                    onClick={handleConfirm}
                                    disabled={isLoading || (kind === 'input' && inputValue.trim() === '')}
                                    className={`px-4 py-2 text-sm font-medium rounded-lg ${confirmClassName} disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2`}
                                 data-name="confirm-dialog-confirm-button">
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