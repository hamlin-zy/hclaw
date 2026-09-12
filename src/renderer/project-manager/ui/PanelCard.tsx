// 圆角卡片容器（spec §2.3）：面板浮在画布上，而非 IDEA 那样无圆角填满窗格。
import React from 'react'
import clsx from 'clsx'

export interface PanelCardProps {
  children: React.ReactNode
  className?: string
  testId?: string
}

export function PanelCard({children, className, testId}: PanelCardProps) {
  return (
    <section className={clsx('pm-panel-card', className)} data-testid={testId}>
      {children}
    </section>
  )
}
