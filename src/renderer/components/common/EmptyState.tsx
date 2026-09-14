import type {ReactNode} from 'react'

export interface EmptyStateProps {
    title: string
    hint?: string
    /** 装饰性图标插槽（建议 24px 内的 svg / *Icon 组件） */
    icon?: ReactNode
    /** 操作区插槽（按钮等） */
    action?: ReactNode
}

/**
 * 空态占位：图标 + 标题 + 提示 + 可选操作。
 *
 * 纯展示组件，不接管数据与加载语义（三态由 AsyncBoundary 负责）。
 */
export function EmptyState({title, hint, icon, action}: EmptyStateProps) {
    return (
        <div
            className="flex flex-col items-center justify-center gap-[var(--space-snug)] px-4 py-8 text-center"
            data-name="empty-state"
        >
            {icon && (
                <div className="flex items-center justify-center text-[var(--text-secondary)]" data-name="empty-state-icon">
                    {icon}
                </div>
            )}
            <div className="text-sm font-medium text-[var(--text-secondary)]">{title}</div>
            {hint && <div className="max-w-[42ch] text-xs leading-relaxed text-[var(--text-secondary)]">{hint}</div>}
            {action && <div className="mt-1 flex items-center gap-[var(--space-snug)]">{action}</div>}
        </div>
    )
}
