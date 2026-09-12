import type {ConversationMeta} from '@shared/types/infra'

/**
 * 「发送到指定会话」的候选列表（spec §4.3）：
 * ① 排除子会话（parentConvId 或 isChildSession）
 * ② 排除定时任务会话（sessionType === 'scheduler'）
 * ③ 交接链折叠：在通过 ①② 的集合内，排除被集合内其它会话 handoffFromConvId 指向的会话，只留链尾
 * ④ 按 updatedAt 降序，取前 20
 */
export function pickSessionCandidates(all: ConversationMeta[]): ConversationMeta[] {
  const noChildren = all.filter(c => !c.parentConvId && !c.isChildSession)
  const noScheduler = noChildren.filter(c => c.sessionType !== 'scheduler')
  const referenced = new Set(
    noScheduler.map(c => c.handoffFromConvId).filter((v): v is string => typeof v === 'string' && v !== ''),
  )
  const tails = noScheduler.filter(c => !referenced.has(c.id))
  return [...tails].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 20)
}
