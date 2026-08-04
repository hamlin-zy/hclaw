/**
 * ToolCountdown — 工具调用执行倒计时徽章
 *
 * 展示在运行中的工具卡片上（详细模式 / 简洁模式头部、紧凑模式概要行、Popup 卡片），
 * 依据 timeoutMs + startedAt 每秒刷新。无超时信息或已结束时返回 null。
 */

import {memo} from 'react'
import {useToolCountdown} from '../../hooks/useToolCountdown'

interface ToolCountdownProps {
    timeoutMs?: number
    startedAt?: number
    /** 变体：默认徽章 / 更小号（紧凑概要行用） */
    size?: 'sm' | 'xs'
}

export const ToolCountdown = memo(function ToolCountdown({
    timeoutMs,
    startedAt,
    size = 'sm',
}: ToolCountdownProps) {
    const cd = useToolCountdown(timeoutMs, startedAt)
    if (!cd) return null

    const base = size === 'sm'
        ? 'text-[10px] px-1.5 py-0.5 rounded-full shrink-0 font-mono tabular-nums'
        : 'text-[9px] px-1 py-0.5 rounded shrink-0 font-mono tabular-nums'

    const style = cd.urgent
        ? 'bg-[var(--error-muted)]/30 text-[var(--error)] border border-[rgba(239,68,68,0.25)]'
        : 'bg-[var(--surface-muted)] text-[var(--text-muted)] border border-[var(--border-muted)]'

    return (
        <span className={`${base} ${style}`} title="工具执行超时倒计时" role="timer">
            {cd.label}
        </span>
    )
})

export default ToolCountdown
