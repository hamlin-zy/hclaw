import {memo} from 'react'
import type {ThinkBlock as ThinkBlockType} from '@shared/types'
import {useAgentStore} from '../stores/agentStore'
import {isCompactMode} from '../lib/displayMode'
import CollapsibleSection from './common/CollapsibleSection'

/** 思考中的脉冲小圆点指示器 */
const ThinkingDot = memo(() => (
    <div className="w-2 h-2 rounded-full bg-[var(--brand-primary)]" aria-label="正在思考"/>
))

const ThinkBlock = memo(function ThinkBlock({thinkBlock, defaultExpanded}: {
    thinkBlock: ThinkBlockType;
    defaultExpanded?: boolean
}) {
    // 精简/紧凑模式下默认折叠（除非调用方显式指定展开）
    const displayMode = useAgentStore((s) => s.messageDisplayMode)
    const isCompact = isCompactMode(displayMode)
    const isThinking = thinkBlock.status === 'thinking'
    const isEmptyThinking = isThinking && !thinkBlock.content

    return (
        <CollapsibleSection
            title="思考过程"
            defaultExpanded={defaultExpanded ?? !isCompact}
            headerContent={
                isThinking
                    ? <ThinkingDot/>
                    : <span className="text-2xs text-[var(--success)]">完成</span>
            }
            ariaLabel="思考过程"
        >
            <div
                className="mt-[var(--space-snug)] pl-[var(--space-relaxed)] border-l-2 border-[var(--border-emphasis)] bg-[var(--brand-muted)]/30 rounded-r-lg p-[var(--space-relaxed)]">
                {isEmptyThinking ? (
                    <div className="flex items-center gap-[var(--space-snug)] text-xs text-[var(--brand-primary)]">
                        <ThinkingDot/>
                        正在思考...
                    </div>
                ) : (
                    <pre
                        className="text-xs text-[var(--text-secondary)] whitespace-pre-wrap font-mono leading-relaxed">{thinkBlock.content}</pre>
                )}
            </div>
        </CollapsibleSection>
    )
})

export default ThinkBlock
