import {memo} from 'react'
import {useAgentStore} from '../stores/agentStore'
import {useConversationStore} from '../stores/conversationStore'
import MessageList from './message-list'
import InputArea from './InputArea'
import CompactWarningBanner from './CompactWarningBanner'
import HookResultsBar from './HookResultsBar'

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
    const compactStats = useAgentStore((s) => s.compactStats)
    const clearCompactBanner = useAgentStore((s) => s.clearCompactBanner)

    return (
        <>
            {/* 消息列表卡片 — 仅已渲染的会话挂载（激活时渲染，切走后保留 10 分钟） */}
            {(isActive || wasRendered) && (
                <div
                    className="relative flex-1 bg-[var(--surface)] rounded-xl shadow-sm overflow-hidden flex flex-col min-h-0">
                    {compactStats?.showBanner && (
                        <CompactWarningBanner
                            beforeTokens={compactStats.beforeTokens}
                            afterTokens={compactStats.afterTokens}
                            savedTokens={compactStats.savedTokens}
                            compactedMessages={compactStats.compactedMessages}
                            onHide={clearCompactBanner}
                        />
                    )}
                    <MessageList conversationId={conversationId}/>
                    {/* Hook 执行结果悬浮通知 — 绝对定位于消息列表右上角 */}
                    <HookResultsBar/>
                </div>
            )}

            {/* 输入框卡片 — 始终挂载，保持输入状态 */}
            <div
                className="shrink-0 bg-[var(--surface)] rounded-t-[28px] rounded-b-[12px] shadow-[0_2px_12px_rgba(0,0,0,0.04)] dark:shadow-[0_2px_12px_rgba(0,0,0,0.12)] border border-[var(--border)] dark:border-[var(--border-emphasis)] focus-within:border-[var(--brand-primary)] focus-within:shadow-[0_2px_16px_rgba(0,210,106,0.06)] transition-all duration-200 overflow-hidden mx-[20px]">
                <InputArea isActive={isActive}/>
            </div>
        </>
    )
})

export default ConversationPage
