import clsx from 'clsx'

export interface StatusBadgeProps {
    /** 启用状态 */
    enabled: boolean
    /** 启用态文案，缺省「已启用」 */
    enabledLabel?: string
    /** 禁用态文案，缺省「已禁用」 */
    disabledLabel?: string
    /** 追加在徽章容器上的类名 */
    className?: string
}

/**
 * 启用/禁用状态徽章：四管理页统一的状态展示。
 *
 * 样式基准取自 AgentsDialog 预览弹窗；仅复用既有 CSS 变量令牌，不新增 token。
 * 布局（外边距、定位）由调用方通过 className 决定，本组件只负责状态外观。
 */
export function StatusBadge({
    enabled,
    enabledLabel = '已启用',
    disabledLabel = '已禁用',
    className,
}: StatusBadgeProps) {
    return (
        <span
            className={clsx(
                'inline-flex items-center rounded px-2 py-1 text-[10px] font-medium',
                enabled
                    ? 'bg-[var(--tag-dev-bg)] text-[var(--tag-dev-text)] border border-[var(--tag-dev-border)]'
                    : 'bg-[var(--surface-muted)] text-[var(--text-muted)] border border-[var(--border)]',
                className,
            )}
            data-name="status-badge"
        >
            {enabled ? enabledLabel : disabledLabel}
        </span>
    )
}
