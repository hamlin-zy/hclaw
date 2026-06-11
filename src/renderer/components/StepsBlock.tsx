import {memo, useState} from 'react'
import {AnimatePresence, motion} from 'framer-motion'
import type {StepNode, StepsBlock as StepsBlockType} from '@shared/types'
import {useAgentStore} from '../stores/agentStore'
import {isUltraCompactMode} from '../lib/displayMode'
import CollapsibleSection from './common/CollapsibleSection'

/** 递归渲染最大深度，防止栈溢出 */
const MAX_DEPTH = 20

const StatusIcon = memo(function StatusIcon({status}: { status: StepNode['status'] }) {
    switch (status) {
        case 'success':
            return (
                <svg
                    className="w-3 h-3 text-[var(--success)]"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    aria-hidden="true"
                >
                    <polyline points="20 6 9 17 4 12"/>
                </svg>
            )
        case 'running':
            return <div className="w-3 h-3 rounded-full border-2 border-[var(--info)] border-t-transparent animate-spin"
                        aria-label="正在执行"/>
        case 'error':
            return (
                <svg
                    className="w-3 h-3 text-[var(--error)]"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    aria-hidden="true"
                >
                    <line x1="18" y1="6" x2="6" y2="18"/>
                    <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
            )
        default:
            return <div className="w-3 h-3 rounded-full border border-[var(--border)]" aria-hidden="true"/>
    }
})

const StepItem = memo(function StepItem({step, depth, index}: { step: StepNode; depth: number; index: number }) {
    return (
        <motion.div
            initial={{opacity: 0, x: -10}}
            animate={{opacity: 1, x: 0}}
            transition={{delay: index * 0.03, duration: 0.2, ease: 'easeOut'}}
        >
            <div
                className={`flex items-center gap-[var(--space-snug)] px-[var(--space-relaxed)] py-1 rounded text-xs ${
                    step.status === 'running' ? 'bg-[var(--info)]/10 text-[var(--info)]'
                        : step.status === 'success' ? 'text-[var(--success)]'
                            : step.status === 'error' ? 'bg-[var(--error)]/10 text-[var(--error)]'
                                : 'text-[var(--text-muted)]'
                }`}
                style={{paddingLeft: `${depth * 16 + 8}px`}}
            >
                <StatusIcon status={step.status}/>
                <span className="flex-1 truncate">{step.name}</span>
                {step.duration && <span className="text-2xs opacity-50">{step.duration}ms</span>}
            </div>
            {depth < MAX_DEPTH && step.children?.map((child, i) => (
                <StepItem key={child.id} step={child} depth={depth + 1} index={i}/>
            ))}
        </motion.div>
    )
})

const StepsBlock = memo(function StepsBlock({stepsBlock}: { stepsBlock: StepsBlockType }) {
  const displayMode = useAgentStore((s) => s.messageDisplayMode)
  // 紧凑模式下默认折叠 + 单行显示
  const isUltraCompact = isUltraCompactMode(displayMode)
  const [isUltraExpanded, setIsUltraExpanded] = useState(false)

  // 紧凑模式：单行 + 计数
  if (isUltraCompact) {
    return (
      <div className="mb-[var(--space-relaxed)]">
        <button
          onClick={() => setIsUltraExpanded(!isUltraExpanded)}
          aria-expanded={isUltraExpanded}
          className="flex items-center gap-[var(--space-snug)] text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
        >
          <svg
            className={`w-2.5 h-2.5 transition-transform duration-200 ${isUltraExpanded ? 'rotate-90' : ''}`}
            viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
          <span className="font-medium">执行步骤</span>
          <span className="px-1.5 py-0.5 rounded text-2xs bg-[var(--success)]/10 text-[var(--success)] font-medium">
            {stepsBlock.completedCount}/{stepsBlock.totalCount}
          </span>
        </button>

        <AnimatePresence>
          {isUltraExpanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{duration: 0.2, ease: 'easeInOut'}}
              className="overflow-hidden"
            >
              <div className="mt-[var(--space-snug)] space-y-[var(--space-tight)]">
                {stepsBlock.steps.map((step, i) => (
                  <StepItem key={step.id} step={step} depth={0} index={i} />
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    )
  }

  // 详细/简洁模式：使用共享 CollapsibleSection
  return (
    <CollapsibleSection
      title="执行步骤"
      headerContent={
        <span className="px-1.5 py-0.5 rounded text-2xs bg-[var(--success)]/10 text-[var(--success)] font-medium">
          {stepsBlock.completedCount}/{stepsBlock.totalCount}
        </span>
      }
      ariaLabel="执行步骤"
    >
      <div className="mt-[var(--space-snug)] space-y-[var(--space-tight)]">
        {stepsBlock.steps.map((step, i) => (
          <StepItem key={step.id} step={step} depth={0} index={i} />
        ))}
      </div>
    </CollapsibleSection>
  )
})

export default StepsBlock
