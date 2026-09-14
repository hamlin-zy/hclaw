import type {ReactNode} from 'react'
import CollapsibleSection from './CollapsibleSection'

export interface CapabilityCardProps {
    title: ReactNode
    subtitle?: ReactNode
    /** 标题右侧徽章插槽（开关、标签、状态点等） */
    badges?: ReactNode
    /** 卡片右上角操作区插槽 */
    actions?: ReactNode
    /** 折叠区上方的描述文本插槽 */
    description?: ReactNode
    /** 为 true 时 children 收进 CollapsibleSection */
    collapsible?: boolean
    /** 折叠区标题（仅 collapsible 时生效） */
    collapseTitle?: string
    defaultExpanded?: boolean
    children?: ReactNode
}

/**
 * 能力卡片骨架：标题 / 副标题 / 徽章 / 操作区 / 描述 / 折叠详情。
 *
 * 只抽「骨架 + 插槽」，不含任何能力字段语义（类型、来源、启用态等一律由调用方
 * 通过 badges / actions / description 传入），避免退化成适配所有页面的神组件。
 */
export function CapabilityCard({
    title,
    subtitle,
    badges,
    actions,
    description,
    collapsible = false,
    collapseTitle = '详情',
    defaultExpanded = true,
    children,
}: CapabilityCardProps) {
    return (
        <div
            className="rounded-lg border border-[var(--border)] bg-[var(--surface)] transition-colors hover:border-[var(--border-emphasis)]"
            data-name="capability-card"
        >
            <div className="flex items-start gap-[var(--space-snug)] px-[var(--space-normal)] py-[var(--space-snug)]">
                <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-[var(--space-snug)]">
                        <span className="truncate text-sm font-medium text-[var(--text-primary)]">{title}</span>
                        {badges && <span className="flex shrink-0 items-center gap-1">{badges}</span>}
                    </div>
                    {subtitle && <div className="mt-0.5 truncate text-xs text-[var(--text-secondary)]">{subtitle}</div>}
                </div>
                {actions && (
                    <div className="flex shrink-0 items-center gap-1" data-name="capability-card-actions">
                        {actions}
                    </div>
                )}
            </div>

            {description && (
                <div className="px-[var(--space-normal)] pb-[var(--space-snug)] text-xs leading-relaxed text-[var(--text-secondary)]">
                    {description}
                </div>
            )}

            {children &&
                (collapsible ? (
                    <div className="px-[var(--space-normal)]">
                        <CollapsibleSection title={collapseTitle} defaultExpanded={defaultExpanded}>
                            {children}
                        </CollapsibleSection>
                    </div>
                ) : (
                    <div className="px-[var(--space-normal)] pb-[var(--space-snug)]">{children}</div>
                ))}
        </div>
    )
}
