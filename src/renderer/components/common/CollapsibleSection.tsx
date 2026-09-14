import {memo, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode} from 'react'
import {AnimatePresence, motion} from 'framer-motion'
import {collapse} from '../../lib/motionPresets'

interface CollapsibleSectionProps {
  /**
   * 标题文本。
   * 默认按钮模式下渲染为可见标题并作为 aria-label 前缀。
   * 提供 `trigger` 时整体替换默认按钮，本值不再参与渲染，但保留为必填以维持 API 兼容。
   */
  title: string
  /**
   * 标题右侧的自定义内容（状态指示器、计数徽章等）。
   * 仅在默认按钮模式下参与渲染；提供 `trigger` 时被忽略。
   */
  headerContent?: ReactNode
  /** 可折叠的内容区域 */
  children: ReactNode
  /** 初始展开状态，默认 true。仅非受控模式生效 */
  defaultExpanded?: boolean
  /** 外层容器额外类名 */
  className?: string
  /** 按钮额外类名（仅默认按钮模式） */
  buttonClassName?: string
  /** 内容区域额外类名 */
  contentClassName?: string
  /**
   * 展开/折叠回调。
   * 默认按钮模式下：点击按钮时回调 `next`；非受控模式同时更新内部状态。
   * 提供 `trigger` 时不再参与渲染/接线（点击由调用方负责）。
   */
  onToggle?: (expanded: boolean) => void
  /**
   * aria-label 后缀，用于辅助功能，默认使用 title。
   * 仅在默认按钮模式下使用；提供 `trigger` 时被忽略（由调用方自行设置 a11y 属性）。
   */
  ariaLabel?: string
  /**
   * 自定义触发区。
   * 提供时**整体替换**内部默认的标题按钮（含 chevron/title/headerContent），
   * **点击与键盘的接线由调用方负责**（典型做法：受控 `expanded` 配合调用方 toggle 回调，
   * 并自行补 `role="button"` / `tabIndex` / `onKeyDown`），
   * 此时 `onToggle` / `headerContent` / `ariaLabel` 不参与渲染。
   */
  trigger?: ReactNode
  /**
   * 受控展开状态。
   * 提供时组件进入受控模式：忽略内部 state 与 defaultExpanded，展开与否完全由本值决定；
   * 组件仍会通过 `onToggle(!expanded)` 上报切换意图，由调用方回传新值完成闭环。
   * 不提供时保持原有的非受控行为。
   */
  expanded?: boolean
  /**
   * 不追加根节点的默认下边距 `mb-[var(--space-relaxed)]`。
   * 供卡片型调用方使用（卡片自带 overflow-hidden 形成 BFC，避免默认外边距撑高卡片）。
   * 默认 false，即保留默认下边距；对 `trigger` 与非 `trigger` 两种模式一视同仁。
   */
  noMargin?: boolean
}

/**
 * 供 `trigger` 根元素复用的键盘处理。
 * 仅当事件源为绑定元素自身时（`e.target === e.currentTarget`），Enter / Space 触发 toggle；
 * Space 需 preventDefault 以阻止页面滚动。
 * 内层真实 `<button>`（如批量开关）的键盘事件会冒泡至此，但因 target 不等于 currentTarget 而被忽略，
 * 从而避免内层按钮的 Enter/Space 误触发外层折叠。
 */
export function collapsibleTriggerKeyDown(toggle: () => void) {
  return (e: ReactKeyboardEvent) => {
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      toggle()
    }
  }
}

/**
 * 可折叠区块组件
 *
 * 封装了通用的折叠/展开模式：
 * - 带箭头指示器的标题按钮
 * - 箭头旋转动画
 * - AnimatePresence + motion 高度过渡动画
 * - 自定义状态指示器插槽
 */
const CollapsibleSection = memo(function CollapsibleSection({
  title,
  headerContent,
  children,
  defaultExpanded = true,
  className = '',
  buttonClassName = '',
  contentClassName = '',
  onToggle,
  ariaLabel,
  trigger,
  expanded,
  noMargin = false,
}: CollapsibleSectionProps) {
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded)
  const isControlled = expanded !== undefined
  const isExpanded = isControlled ? expanded : internalExpanded

  const warnedRef = useRef(false)
  useEffect(() => {
    if (!import.meta.env.DEV) return
    if (trigger !== undefined && expanded === undefined && !warnedRef.current) {
      warnedRef.current = true
      console.warn(
        '[CollapsibleSection] 提供了 trigger 但未提供 expanded：trigger 会整体替换默认按钮，' +
          '点击/键盘接线需由调用方负责（配合受控 expanded）。此时组件内部 toggle 不会生效，区块将被永久冻结。',
      )
    }
  }, [trigger, expanded])

  const handleToggle = () => {
    const next = !isExpanded
    if (!isControlled) setInternalExpanded(next)
    onToggle?.(next)
  }

  return (
    <div className={`${noMargin ? '' : 'mb-[var(--space-relaxed)] '}${className}`}>
      {trigger !== undefined ? (
        trigger
      ) : (
        <button
          onClick={handleToggle}
          aria-expanded={isExpanded}
          aria-label={`${ariaLabel ?? title} ${isExpanded ? '收起' : '展开'}`}
          className={`flex items-center gap-[var(--space-snug)] text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--brand-primary)_30%,transparent)] dark-all:focus-visible:ring-[color-mix(in_srgb,var(--brand-primary)_20%,transparent)] ${buttonClassName}`}
          data-name="collapsible-section-button">
          <svg
            className={`w-3 h-3 transition-transform duration-200 ease-out ${isExpanded ? 'rotate-90' : ''}`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
          <span className="font-medium">{title}</span>
          {headerContent}
        </button>
      )}

      <AnimatePresence>
        {isExpanded && (
          <motion.div
            {...collapse}
            transition={{duration: 0.2, ease: 'easeInOut'}}
            className={`overflow-hidden ${contentClassName}`}
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
})

export default CollapsibleSection
