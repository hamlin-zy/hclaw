import {memo} from 'react'
import {useConversationStore} from '../stores/conversationStore'
import MessageList from './message-list'
import InputArea from './InputArea'
import LoopWarningBanner from './LoopWarningBanner'
import TurnLimitNotice from './TurnLimitNotice'
import {useAgentStore} from '../stores/agentStore'

interface ConversationPageProps {
    conversationId: string
}

/**
 * 独立的会话页面组件。
 * 每个会话拥有独立的：消息列表、输入框、Agent 运行状态。
 * 通过 `conversationId` prop 绑定到特定会话的数据。
 *
 * ★ 消息列表仅当前激活的会话渲染，非活跃会话不挂载 MessageList 避免性能开销。
 * ★ InputArea 始终挂载，确保切换会话时输入内容和附件不丢失。
 *
 * ★ 使用 React.memo 包裹：当父组件重渲染时，隐藏页面的 conversationId 不变，
 * 从而阻止重渲染级联到隐藏页面的整个子树。
 */
const ConversationPage = memo(function ConversationPage({conversationId}: ConversationPageProps) {
    const isActive = useConversationStore((s) => s.activeConversationId === conversationId)
    const wasRendered = useConversationStore((s) => s.renderedConversationIds.includes(conversationId))
    // 循环检测警告条：仅该会话存在 loopWarning 时渲染（InputArea 上方）
    const hasLoopWarning = useAgentStore((s) => !!s.convAgentStates[conversationId]?.loopWarning)
    // 轮数上限截断提示条：仅该会话存在 turnLimitNotice 时渲染（LoopWarningBanner 同级）
    const hasTurnLimitNotice = useAgentStore((s) => !!s.convAgentStates[conversationId]?.turnLimitNotice)

    return (
        <>
            {/* 消息列表卡片 — 仅已渲染的会话挂载（激活时渲染，切走后保留 10 分钟） */}
            {(isActive || wasRendered) && (
                <div
                    data-name="message-list-card"
                    className="app-surface-card relative flex-1 bg-[var(--surface)] rounded-xl shadow-sm overflow-hidden flex flex-col min-h-0">
                    <MessageList conversationId={conversationId}/>
                </div>
            )}

            {/* 循环检测警告条 — 仅存在未消除的 loopWarning 时渲染 */}
            {hasLoopWarning && <LoopWarningBanner conversationId={conversationId}/>}

            {/* 轮数上限截断提示条 — 运行结束后留存，直到下一 run 开始或用户关闭 */}
            {hasTurnLimitNotice && <TurnLimitNotice conversationId={conversationId}/>}

            {/* 输入框卡片 — 始终挂载，保持输入状态 */}
            <div
                data-name="input-area-card"
                className="app-surface-card shrink-0 bg-[var(--card-elevated)] border border-[var(--border-emphasis)] rounded-t-[28px] rounded-b-[12px] shadow-[var(--shadow-elevated)] transition-all duration-200 overflow-hidden mx-[20px]">
                <InputArea isActive={isActive}/>
            </div>
        </>
    )
})

export default ConversationPage
