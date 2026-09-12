// 通用树行（spec §4 / §6.5 / §13.1）。
//
// ⚠️ aria / DOM 契约必须与 common/TreeNode 保持一致——现有渲染层测试大量使用
// getByRole('treeitem', {name}) 与 row.querySelector('[role="button"]')：
//   行元素 = <button type="button" role="treeitem" aria-selected aria-expanded aria-label>
//   chevron = <span role="button" tabIndex={-1}>（由 TreeChevron 提供）
// 降级任何一条都会连带打挂 FileTree / gitLogPanel / GitStatusPanel 的测试。
import React from 'react'
import {TreeChevron} from '../../components/common/TreeNode'

export interface TreeRowProps {
  /** 行内容（名称） */
  label: React.ReactNode
  /** 缩进层级：0 → 8px，n → n*13px（spec §13.3） */
  depth: number
  /** 行首图标（13px，颜色由调用方决定） */
  icon?: React.ReactNode
  selected?: boolean
  expanded?: boolean
  hasChildren?: boolean
  onClick?: (e: React.MouseEvent) => void
  /** chevron 点击 = 展开/折叠（与行点击语义分离） */
  onToggle?: () => void
  onContextMenu?: React.MouseEventHandler<HTMLButtonElement>
  onDoubleClick?: () => void
  ariaLabel?: string
  ariaExpanded?: boolean
  title?: string
  /** 行尾固定列（状态字母列、计数等） */
  trailing?: React.ReactNode
  className?: string
  /** 条目路径（POSIX 相对路径）；渲染为 data-path 供 reveal 的 DOM 定位使用（spec §3.1） */
  path?: string
}

export function TreeRow({
  label, depth, icon, selected = false, expanded = false, hasChildren = false,
  onClick, onToggle, onContextMenu, onDoubleClick,
  ariaLabel, ariaExpanded, title, trailing, className, path,
}: TreeRowProps) {
  // 与 common/TreeNode 同源的名称回退：未显式给 ariaLabel 时用字符串 label
  const aria = ariaLabel ?? (typeof label === 'string' ? label : undefined)
  const resolvedAriaExpanded = ariaExpanded ?? (hasChildren ? expanded : undefined)
  const classes = ['pm-tree-row']
  if (selected) classes.push('is-selected')
  if (className) classes.push(className)

  return (
    <button
      type="button"
      role="treeitem"
      aria-selected={selected}
      aria-expanded={resolvedAriaExpanded}
      aria-label={aria}
      title={title}
      data-path={path}
      className={classes.join(' ')}
      style={{paddingLeft: depth === 0 ? 8 : depth * 13}}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onDoubleClick={onDoubleClick}
    >
      <TreeChevron expanded={expanded} hasChildren={hasChildren} onClick={onToggle ? () => onToggle() : undefined} />
      {icon != null && <span className="pm-tree-row-icon">{icon}</span>}
      <span className="pm-tree-row-name">{label}</span>
      {trailing != null && <span className="pm-tree-row-trailing">{trailing}</span>}
    </button>
  )
}
