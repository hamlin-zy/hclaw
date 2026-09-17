/**
 * ScheduleListStates — 定时任务列表区「加载中 / 加载失败 / 空」三态的展示（ui-03）
 *
 * 三态齐备，禁止静默失败：加载中有明确呈现；加载失败给出可点的重试入口，而不是
 * 被当成「我没有任务」；「空」分两义 —— 真的一条都没有（给出本窗口用途说明 + 显眼
 * 的主按钮）与筛选后无结果（给出针对当前筛选的文案 + 清除筛选的动作）。
 *
 * 文案不指向空间位置（不出现「点击上方」这类指路语），动作一律是原生 button，
 * 从而天然可被 Tab 触达、可被回车/空格触发。
 *
 * 纯展示组件：不持有数据，不给状态着色（配色只用文字级/品牌令牌）。
 */

export interface ScheduleListErrorProps {
    /** 内核返回的可读错误（或桥接缺失的位置说明） */
    error: string
    onRetry: () => void
}

/** 加载中：转圈 + 文案，避免一片空白 */
export function ScheduleListLoading() {
    return (
        <div className="p-8 text-center" role="status" data-name="schedule-dialog-loading">
            <div
                className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-[var(--brand-primary)] border-t-transparent"
                aria-hidden="true"
            />
            <div className="mt-2 text-xs text-[var(--text-secondary)]">加载中...</div>
        </div>
    )
}

/** 加载失败：说明失败 + 重试入口 */
export function ScheduleListError({error, onRetry}: ScheduleListErrorProps) {
    return (
        <div className="p-8 text-center" role="alert" data-name="schedule-dialog-error">
            <div className="text-xs font-medium text-[var(--text-danger)]">定时任务加载失败</div>
            <div className="mx-auto mt-1 max-w-[42ch] break-words text-xs leading-relaxed text-[var(--text-secondary)]">
                {error}
            </div>
            <button
                type="button"
                /* 显式无参调用：直接 `onClick={onRetry}` 会把 React 合成事件当第一个实参传进去，
                   重试是否「非静默」就变成了取决于事件对象恰好没有 `silent` 属性的巧合。 */
                onClick={() => onRetry()}
                data-name="schedule-dialog-retry-button"
                className="mt-3 inline-flex items-center rounded-md border border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)]"
            >
                重试
            </button>
        </div>
    )
}

export interface ScheduleEmptyStateProps {
    title: string
    hint?: string
    actionLabel: string
    /** 交互元素的 data-name（命名体例与列表其它按钮一致） */
    actionName: string
    onAction: () => void
    /** primary = 品牌实底主按钮（真无任务时的「新建」），ghost = 文字按钮（清除筛选） */
    variant?: 'primary' | 'ghost'
}

const ACTION_CLASS: Record<'primary' | 'ghost', string> = {
    primary: 'mt-1 inline-flex items-center rounded-md bg-[var(--brand-primary)] px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-[var(--brand-hover)]',
    ghost: 'mt-1 inline-flex items-center rounded-md border border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-muted)]',
}

/** 空态：说明 + 一个显眼的动作 */
export function ScheduleEmptyState({
    title,
    hint,
    actionLabel,
    actionName,
    onAction,
    variant = 'primary',
}: ScheduleEmptyStateProps) {
    return (
        <div
            className="flex flex-col items-center justify-center gap-[var(--space-snug)] px-4 py-10 text-center"
            data-name="schedule-dialog-empty"
        >
            <div className="text-sm font-medium text-[var(--text-primary)]">{title}</div>
            {hint && (
                <div className="max-w-[42ch] text-xs leading-relaxed text-[var(--text-secondary)]">{hint}</div>
            )}
            <button
                type="button"
                onClick={onAction}
                data-name={actionName}
                className={ACTION_CLASS[variant]}
            >
                {actionLabel}
            </button>
        </div>
    )
}
