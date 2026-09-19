/**
 * ScheduleDisableConfirm — 禁用系统任务的确认对话框（本票新增）。
 *
 * 禁用「记忆沉淀」这类系统任务会**同步关闭记忆功能**（会话中不再注入用户习惯记忆），
 * 影响面超出这一行本身，故在禁用前给一次显式确认。文案同时说明两点边界：
 * 已积累的记忆文件不会被删除；重新启用任务不会自动恢复记忆开关。
 */

export interface ScheduleDisableConfirmProps {
    open: boolean
    onConfirm: () => void
    onCancel: () => void
}

export function ScheduleDisableConfirm({open, onConfirm, onCancel}: ScheduleDisableConfirmProps) {
    if (!open) return null
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onCancel}>
            <div className="bg-[var(--surface)] rounded-lg p-6 max-w-sm mx-4" onClick={e => e.stopPropagation()}>
                <p className="text-sm text-[var(--text-primary)] mb-4">
                    关闭「记忆沉淀」任务将同步关闭记忆功能（会话中不再注入用户习惯记忆）。
                    已积累的记忆文件不会被删除，重新启用后可继续使用。
                    是否继续？
                </p>
                <div className="flex justify-end gap-2">
                    <button
                        type="button"
                        onClick={onCancel}
                        className="px-3 py-1.5 text-xs rounded-md text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]"
                        data-name="schedule-disable-confirm-cancel">
                        取消
                    </button>
                    <button
                        type="button"
                        onClick={onConfirm}
                        className="px-3 py-1.5 text-xs rounded-md bg-[var(--error)] text-white hover:opacity-90"
                        data-name="schedule-disable-confirm-ok">
                        确认关闭
                    </button>
                </div>
            </div>
        </div>
    )
}
