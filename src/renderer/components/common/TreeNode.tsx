// 共享 TreeNode / TreeChevron 组件
// 设计目标：IDEA 风格（左细竖条 + 淡色高亮底 + 独立可点 chevron）
// 语义分离：整行点击 = 选中；chevron 点击 = 展开/折叠；双击 = 打开（可选）
//
// 说明：为了避免嵌套 <button>（HTML 规范禁止，会造成 hydration 错误并让外层 button
// 在无障碍树中被隐藏），TreeChevron 使用 <span role="button"> + stopPropagation
// 承载点击；整行由 <button type="button"> 承担键盘激活（role="treeitem"）。
import React, {memo} from 'react'

interface TreeChevronProps {
  /** 展开态：展开时箭头向下，折叠时向右 */
  expanded?: boolean
  /** SVG 尺寸（px），默认 12 */
  size?: number
  /** 为 false 时渲染空占位 span（保持左右行名字左对齐） */
  hasChildren?: boolean
  /** chevron 点击回调（stopPropagation，不冒泡到行） */
  onClick?: (e: React.MouseEvent) => void
  className?: string
}

/**
 * 独立可点击的展开/折叠指示器。
 * 使用 <span role="button"> + stopPropagation 承载点击；tabIndex=-1 避免抢占行按钮焦点。
 * hasChildren=false 时渲染同宽的空占位 span，保证同级行的名字左对齐。
 */
export function TreeChevron({
  expanded = false,
  size = 12,
  hasChildren = true,
  onClick,
  className,
}: TreeChevronProps) {
  if (!hasChildren) {
    return (
      <span
        aria-hidden="true"
        style={{width: size, display: 'inline-block', flexShrink: 0}}
        className={className}
      />
    )
  }
  return (
    <span
      role="button"
      tabIndex={-1}
      aria-label={expanded ? '折叠' : '展开'}
      aria-expanded={expanded}
      onClick={e => {
        e.preventDefault()
        e.stopPropagation()
        // 浏览器的一次双击会派发 click(detail=1) → click(detail=2) → dblclick。
        // 不拦第二跳的话，双击箭头 = 翻转两次（净 0）且中间多渲染一帧 → 视觉"展开又合并"（spec §3.2）。
        if (e.detail > 1) return
        onClick?.(e)
      }}
      onDoubleClick={e => {
        // dblclick 是独立事件，click 上的 stopPropagation 拦不住它；
        // 不拦会冒泡到行、额外触发行级双击语义（spec §3.2）
        e.preventDefault()
        e.stopPropagation()
      }}
      onKeyDown={e => {
        // 键盘交互由外层行 button 承担；此处对 space/enter 直接吞掉，避免冒泡到行触发意外选中
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault()
          e.stopPropagation()
        }
      }}
      style={{
        width: size,
        height: size,
        padding: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--text-muted)',
        flexShrink: 0,
        cursor: 'pointer',
      }}
      className={className}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        aria-hidden="true"
        style={{
          transition: 'transform 0.2s ease',
          transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
        }}
      >
        <polyline points="9 6 15 12 9 18" />
      </svg>
    </span>
  )
}

interface TreeNodeProps {
  /** 节点标签（字符串或自定义 ReactNode，如多行 metadata） */
  label: string | React.ReactNode
  /** 缩进层级，实际 paddingLeft = depth * 14 + 4 */
  depth?: number
  /** 节点图标（emoji 或 SVG），固定 16px 宽以对齐同级 */
  icon?: React.ReactNode
  /** 选中态 */
  selected?: boolean
  /** 展开态（配合 chevron） */
  expanded?: boolean
  /** false 时 chevron 变占位，保持对齐 */
  hasChildren?: boolean
  /** 整行点击 = 选中 */
  onClick?: () => void
  /** chevron 点击 = 展开/折叠 */
  onToggle?: () => void
  onContextMenu?: React.MouseEventHandler<HTMLButtonElement>
  onDoubleClick?: () => void
  /** 传给整行按钮的 aria-label（未提供时用 label 字符串） */
  ariaLabel?: string
  ariaExpanded?: boolean
  /** 行尾追加内容 */
  trailing?: React.ReactNode
  /** 次要样式（opacity 0.7） */
  muted?: boolean
  className?: string
  role?: 'treeitem' | 'none'
  title?: string
}

/**
 * IDEA 风格树节点行。
 * 选中态用 inset box-shadow 模拟左细竖条，避免 border-left 引起内容右移。
 * 整行为 <button type="button"> role="treeitem" 承担键盘访问；
 * TreeChevron 内嵌为 <span role="button"> tabIndex=-1，避免嵌套 button。
 */
export const TreeNode = memo(function TreeNode({
  label,
  depth = 0,
  icon,
  selected = false,
  expanded = false,
  hasChildren = false,
  onClick,
  onToggle,
  onContextMenu,
  onDoubleClick,
  ariaLabel,
  ariaExpanded,
  trailing,
  muted = false,
  className,
  role,
  title,
}: TreeNodeProps) {
  const baseStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '2px 8px 2px ' + (depth * 14 + 4) + 'px',
    cursor: onClick || onDoubleClick ? 'pointer' : 'default',
    fontSize: 13,
    lineHeight: 1.4,
    width: '100%',
    textAlign: 'left',
    border: 0,
    background: 'transparent',
    color: 'inherit',
    boxSizing: 'border-box',
  }
  const selectedStyle: React.CSSProperties = {
    background: 'var(--brand-muted)',
    boxShadow: 'inset 2px 0 0 var(--brand-primary)',
  }
  const mutedStyle: React.CSSProperties = muted ? {opacity: 0.7} : {}
  const aria = ariaLabel
    ?? (typeof label === 'string' ? label : undefined)
  // 未显式提供 ariaExpanded 时，跟随 expanded（仅在 hasChildren 时才有语义）
  const resolvedAriaExpanded = ariaExpanded ?? (hasChildren ? expanded : undefined)

  return (
    <button
      type="button"
      role={role ?? 'treeitem'}
      aria-selected={selected}
      aria-expanded={resolvedAriaExpanded}
      aria-label={aria}
      title={title}
      className={className}
      style={{...baseStyle, ...(selected ? selectedStyle : {}), ...mutedStyle}}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onDoubleClick={onDoubleClick}
    >
      <TreeChevron
        expanded={expanded}
        hasChildren={hasChildren}
        onClick={onToggle ? () => onToggle() : undefined}
      />
      {icon != null && (
        <span
          style={{
            width: 16,
            flexShrink: 0,
            textAlign: 'center',
            display: 'inline-block',
          }}
        >
          {icon}
        </span>
      )}
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
      {trailing != null && (
        <span style={{flexShrink: 0, color: 'var(--text-muted)', fontSize: 11}}>
          {trailing}
        </span>
      )}
    </button>
  )
})
