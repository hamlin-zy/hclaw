// 折叠箭头 + 标题 + 计数 + 右侧动作区（spec §4 / §5.4）
// 复用 common/TreeNode 的 TreeChevron——它只是一枚 11px 箭头，无单行/配色问题（spec §4.1）。
import React from 'react'
import {TreeChevron} from '../../components/common/TreeNode'

interface PanelHeaderProps {
  title: string
  /** 右侧计数（如文件数）；不传则不渲染 */
  count?: number
  /** 传入 expanded + onToggle 即为可折叠 */
  expanded?: boolean
  onToggle?: () => void
  actions?: React.ReactNode
  testId?: string
  /**
   * 面板换序起手（拖动标题栏空白区）。仅在传了它时才挂监听、才加 `is-pane-drag-source`
   * （`cursor: grab`），因此不接线时 DOM 与类名与改造前逐字节一致。
   * 点击落在 `.pm-panel-header-actions`（5+1 个 IconButton）内时**不**起手。
   */
  onHeaderMouseDown?: (e: React.MouseEvent) => void
}

export function PanelHeader({title, count, expanded, onToggle, actions, testId, onHeaderMouseDown}: PanelHeaderProps) {
  const collapsible = typeof expanded === 'boolean' && typeof onToggle === 'function'
  const dragSource = typeof onHeaderMouseDown === 'function'

  const onRootMouseDown = dragSource
    ? (e: React.MouseEvent) => {
      // 动作区（IconButton）自有的点击语义完全不受影响
      if (e.target instanceof Element && e.target.closest('.pm-panel-header-actions')) return
      onHeaderMouseDown(e)
    }
    : undefined

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onToggle?.()
    }
  }

  return (
    <div
      className={dragSource ? 'pm-panel-header is-pane-drag-source' : 'pm-panel-header'}
      data-testid={testId}
      onMouseDown={onRootMouseDown}
    >
      <div
        className={collapsible ? 'pm-panel-header-main is-collapsible' : 'pm-panel-header-main'}
        role={collapsible ? 'button' : undefined}
        // 显式可访问名：否则它会由「chevron label + title + count」拼成（如「折叠 Git 52」），
        // 精确名查询在有 count 时失效。只在确实有 role=button 时给（generic div 不允许 aria-label）。
        aria-label={collapsible ? title : undefined}
        tabIndex={collapsible ? 0 : undefined}
        aria-expanded={collapsible ? expanded : undefined}
        onClick={collapsible ? onToggle : undefined}
        onKeyDown={collapsible ? onKeyDown : undefined}
      >
        {collapsible && (
          // TreeChevron 的点击处理器自带 stopPropagation，必须显式回调否则点了没反应
          <TreeChevron expanded={expanded} onClick={() => onToggle?.()} />
        )}
        <span className="pm-panel-header-title">{title}</span>
        {count !== undefined && <span className="pm-panel-header-count">{count}</span>}
      </div>
      {actions != null && <div className="pm-panel-header-actions">{actions}</div>}
    </div>
  )
}
