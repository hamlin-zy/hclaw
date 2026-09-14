// 14px lucide 图标按钮；label 同时作为 aria-label 与 title（spec §13.7）
import React from 'react'
import type {LucideIcon} from 'lucide-react'

export interface IconButtonProps {
  icon: LucideIcon
  label: string
  onClick?: () => void
  /** 传入表示这是开关型按钮，会渲染 aria-pressed 与激活态 */
  pressed?: boolean
  disabled?: boolean
  size?: number
  /** 传入表示这是加载中按钮，图标会持续旋转（.pm-spin） */
  spin?: boolean
}

export function IconButton({icon: Icon, label, onClick, pressed, disabled = false, size = 14, spin}: IconButtonProps) {
  const isToggle = typeof pressed === 'boolean'
  return (
    <button
      type="button"
      className={pressed ? 'pm-icon-btn is-active' : 'pm-icon-btn'}
      aria-label={label}
      aria-pressed={isToggle ? pressed : undefined}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon size={size} aria-hidden="true" className={spin ? 'pm-spin' : undefined} />
    </button>
  )
}
