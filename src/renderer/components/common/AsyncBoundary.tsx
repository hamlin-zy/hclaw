import type {ReactNode} from 'react'
import {EmptyState} from './EmptyState'

interface AsyncBoundaryProps {
    loading: boolean
    error?: string | null
    empty?: boolean
    /** 提供时错误态渲染重试按钮 */
    onRetry?: () => void
    loadingText?: string
    emptyTitle?: string
    emptyHint?: string
    children: ReactNode
}

/**
 * 异步三态边界：loading → error → empty → children。
 *
 * 优先级：loading 优先于 error（加载中不展示旧错误），error 优先于 empty。
 * 只做分支渲染，不持有任何状态（数据加载由调用方的 hook 负责）。
 */
export function AsyncBoundary({
    loading,
    error,
    empty = false,
    onRetry,
    loadingText = '加载中...',
    emptyTitle = '暂无数据',
    emptyHint,
    children,
}: AsyncBoundaryProps) {
    if (loading) {
        return (
            <div
                role="status"
                aria-live="polite"
                className="flex items-center justify-center gap-[var(--space-snug)] px-4 py-8 text-xs text-[var(--text-secondary)]"
                data-name="async-boundary-loading"
            >
                <svg className="h-3.5 w-3.5 shrink-0 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <span>{loadingText}</span>
            </div>
        )
    }

    if (error) {
        return (
            <div
                role="alert"
                className="flex flex-col items-center justify-center gap-[var(--space-snug)] px-4 py-8 text-center"
                data-name="async-boundary-error"
            >
                <div className="max-w-[48ch] text-xs leading-relaxed break-words text-[var(--error)]">{error}</div>
                {onRetry && (
                    <button
                        type="button"
                        onClick={onRetry}
                        className="rounded-md border border-[var(--border)] px-[var(--space-normal)] py-1 text-xs text-[var(--text-secondary)] transition-colors hover:border-[var(--border-emphasis)] hover:text-[var(--text-brand)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--brand-primary)_30%,transparent)] dark-all:focus-visible:ring-[color-mix(in_srgb,var(--brand-primary)_20%,transparent)]"
                        data-name="async-boundary-retry-button"
                    >
                        重试
                    </button>
                )}
            </div>
        )
    }

    if (empty) return <EmptyState title={emptyTitle} hint={emptyHint} />

    return <>{children}</>
}
