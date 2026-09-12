// `.*` / `Cc` / `Co` / `Filter` 这类开关（spec §4 / §9.2）
import React from 'react'

export interface ToggleChipProps {
  label: string
  active: boolean
  onToggle: () => void
  title?: string
}

export function ToggleChip({label, active, onToggle, title}: ToggleChipProps) {
  return (
    <button
      type="button"
      className={active ? 'pm-toggle-chip is-active' : 'pm-toggle-chip'}
      aria-pressed={active}
      title={title}
      onClick={onToggle}
    >
      {label}
    </button>
  )
}
