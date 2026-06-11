/**
 * 工具调用状态配置
 *
 * 包含两组样式定义：
 * - full（完整版）：用于 ToolCallRenderer（含 bg, glowClass）
 * - compact（简约版）：用于 CompactToolPopup（含 badgeClass）
 *
 * 统一数据源，避免重复维护。
 */

/** 单个状态样式配置 */
interface StatusStyle {
    color: string
    bg: string
    icon: string
    label: string
    glowClass: string
    badgeClass: string
}

/** 状态配置类型 */
type StatusConfig = Record<string, StatusStyle>

/** 完整状态配置（含所有字段） */
const STATUS_STYLES: StatusConfig = {
    pending: {
        color: 'text-[var(--text-muted)]',
        bg: 'bg-[var(--surface-elevated)]/50 border border-[rgba(255,255,255,0.04)]',
        icon: '●',
        label: '待执行',
        glowClass: '',
        badgeClass: 'bg-[var(--surface-elevated)]/50 text-[var(--text-muted)]',
    },
    running: {
        color: 'text-[var(--info)]',
        bg: 'bg-[var(--info-muted)]/30 border border-[rgba(91,141,217,0.25)]',
        icon: '●',
        label: '执行中',
        glowClass: 'ring-2 ring-[var(--info)]/20 ring-offset-1 ring-offset-[var(--surface)]',
        badgeClass: 'bg-[var(--info-muted)]/30 text-[var(--info)]',
    },
    success: {
        color: 'text-[var(--success)]',
        bg: 'bg-[var(--success-muted)]/30 border border-[rgba(16,185,129,0.2)]',
        icon: '✔',
        label: '成功',
        glowClass: '',
        badgeClass: 'bg-[var(--success-muted)]/30 text-[var(--success)]',
    },
    error: {
        color: 'text-[var(--error)]',
        bg: 'bg-[var(--error-muted)]/30 border border-[rgba(196,92,92,0.2)]',
        icon: '✗',
        label: '失败',
        glowClass: '',
        badgeClass: 'bg-[var(--error-muted)]/30 text-[var(--error)]',
    },
    cancelled: {
        color: 'text-[var(--text-muted)]',
        bg: 'bg-[var(--surface-elevated)]/40 border border-[rgba(255,255,255,0.08)]',
        icon: '■',
        label: '已取消',
        glowClass: '',
        badgeClass: 'bg-[var(--surface-elevated)]/40 text-[var(--text-muted)]',
    },
}

/** 完整版（含 bg, glowClass）— 用于 ToolCallRenderer */
export function getFullStatusConfig(status: string) {
    return STATUS_STYLES[status] || STATUS_STYLES.pending
}

/** 简约版（含 badgeClass）— 用于 CompactToolPopup */
export function getCompactStatusConfig(status: string) {
    const s = STATUS_STYLES[status] || STATUS_STYLES.pending
    return {
        color: s.color,
        icon: s.icon,
        badgeClass: s.badgeClass,
        label: s.label,
    }
}

export type {StatusStyle}
