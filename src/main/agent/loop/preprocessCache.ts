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
 *
 * 增长场景优化（方案 A）：
 * - resultIds / syntheticIds 两个 Set 跨轮原地维护（同实例不重建），
 *   增量路径只把新增段 id 加入，避免每步 O(n) 全量重建
 * - 两阶段：先「判定」（只收集信息，不构造数组，O(新增段)），
 *   再按需「构造」（零拷贝路径完全跳过，O(n) 仅罕见路径）
 * - 稳态零拷贝：前缀干净（syntheticIds 空）+ 无孤儿 + 无取代时
 *   返回输入数组本身（normalize 幂等原样）
 */

import type {ChatMessage} from '../model/types'
import {normalizeToolCallMessages, isSyntheticToolResult} from '../state'

export class PreprocessCache {
  private sourceCount: number = -1
  private result: ChatMessage[] = []
  /** 前缀中全部真实 tool 结果 id（含失败结果，不含合成） */
  private resultIds = new Set<string>()
  /** 前缀中合成 error 消息的 id */
  private syntheticIds = new Set<string>()
  /**
   * 最近一次 process() 是否发生了「合成注入 / 取代」——即输出与输入内容不一致
   * （zeroCopy=false）。调用方（execute.ts）据此失效 adapter 的增量转换缓存，
   * 避免 adapter 按长度命中返回基于过期前缀的转换结果，产生孤儿 tool 消息。
   */
  lastWasNonZeroCopy: boolean = false

  /**
   * 处理消息集，返回 normalize 后的 ChatMessage[]。
   *
   * forceRebuild=true 时全量重建（调用方在消息中间插入内容时使用，
   * 如 ContextRetrieval Hook 注入知识消息——中间插入会破坏「纯追加」假设）。
   *
   * 返回语义：可能返回输入数组本身（稳态零拷贝），调用方只读消费。
   */
  process(messages: ReadonlyArray<ChatMessage>, forceRebuild = false): ChatMessage[] {
    // 同长度重试 → 命中缓存，零处理（输出与上次一致，无需失效 adapter 缓存）
    if (!forceRebuild && this.sourceCount === messages.length) {
      this.lastWasNonZeroCopy = false
      return this.result
    }

    // 全量路径：首次 / forceRebuild / 消息减少
    if (this.sourceCount === -1 || forceRebuild || messages.length < this.sourceCount) {
      const full = normalizeToolCallMessages([...messages])
      this.resultIds = new Set<string>()
      this.syntheticIds = new Set<string>()
      for (const m of full) {
        if (m.role !== 'tool' || !m.toolCallId) continue
        if (isSyntheticToolResult(m)) this.syntheticIds.add(m.toolCallId)
        else this.resultIds.add(m.toolCallId)
      }
      this.sourceCount = messages.length
      this.result = full
      // 全量路径：adapter 缓存与本次全量重建天然同步（count 对齐或重建），
      // 但若注入改变了长度/内容，仍需通知 adapter 全量重建以对齐
      this.lastWasNonZeroCopy = full.length !== messages.length
      return full
    }

    // 增量路径：仅处理新增段
    const normalized = normalizeIncremental(
      messages, this.sourceCount, this.result, this.resultIds, this.syntheticIds,
    )
    this.sourceCount = messages.length
    this.result = normalized.result
    this.resultIds = normalized.resultIds
    this.syntheticIds = normalized.syntheticIds
    this.lastWasNonZeroCopy = normalized.zeroCopy !== true
    return normalized.result
  }

  /** 失效缓存（ContextRetrieval 等中间插入场景调用） */
  reset(): void {
    this.sourceCount = -1
    this.result = []
    this.resultIds = new Set<string>()
    this.syntheticIds = new Set<string>()
    this.lastWasNonZeroCopy = false
  }
}

export interface IncrementalNormalizeResult {
  result: ChatMessage[]
  /** 更新后的真实结果 id —— 与入参 resultIds 同一引用（原地更新） */
  resultIds: Set<string>
  /** 更新后的合成 id —— 与入参 syntheticIds 同一引用（原地更新） */
  syntheticIds: Set<string>
  /** 是否零拷贝（result === messages 输入数组） */
  zeroCopy: boolean
}

/**
 * 增量 normalize — 与 normalizeToolCallMessages 输出一致，但只处理新增段。
 *
 * 处理规则（对齐全量版语义）：
 * 1. 取代过滤（惰性）：仅当新增段真实结果 id 与 syntheticIds 有交集时，
 *    才全前缀扫描剔除被真实结果取代的合成消息（中断恢复场景）。
 * 2. 新增段中的 assistant 消息：其 toolCalls 中孤立 id（全量集合 resultIds ∪
 *    newRealResultIds 中无对应真实结果）→ 注入合成 error tool 消息，
 *    插到该 assistant 之后连续 tool 消息之后（对齐全量版 insertAt 语义，
 *    保证 tool_result 与 tool_use 顺序一致）。
 * 3. 稳态零拷贝：前缀干净 + 无孤儿 + 无取代 → result 为输入数组本身。
 *
 * 依赖假设：toolCallId 全局唯一（模型生成的 UUID）。若同一 id 跨 assistant 复用，
 * 增量判据（resultIds 不含合成 id）与全量判据（existingResultIds 含合成 id）会有差异；
 * 实际流程中该场景不可达，此处记录以保证未来变更知情。
 */
export function normalizeIncremental(
  messages: ReadonlyArray<ChatMessage>,
  prevCount: number,
  cached: ChatMessage[],
  resultIds: Set<string>,
  syntheticIds: Set<string>,
): IncrementalNormalizeResult {
  const newSection = messages.slice(prevCount)

  // ── 第一遍：收集新增段真实结果 id ──
  const newRealResultIds = new Set<string>()
  for (const msg of newSection) {
    if (msg.role === 'tool' && msg.toolCallId) newRealResultIds.add(msg.toolCallId)
  }

  // ── 取代检查（惰性）：仅交集非空才全前缀过滤（O(n) 罕见路径） ──
  let prefix = cached
  let replaced = false
  for (const id of newRealResultIds) {
    if (syntheticIds.has(id)) {
      replaced = true
      break
    }
  }
  // 隐式不变式：该轮含取代时 result 必非零拷贝（落入下方构造分支）。
  // 且下次零拷贝短路 `syntheticIds.size === 0` 已排除同引用前缀：
  // 上一轮零拷贝后 cached 与 messages 前缀同引用，本轮被取代重建 →
  // 后续轮次该前缀成为 cached，但 resultIds/syntheticIds 已按真实结果更新，不会反向污染。
  if (replaced) {
    prefix = cached.filter(
      m => !(isSyntheticToolResult(m) && m.toolCallId && newRealResultIds.has(m.toolCallId)),
    )
    for (const id of newRealResultIds) syntheticIds.delete(id)
  }

  // ── 第二遍：判定阶段（只收集信息，不构造数组，保证零拷贝无 O(n) 拷贝） ──
  let anyOrphan = false
  for (const msg of newSection) {
    if (msg.role === 'tool' && msg.toolCallId) {
      resultIds.add(msg.toolCallId)
    } else if (msg.role === 'assistant' && msg.toolCalls?.length) {
      for (const tc of msg.toolCalls) {
        if (!resultIds.has(tc.id) && !newRealResultIds.has(tc.id)) anyOrphan = true
      }
    }
  }

  // ── 零拷贝判定：前缀干净 + 无孤儿 + 无取代 → 返回输入数组本身 ──
  if (!anyOrphan && !replaced && syntheticIds.size === 0) {
    return {result: messages as ChatMessage[], resultIds, syntheticIds, zeroCopy: true}
  }

  // ── 构造阶段（O(n) 罕见路径：注入 / 取代 / 脏前缀） ──
  const result: ChatMessage[] = []
  let i = 0
  while (i < newSection.length) {
    const msg = newSection[i]
    if (msg.role === 'assistant' && msg.toolCalls?.length) {
      result.push(msg)
      i++
      // 顺序修复：先消费其后连续 tool 消息（对齐全量版 insertAt 语义）
      while (i < newSection.length && newSection[i].role === 'tool') {
        result.push(newSection[i])
        i++
      }
      // 注入孤儿合成消息（保持 tool_use 顺序一致）
      const orphaned = msg.toolCalls.filter(
        tc => !resultIds.has(tc.id) && !newRealResultIds.has(tc.id),
      )
      for (const tc of orphaned) {
        syntheticIds.add(tc.id)
        result.push({
          role: 'tool',
          toolCallId: tc.id,
          content: '',
          toolResult: `[INTERRUPTED] 工具调用被中断，未获取到执行结果（tool: ${tc.name}）`,
          isError: true,
        })
      }
    } else {
      result.push(msg)
      i++
    }
  }
  return {result: [...prefix, ...result], resultIds, syntheticIds, zeroCopy: false}
}
