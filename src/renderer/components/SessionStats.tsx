import {useMemo} from 'react'
import {useConversationStore} from '../stores/conversationStore'
import {useToolCallsStore} from '../stores/toolCallsStore'

/**
 * 会话统计信息
 */
interface SessionStats {
    requestCount: number
    totalInputTokens: number
    totalOutputTokens: number
    totalCacheReadTokens: number
    toolCallCount: number
    subAgentCount: number
    subAgentTokens: number
}

/**
 * 消息列表顶部统计栏
 * 显示当前会话的 LLM 请求次数、token 消耗和工具调用统计
 */
export default function SessionStats() {
    const loadedMessages = useConversationStore(s => s.loadedMessages)
    const toolCallStates = useToolCallsStore(s => s.states)

    const sessionStats = useMemo<SessionStats>(() => {
        let requestCount = 0
        let totalInputTokens = 0
        let totalOutputTokens = 0
        let totalCacheReadTokens = 0
        let toolCallCount = 0
        let subAgentCount = 0
        let subAgentTokens = 0

        for (const msg of loadedMessages) {
            if (msg.role === 'assistant') {
                const statsList = Array.isArray(msg.llmStats) ? msg.llmStats : []
                requestCount += statsList.length
                for (const stats of statsList) {
                    totalInputTokens += stats.inputTokens || 0
                    totalOutputTokens += stats.outputTokens || 0
                    totalCacheReadTokens += stats.cacheReadTokens || 0
                }
                if (msg.toolCalls && msg.toolCalls.length > 0) {
                    toolCallCount += msg.toolCalls.length
                }
            }
        }

        for (const [, state] of Object.entries(toolCallStates)) {
            if (state?.tokenUsage) {
                subAgentCount++
                subAgentTokens += state.tokenUsage.totalTokens || 0
            }
        }

        return {
            requestCount,
            totalInputTokens,
            totalOutputTokens,
            totalCacheReadTokens,
            toolCallCount,
            subAgentCount,
            subAgentTokens
        }
    }, [loadedMessages, toolCallStates])

    const formatTokenK = (count: number): string =>
        count >= 1000 ? `${(count / 1000).toFixed(1)}k` : `${count}`

    const stats = [
        `LLM ${sessionStats.requestCount}次`,
        `输入 ${formatTokenK(sessionStats.totalInputTokens + sessionStats.totalCacheReadTokens)}`,
        ...(sessionStats.totalCacheReadTokens > 0 ? [`缓存 ${formatTokenK(sessionStats.totalCacheReadTokens)}`] : []),
        `输出 ${formatTokenK(sessionStats.totalOutputTokens)}`,
        `工具 ${sessionStats.toolCallCount}次`,
        ...(sessionStats.subAgentCount > 0 ? [`Agent ${sessionStats.subAgentCount}个`] : []),
    ]

    return (
        <div className="flex items-center gap-2 text-[11px] text-[var(--text-muted)] font-medium tabular-nums">
            {stats.map((s, i) => (
                <span key={i} className="shrink-0">
                    {i > 0 && <span className="mx-1 opacity-40">·</span>}
                    {s}
                </span>
            ))}
        </div>
    )
}
