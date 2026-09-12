// 行尾状态字母列（spec §3.1 三重编码的第 2 重）。
// 字母 + 颜色 + 字重/样式三管齐下，色盲用户靠字母与样式也能分辨。
import React from 'react'
import {STATUS_SPEC, statusClassSuffix, type VcsStatus} from '../lib/statusColor'

export interface StatusBadgeProps {
  status: VcsStatus
}

export function StatusBadge({status}: StatusBadgeProps) {
  const spec = STATUS_SPEC[status]
  return (
    <span
      data-testid="status-badge"
      className={`pm-status-badge pm-c--${statusClassSuffix(status)}`}
      aria-label={spec.ariaLabel || undefined}
    >
      {spec.letter}
    </span>
  )
}
