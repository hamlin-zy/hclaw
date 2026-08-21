import {useMemo} from 'react'
import {useConversationStore} from '../stores/conversationStore'
import {computeMessageTokenStats, computeMessageTokenStatsByModel} from '@shared/messageTokenStats'

/**
 * 会话消息 token 统计（薄封装：useMemo 包裹纯函数）
 * - stats：全局口径（所有模型汇总，与原 computeMessageTokenStats 一致）
 * - byModel：按「服务商 + 模型」分组的完整统计，按末次使用时间倒序
 *   （徽章卡片模型切换器数据源，含末次使用时间）
 */
export function useMessageTokenStats() {
  const loadedMessages = useConversationStore(s => s.loadedMessages)
  return useMemo(() => {
    const stats = computeMessageTokenStats(loadedMessages)
    const byModel = computeMessageTokenStatsByModel(loadedMessages)
    return {stats, byModel}
  }, [loadedMessages])
}
