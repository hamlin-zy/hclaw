/**
 * schedulePanelShell — 行内「执行记录」面板的共用外壳与失败态（组件层收敛）
 *
 * ScheduleConversationsPanel（能力类任务）与 ScheduleScriptLogPanel（脚本类任务）原先各写一份
 * 近乎逐字的 `ErrorBox` / `PanelShell` / `Loadable<T>` / `API_UNAVAILABLE`。收敛到此处后，
 * 两个面板只保留各自的差异：`data-name`、可访问名与文案前缀 —— 三者全部由调用方传入，
 * 本文件不设默认值（默认值等于把差异静默抹平）。
 *
 * 三个重试按钮的 `data-name` 是测试与排障的锚点，收敛后必须逐一原样保留：
 * schedule-dialog-records-retry-button / schedule-dialog-script-logs-retry-button /
 * schedule-dialog-script-log-retry-button。
 */
import type {ReactNode} from 'react'

/** 桥接缺失与后端失败统一的失败文案口径 */
export const API_UNAVAILABLE = 'scheduler API 不可用'

export type Loadable<T> =
    | {status: 'loading'}
    | {status: 'error'; error: string}
    | {status: 'ready'; data: T}

/**
 * 行内面板外壳。
 *
 * 圆角取**面板档** `rounded-xl`（契约 D5）：面板与浮层须 12px 及以上，`rounded-md`(6px)
 * 只留给徽标与输入控件。取 12px 而非更大，是因为本面板嵌在列表行内（`mx-1`），
 * 与外层行的 `rounded-md` 只差一档，视觉上仍属同一嵌套层级，不会顶破行内包裹。
 *
 * 标题文案由调用方参数化（「执行记录」/「脚本执行记录」）；结构与
 * `aria-live="polite"` 由本外壳统一承担，调用方不再重复声明。
 */
export function PanelShell({title, children}: { title: string; children: ReactNode }) {
    return (
        <div
            className="mx-1 mb-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden"
            aria-live="polite">
            <div className="px-3 py-2 border-b border-[var(--border-muted)]">
                <span className="text-2xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
                    {title}
                </span>
            </div>
            {children}
        </div>
    )
}

/**
 * 失败态：可读原因 + 重试入口（与「一条记录都没有」完全不同的措辞与样式）。
 *
 * `message` 是**完整**失败文案，前缀由调用方拼（能力类为 `执行记录加载失败：{error}`，
 * 脚本类为 `{error}`）；`retryLabel` 是重试按钮的可访问名（两处措辞不同）；
 * `retryName` 是 `data-name`（三个站点各不相同）。
 */
export function ErrorBox({message, onRetry, retryName, retryLabel}: {
    message: string
    onRetry: () => void
    retryName: string
    retryLabel: string
}) {
    return (
        <div className="p-4">
            <div className="rounded-md border border-[var(--error)] bg-[var(--error-muted)] px-3 py-2">
                <div className="text-xs text-[var(--text-primary)]">{message}</div>
                <button
                    type="button"
                    onClick={onRetry}
                    className="mt-2 px-2.5 py-1 text-xs rounded-md border border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                    aria-label={retryLabel}
                    data-name={retryName}>
                    重试
                </button>
            </div>
        </div>
    )
}
