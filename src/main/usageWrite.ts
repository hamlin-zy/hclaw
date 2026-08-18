/**
 * LLM 用量写入辅助（路径 1：主循环）
 *
 * 从 handleStreamEvent 的顶层 llm_call_done 事件写 llm_usage。
 * repo 可注入便于单测；默认使用全局 llmUsageRepo。
 */
import {toLlmUsageRecord} from '@shared/llmUsage'
import {llmUsageRepo} from './repositories/sqlite/llmUsageRepository'
import type {LlmUsageRecord} from '@shared/types'
import type {AgentStreamEvent} from './agent/stream'

/**
 * 每个 messageId 已写入 llm_usage 的条数（用于幂等键 seq 递增）。
 *
 * 背景：一条 assistant 消息可能对应多轮 LLM 调用（工具循环），每轮都会发一次
 * llm_call_done。幂等键 = usage_<messageId>_<seq>，若 seq 恒为 0，
 * INSERT OR IGNORE 会让后续轮次全部静默丢弃——重启后 UI 只能看到第 1 轮的统计。
 * 与子会话路径（agentTool.ts: seq = llmStats.length - 1）保持一致的递增语义。
 */
const seqByMessage = new Map<string, number>()

export function recordLlmUsageEvent(
  conversationId: string,
  event: Extract<AgentStreamEvent, {type: 'llm_call_done'}>,
  repo: {record(r: LlmUsageRecord): void} = llmUsageRepo,
): void {
  // manager.impl.ts 已把主进程 pending.id 注入 event.messageId
  if (!event.messageId) return
  const seq = seqByMessage.get(event.messageId) ?? 0
  seqByMessage.set(event.messageId, seq + 1)
  repo.record(toLlmUsageRecord(event, {conversationId, messageId: event.messageId, seq}))
}
