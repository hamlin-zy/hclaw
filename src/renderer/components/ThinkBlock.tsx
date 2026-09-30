import {memo, useState} from 'react'
import type {ThinkBlock as ThinkBlockType} from '@shared/types'
import {useAgentStore} from '../stores/agentStore'
import {useThemeStore} from '../stores/themeStore'
import {isCompactMode, type DisplayMode} from '../lib/displayMode'
import CollapsibleSection from './common/CollapsibleSection'
import MarkdownRenderer from './message-list/MarkdownRenderer'

/** 思考中的脉冲小圆点指示器 */
const ThinkingDot = memo(() => (
    <div className="w-2 h-2 rounded-full bg-[var(--brand-primary)]" aria-label="正在思考"/>
))

const ThinkBlock = memo(function ThinkBlock({thinkBlock}: {thinkBlock: ThinkBlockType}) {
    // 显示模式即折叠默认态：详细展开、简洁/极简折叠
    const displayMode = useAgentStore((s) => s.messageDisplayMode)
    const theme = useThemeStore((s) => s.theme)
    const isCompact = isCompactMode(displayMode)
    const isThinking = thinkBlock.status === 'thinking'
    const isEmptyThinking = isThinking && !thinkBlock.content

    // ★ 展开态必须跟随显示模式切换（受控）：
    //   CollapsibleSection 的 defaultExpanded 只在挂载时消费一次，仅靠它无法响应切换。
    //   规则：显示模式是唯一权威 —— 挂载初值与模式切换一律取该模式默认值
    //   （详细展开 / 紧凑折叠，含流式中与用户手动展开的块）；
    //   模式未变时用户手动切换生效，其它重渲染（含思考内容增量、思考中→完成）不得改写。
    //   渲染期 setState 是 React 官方推荐的“随 prop 调整 state”写法：同一次渲染内生效，无额外帧闪烁。
    const [expansion, setExpansion] = useState<{mode: DisplayMode; expanded: boolean}>(() => ({
        mode: displayMode,
        expanded: !isCompact,
    }))
    if (expansion.mode !== displayMode) {
        setExpansion({mode: displayMode, expanded: !isCompact})
    }
    const expanded = expansion.mode === displayMode ? expansion.expanded : !isCompact

    return (
        <CollapsibleSection
            title="思考过程"
            expanded={expanded}
            onToggle={(next) => setExpansion({mode: displayMode, expanded: next})}
            headerContent={
                isThinking
                    ? <ThinkingDot/>
                    : <span className="text-2xs text-[var(--success)]">完成</span>
            }
            ariaLabel="思考过程"
        >
            <div
                className="mt-[var(--space-snug)] pl-[var(--space-relaxed)] border-l-2 border-[var(--border-emphasis)] bg-[var(--brand-muted)] rounded-r-lg p-[var(--space-relaxed)]">
                {isEmptyThinking ? (
                    <div className="flex items-center gap-[var(--space-snug)] text-xs text-[var(--text-brand)]">
                        <ThinkingDot/>
                        正在思考...
                    </div>
                ) : (
                    // 思考内容与正文同源（LLM 输出），统一走 MarkdownRenderer 解析；
                    // 外层 font-mono + text-xs 保留原思考块的等宽小字外观。
                    // 与弹窗侧 CombinedCardPopup.ThinkBlockInPopup 的渲染方式对齐。
                    <div className="font-mono text-xs leading-relaxed">
                        <MarkdownRenderer isUser={false} theme={theme}>{thinkBlock.content}</MarkdownRenderer>
                    </div>
                )}
            </div>
        </CollapsibleSection>
    )
})

export default ThinkBlock
