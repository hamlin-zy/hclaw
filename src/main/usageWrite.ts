/**
 * LLM 用量写入辅助（路径 1：主循环）
 *
 * 从 handleStreamEvent 的顶层 llm_call_done 事件写 llm_usage。
 * repo 可注入便于单测；默认使用全局 llmUsageRepo。
 */
import {toLlmUsageRecord} from '@shared/llmUsage'
import {llmUsageRepo} from './repositories/sqlite/llmUsageRepository'
import {logger} from './agent/logger'
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

/**
 * 已终结（finalize 成功并释放 seq 记账）的 messageId 集合（S5 迟到事件防御）。
 *
 * 已知边界：释放后若仍有"迟到的 llm_call_done"到达同一 messageId，seq 会从 0
 * 重算并撞已有幂等键 usage_<msgId>_0，被 INSERT OR IGNORE 丢弃一条用量。
 * 正常情况下不发生（事件按序处理，llm_call_done 必先于 done；新 pending 必得新
 * UUID，messageId 绝不复用），故这里只做"可观测化"防御：检测到即 logger.warn，
 * 不静默、不抛错（不改变 seq 语义——reset 后仍从 0 起，见护栏用例）。
 *
 * 有界：只保留最近 FINALIZED_KEEP 条（Set 迭代序 = 插入序，超限从最旧驱逐）。
 * 超出窗口后该异常不再告警，属已接受的边界（异常本身即不应发生）。
 *
 * ★ 内存优化 V2：迟到分支在 record 之后立即 delete(mid)，阻止迟到事件把已释放的
 * seq key 复活残留（否则该 key 再无释放路径，与"完成即清"相悖）。
 */
const finalizedMsgIds = new Set<string>()
const FINALIZED_KEEP = 256

/**
 * 消息终结时释放该 messageId 的 seq 记账（与 resetBridgeMsgState 同条件联动调用）。
 *
 * 语义：seq 按 messageId 单调递增，仅用于构造幂等键 usage_<messageId>_<seq>；
 * messageId 是每条 assistant 消息唯一的 UUID，非全局单调。finalize 后该消息
 * 不会再产生新的 llm_call_done（新 pending 必得新 UUID），故可安全释放。
 */
export function resetUsageMsgState(messageId: string): void {
  if (!messageId) return
  // 幂等：seq 记账无条件释放（重复 reset 后仍从 0 重算）
  seqByMessage.delete(messageId)
  // ★ 内存优化 D3：已存在则不重新 add（不再 delete+add）。
  // cleanup 兜底释放（manager.impl.ts:1565）与正常 finalize（:532 / :678）会对
  // 同一 id 重复调用本函数；若每次都 delete+add，会把已终结 id 刷新到 Set 插入序
  // 末尾，导致 FINALIZED_KEEP(256) 驱逐时提前淘汰较新的 id，缩短迟到告警覆盖窗口。
  // 仅在首次终结时插入，已终结 id 保持其首次终结时的插入序位置。
  if (!finalizedMsgIds.has(messageId)) {
    // 有界记录"已终结"，供迟到事件检测（Set 迭代序 = 插入序 → 驱逐最旧）
    finalizedMsgIds.add(messageId)
    while (finalizedMsgIds.size > FINALIZED_KEEP) {
      const oldest = finalizedMsgIds.values().next().value
      if (oldest === undefined) break
      finalizedMsgIds.delete(oldest)
    }
  }
}

export function recordLlmUsageEvent(
  conversationId: string,
  event: Extract<AgentStreamEvent, {type: 'llm_call_done'}>,
  repo: {record(r: LlmUsageRecord): void} = llmUsageRepo,
): void {
  // manager.impl.ts 已把主进程 pending.id 注入 event.messageId
  if (!event.messageId) return
  const messageId = event.messageId
  // 防御（S5）：已终结 messageId 又来事件 → 告警（不静默丢弃、不抛错）。
  // 正常流程不可达；命中说明存在事件乱序/消息 id 复用，需人工排查。
  const isLateForFinalized = finalizedMsgIds.has(messageId)
  if (isLateForFinalized) {
    logger.warn('[usageWrite] 迟到 llm_call_done：messageId 已终结，seq 记账已释放', {
      conversationId, messageId,
    })
  }
  const seq = seqByMessage.get(messageId) ?? 0
  seqByMessage.set(messageId, seq + 1)
  repo.record(toLlmUsageRecord(event, {conversationId, messageId, seq}))
  // ★ 内存优化 V2：阻止迟到事件"复活"已释放的 seq key。
  // 上面的 set 会把 reset 时 delete 掉的 key 重新建回，而该消息已终结、不会再有
  // finalize → 此后无任何释放路径，漏删即永久残留（key 为唯一 UUID，不复用）。
  // 保留 record 调用以维持既有可观测行为（不静默、不抛错、seq 语义不变——
  // reset 后仍从 0 起，与护栏用例一致；该条本就会被 INSERT OR IGNORE 丢弃），
  // 仅在记录后立即删除，使 key 不残留。
  if (isLateForFinalized) {
    seqByMessage.delete(messageId)
  }
}
