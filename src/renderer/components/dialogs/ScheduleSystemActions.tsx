/**
 * ScheduleSystemActions — 系统任务行的「还原默认」动作。
 *
 * 系统任务不可删除，只提供「还原默认」：把配置恢复到出厂定义。
 * 确认走**通用确认组件**（ConfirmDialog 的 confirm()，2026-09-19 用户拍板：
 * 取代此前的二次点击确认，与全局危险动作确认交互保持一致）。
 */

import {confirm} from '../ConfirmDialog'

export interface ScheduleSystemActionsProps {
    scheduleId: string
    onRestoreDefault: (id: string) => Promise<void> | void
    /**
     * 禁用态：配置与出厂模板一致（未漂移）时无需还原。
     * 禁用时按钮 disabled + title 提示。
     */
    disabled?: boolean
}

export function ScheduleSystemActions({scheduleId, onRestoreDefault, disabled = false}: ScheduleSystemActionsProps) {
    const handleRestore = async () => {
        if (disabled) return
        const ok = await confirm({
            title: '还原默认',
            message: '确定要将该系统任务的配置还原为出厂默认吗？',
            confirmText: '还原',
            confirmVariant: 'primary',
        })
        if (ok) await onRestoreDefault(scheduleId)
    }
    return (
        <button
            type="button"
            onClick={handleRestore}
            disabled={disabled}
            className={`p-1.5 rounded transition-colors ${disabled ? 'opacity-40 cursor-not-allowed text-[var(--text-muted)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface)]'}`}
            title={disabled ? '配置与默认一致，无需还原' : '还原默认'}
            aria-label="还原默认"
            data-name="schedule-dialog-restore-button">
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                <path d="M3 3v5h5"/>
            </svg>
        </button>
    )
}
