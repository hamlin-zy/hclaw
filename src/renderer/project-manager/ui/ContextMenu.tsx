// 统一右键菜单（spec §13.6）：三份复制粘贴的菜单收敛到这一处。
// 注意：三个旧菜单都写了 `var(--bg-secondary, #252526)`——该令牌根本不存在，
// 所有主题都落到 Darcula 灰。本组件用 --surface-elevated，浅色主题下才是浅色。
import React, {useCallback, useEffect, useRef} from 'react'

export interface ContextMenuItem {
  label: string
  onClick?: () => void
  disabled?: boolean
  /** disabled 时的原因提示 */
  reason?: string
  /** 删除类不可逆操作，用危险色渲染 */
  danger?: boolean
}

export interface ContextMenuProps {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}

export function ContextMenu({x, y, items, onClose}: ContextMenuProps) {
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const enabled = itemRefs.current.filter((el): el is HTMLButtonElement => el !== null && !el.disabled)
    if (enabled.length === 0) return
    const index = enabled.indexOf(document.activeElement as HTMLButtonElement)
    const step = e.key === 'ArrowDown' ? 1 : -1
    const base = index === -1 ? (step === 1 ? -1 : 0) : index
    enabled[(base + step + enabled.length) % enabled.length].focus()
  }, [])

  return (
    <>
      <div
        className="pm-context-menu-backdrop"
        onClick={onClose}
        onContextMenu={e => {
          e.preventDefault()
          onClose()
        }}
      />
      <div
        role="menu"
        className="pm-context-menu"
        style={{left: x, top: y}}
        onKeyDown={onKeyDown}
      >
        {items.map((item, index) => (
          <button
            key={`${item.label}-${index}`}
            ref={el => { itemRefs.current[index] = el }}
            type="button"
            role="menuitem"
            className={`pm-context-menu-item${item.danger ? ' pm-context-menu-item--danger' : ''}`}
            disabled={item.disabled}
            title={item.disabled ? item.reason : undefined}
            onClick={() => {
              if (item.disabled) return
              item.onClick?.()
              onClose()
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </>
  )
}
