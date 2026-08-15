import {useMemo} from 'react'
import {useConversationStore} from '../stores/conversationStore'
import {computeMessageTokenStats} from '@shared/messageTokenStats'

/**
 * 会话消息 token 统计（薄封装：useMemo 包裹纯函数 computeMessageTokenStats）
 * 口径与 CacheRateTooltip 原逻辑一致。
 */
export function useMessageTokenStats() {
  const loadedMessages = useConversationStore(s => s.loadedMessages)
  return useMemo(() => computeMessageTokenStats(loadedMessages), [loadedMessages])
}
