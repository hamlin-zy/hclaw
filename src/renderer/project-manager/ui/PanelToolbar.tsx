import React from 'react'
import clsx from 'clsx'

export interface PanelToolbarProps {
  children: React.ReactNode
  className?: string
  testId?: string
}

export function PanelToolbar({children, className, testId}: PanelToolbarProps) {
  return (
    <div className={clsx('pm-panel-toolbar', className)} data-testid={testId}>
      {children}
    </div>
  )
}
