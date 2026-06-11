import {memo, useState, type ReactNode} from 'react'
import {AnimatePresence, motion} from 'framer-motion'

interface CollapsibleSectionProps {
  /** 标题文本 */
  title: string
  /** 标题右侧的自定义内容（状态指示器、计数徽章等） */
  headerContent?: ReactNode
  /** 可折叠的内容区域 */
  children: ReactNode
  /** 初始展开状态，默认 true */
  defaultExpanded?: boolean
  /** 外层容器额外类名 */
  className?: string
  /** 按钮额外类名 */
  buttonClassName?: string
  /** 内容区域额外类名 */
  contentClassName?: string
  /** 展开/折叠回调 */
  onToggle?: (expanded: boolean) => void
  /** aria-label 后缀，用于辅助功能。默认使用 title */
  ariaLabel?: string
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
}: CollapsibleSectionProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded)

  const handleToggle = () => {
    const next = !isExpanded
    setIsExpanded(next)
    onToggle?.(next)
  }

  return (
    <div className={`mb-[var(--space-relaxed)] ${className}`}>
      <button
        onClick={handleToggle}
        aria-expanded={isExpanded}
        aria-label={`${ariaLabel ?? title} ${isExpanded ? '收起' : '展开'}`}
        className={`flex items-center gap-[var(--space-snug)] text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-primary)]/20 ${buttonClassName}`}
      >
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

      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{height: 0, opacity: 0}}
            animate={{height: 'auto', opacity: 1}}
            exit={{height: 0, opacity: 0}}
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
