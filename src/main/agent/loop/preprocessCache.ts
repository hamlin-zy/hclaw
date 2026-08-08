/**
 * PreprocessCache — agent loop 内 LLM 调用前的 normalize 增量缓存
 *
 * 原理：LoopState.messages 只追加不修改。用 sourceCount（源消息数）判断
 * 是否需要增量处理；消息数相同（同 turn 重试）直接返回缓存结果。
 *
 * 只做 normalize（孤立 tool_use 注入合成结果）增量；sanitize（视觉/thinking
 * 清理）保持 execute.ts 现有条件调用不变（触发率低、开销小，YAGNI 不增量）。
 *
 * 增量判据：增量输出 === 全量输出（normalizeToolCallMessages）
 */

import type {ChatMessage} from '../model/types'
import {normalizeToolCallMessages} from '../state'

export class PreprocessCache {
  private sourceCount: number = -1
  private result: ChatMessage[] = []

  /**
   * 处理消息集，返回 normalize 后的 ChatMessage[]。
   *
   * forceRebuild=true 时全量重建（调用方在消息中间插入内容时使用，
   * 如 ContextRetrieval Hook 注入知识消息——中间插入会破坏「纯追加」假设）。
   */
  process(messages: ReadonlyArray<ChatMessage>, forceRebuild = false): ChatMessage[] {
    // 同长度重试 → 命中缓存，零处理
    if (!forceRebuild && this.sourceCount === messages.length) {
      return this.result
    }

    // 全量路径：首次 / forceRebuild / 消息减少
    if (this.sourceCount === -1 || forceRebuild || messages.length < this.sourceCount) {
      const full = normalizeToolCallMessages([...messages])
      this.sourceCount = messages.length
      this.result = full
      return full
    }

    // 增量路径：仅处理新增段
    const existingResultIds = new Set<string>()
    for (const msg of messages) {
      if (msg.role === 'tool' && msg.toolCallId) existingResultIds.add(msg.toolCallId)
    }
    const normalized = normalizeIncremental(messages, this.sourceCount, this.result, existingResultIds)

    this.sourceCount = messages.length
    this.result = normalized
    return normalized
  }

  /** 失效缓存（ContextRetrieval 等中间插入场景调用） */
  reset(): void {
    this.sourceCount = -1
    this.result = []
  }
}

/**
 * 增量 normalize — 与 normalizeToolCallMessages 输出一致，但只处理新增段。
 *
 * 处理规则（对齐全量版语义）：
 * 1. 缓存前缀原样保留，但需剔除「合成结果被真实结果取代」的 isError 消息：
 *    若新增段出现某 toolCallId 的真实 tool 结果，而缓存前缀中有该 id 的
 *    合成 error 消息（中断恢复场景），移除合成消息避免重复。
 * 2. 新增段中的 assistant 消息：若其 toolCalls 有孤立 id（全量集合中无
 *    对应 tool 结果）→ 注入合成 error tool 消息（紧跟该 assistant）。
 * 3. 新增段中的 tool 消息：原样追加。
 */
export function normalizeIncremental(
  messages: ReadonlyArray<ChatMessage>,
  prevCount: number,
  cached: ChatMessage[],
  existingResultIds: Set<string>,
): ChatMessage[] {
  const newSection = messages.slice(prevCount)

  // 1. 剔除缓存前缀中被真实结果取代的合成消息
  const newRealResultIds = new Set<string>()
  for (const msg of newSection) {
    if (msg.role === 'tool' && msg.toolCallId) newRealResultIds.add(msg.toolCallId)
  }
  let prefix = cached
  if (newRealResultIds.size > 0) {
    prefix = cached.filter(
      m => !(m.role === 'tool' && m.isError && m.toolCallId && newRealResultIds.has(m.toolCallId)),
    )
  }

  // 2+3. 处理新增段：注入孤立 tool_use 的合成结果
  const result: ChatMessage[] = [...prefix]
  for (let i = 0; i < newSection.length; i++) {
    const msg = newSection[i]
    if (msg.role !== 'assistant' || !msg.toolCalls?.length) {
      result.push(msg)
      continue
    }
    result.push(msg)
    const orphaned = msg.toolCalls.filter(tc => !existingResultIds.has(tc.id))
    for (const tc of orphaned) {
      result.push({
        role: 'tool',
        toolCallId: tc.id,
        content: '',
        toolResult: `[INTERRUPTED] 工具调用被中断，未获取到执行结果（tool: ${tc.name}）`,
        isError: true,
      })
    }
  }
  return result
}
