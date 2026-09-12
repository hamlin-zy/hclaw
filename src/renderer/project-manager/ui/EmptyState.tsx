// 空态（spec §13.5）：居中 + --text-muted + 可选图标
import React from 'react'
import type {LucideIcon} from 'lucide-react'

export interface EmptyStateProps {
  text: string
  icon?: LucideIcon
  testId?: string
}

export function EmptyState({text, icon: Icon, testId}: EmptyStateProps) {
  return (
    <div className="pm-empty-state" data-testid={testId}>
      {Icon && <Icon className="pm-empty-state-icon" size={18} aria-hidden="true" />}
      <span>{text}</span>
    </div>
  )
}
