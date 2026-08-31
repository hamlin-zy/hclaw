// src/main/persistence/conversationPersistence.ts
/**
 * 唯一持久化主体（设计 §2）：节流累积 + 调用 repository 写入 + 重试。
 * 明确不做：不组装业务内容；不复制 loop 已有的权威 Message（7.3，只持未 flush 增量）。
 *
 * 内存安全不变式（设计 §7）：
 * - 7.1 text 增量 = 原始 chunk 短串拼接（mergeBlocksById），flush 成功后 entry delete；
 *   禁止 fullBuffer + 偏移指针 + slice 结构（SlicedString O(n²)，实测放大 184 倍）。
 * - 7.2 per-conv/per-msg 容器清理触发必须是必然事件：flush 成功（delete key）/
 *   finalize 成功（delete key）/ conv 删除（clearConversation 整组 delete）。
 *   禁止"等 XXX 事件再清"。
 * - 7.4 Map 按 msgId O(1) 索引，flush 只序列化 dirty 块，不做全量消息重建。
 */
import type {BlockDeltaPatch, Message, MessageBlock, ToolCall} from '@shared/types'

export interface ConversationWriteRepo {
  writeBlockDelta(convId: string, msgId: string, patch: BlockDeltaPatch): boolean
  writeMessagesDelta(convId: string, message: Message): boolean
}

export type PersistEvent =
  | {type: 'message-finalized'; convId: string; msgId: string}
  | {type: 'persist-degraded'; convId: string; failureCount: number}

/** 桥接侧 toolCall 形态：tool_use/tool_start 事件的 ToolCallInfo 无 status/result */
export type ToolCallPersistable = Omit<ToolCall, 'status' | 'result'> & {
  status?: ToolCall['status']
  result?: ToolCall['result']
}

const THROTTLE_MS = 30000        // 与渲染端同参数（conversationStore.ts:297）
const RETRY_BASE_MS = 1000       // §4.1：1s→2s→4s
const RETRY_MAX_MS = 30000
const MAX_CONSECUTIVE_FAILURES = 10

/** 合并 upsertBlocks：块 id 主键幂等——同 id 后写覆盖，异 id 追加，保持首见顺序。
 *  text 块同 id 增量拼接（chunk 短串累加，7.1 允许形态）。
 *  自 conversationStore.ts:115-128 平移，逻辑一字不改。 */
function mergeBlocksById(prev: MessageBlock[] | undefined, next: MessageBlock[]): MessageBlock[] {
  const byId = new Map<string, MessageBlock>()
  for (const b of prev ?? []) byId.set(b.id, b)
  for (const b of next) {
    const existing = byId.get(b.id)
    if (existing && b.blockType === 'text') {
      byId.set(b.id, {...b, content: (existing.content || '') + (b.content || '')})
    } else {
      byId.set(b.id, b)
    }
  }
  return [...byId.values()]
}

interface ConvState {
  patches: Map<string, BlockDeltaPatch>
  timer: ReturnType<typeof setTimeout> | null
  failureCount: number
  /** 最近一次真实写库尝试时刻：重试间隔不得小于节流窗口（见 #scheduleRetry 注释） */
  lastAttemptAt: number
}

export class ConversationPersistence {
  private states = new Map<string, ConvState>()
  private listeners = new Set<(e: PersistEvent) => void>()

  constructor(private repo: ConversationWriteRepo) {}

  onPersistEvent(cb: (e: PersistEvent) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  #emit(e: PersistEvent): void { for (const l of this.listeners) l(e) }

  #state(convId: string): ConvState {
    let st = this.states.get(convId)
    if (!st) { st = {patches: new Map(), timer: null, failureCount: 0, lastAttemptAt: 0}; this.states.set(convId, st) }
    return st
  }

  /** 累积某消息的块级增量（7.4：Map O(1)）。字段级合并 messageFields，
   *  finalize 一经置位不回退（自 conversationStore.ts:131-143 平移）。 */
  accumulate(convId: string, msgId: string, patch: Partial<BlockDeltaPatch>): void {
    const st = this.#state(convId)
    const cur = st.patches.get(msgId) ?? {upsertBlocks: []}
    st.patches.set(msgId, {
      upsertBlocks: mergeBlocksById(cur.upsertBlocks, patch.upsertBlocks ?? []),
      messageFields: {...cur.messageFields, ...(patch.messageFields ?? {})},
      finalize: patch.finalize ?? cur.finalize,
    } as BlockDeltaPatch)
    this.#scheduleFlush(convId)
  }

  /** 消息行先建再写块（writeBlockDelta 既有注释即规范）：消息开始时由 loop 调用 */
  ensureMessageRow(convId: string, msgId: string, timestamp: number, metadata?: Record<string, unknown>): void {
    this.accumulate(convId, msgId, {messageFields: {role: 'assistant', timestamp, metadata}})
  }

  /** finalize：同步写单条（end 块落库成功才发事件，§3.6-4）。
   *  成功后 delete msgId entry（7.2c）。失败：patch 保留待重试，不发事件。
   *  ★ 无累积 patch 时 no-op（返回 true）：主进程是唯一写方（Phase 2），凡本类
   *  累积过的消息必先经 ensureMessageRow/accumulate 落 patch；无 patch 说明该
   *  消息内容不经本类（如 #findRenderedCopy 指纹副本场景），此时不得凭空建行。 */
  finalizeMessage(convId: string, msgId: string, endedAt: number): boolean {
    const st = this.states.get(convId)
    if (!st?.patches.has(msgId)) return true
    this.accumulate(convId, msgId, {finalize: true, messageFields: {endedAt}})
    const ok = this.flushMessage(convId, msgId)
    if (ok) this.#emit({type: 'message-finalized', convId, msgId})
    return ok
  }

  /** 同步写单条消息的累积 patch。★ 幂等命门（§4.4）：成功才 delete entry；
   *  失败时 patch 原样保留（writeBlockDelta 失败即事务回滚 DB 未变，重试重发同一 patch 不双写）。 */
  flushMessage(convId: string, msgId: string): boolean {
    const st = this.states.get(convId)
    const patch = st?.patches.get(msgId)
    if (!patch) return true
    st!.lastAttemptAt = Date.now()
    const ok = this.repo.writeBlockDelta(convId, msgId, patch)
    if (ok) {
      st!.patches.delete(msgId)   // 7.2a/c：delete key，不是只清内容
      st!.failureCount = 0
    }
    return ok
  }

  /** flush 该会话全部 dirty（节流 timer 到期 / 显式调用）。失败者进入指数退避重试。 */
  flush(convId: string): void {
    const st = this.states.get(convId)
    if (!st || st.patches.size === 0) return
    let failed = false
    for (const msgId of [...st.patches.keys()]) {
      if (!this.flushMessage(convId, msgId)) failed = true
    }
    if (failed) this.#scheduleRetry(convId)
  }

  /** memo/handoff/channel 一次性全量：单条消息 UPSERT（写入路径职责表，不走节流） */
  writeNow(convId: string, message: Message): boolean {
    return this.repo.writeMessagesDelta(convId, message)
  }

  // ─── record* 便捷方法（streamBridge 桥接用，全部委托 accumulate；语义平移自 conversationStore.ts:213-295）───

  /** text 增量块：id = `text-${msgId}-${textSeq}`（同 id 增量拼接，mergeBlocksById text 分支） */
  recordTextChunk(convId: string, msgId: string, textSeq: number, chunk: string, turnIndex?: number): void {
    if (!chunk) return
    this.accumulate(convId, msgId, {upsertBlocks: [{
      id: `text-${msgId}-${textSeq}`, messageId: msgId, blockType: 'text',
      content: chunk, data: null, sequence: 0, timestamp: Date.now(), turnIndex,
    }]})
  }

  /** think 块（同 id 覆盖：段内增长/状态更新） */
  recordThinkBlock(convId: string, msgId: string, id: string, content: string,
                   status: 'thinking' | 'complete', turnIndex?: number): void {
    const timestamp = Date.now()
    this.accumulate(convId, msgId, {upsertBlocks: [{
      id, messageId: msgId, blockType: 'think', content,
      data: JSON.stringify({id, content, status, timestamp}), sequence: 0, timestamp, turnIndex,
    }]})
  }

  /** tool_call 块（result 由 tool_result 块承载，不入 data） */
  recordToolCallBlock(convId: string, msgId: string, tc: ToolCallPersistable, turnIndex?: number): void {
    const {result: _result, ...persistable} = tc
    this.accumulate(convId, msgId, {upsertBlocks: [{
      id: `${msgId}-tc-${tc.id}`, messageId: msgId, blockType: 'tool_call',
      content: null, sequence: 0, timestamp: Date.now(),
      data: JSON.stringify(persistable), turnIndex,
    }]})
  }

  /** tool_result：同 id upsert tool_call（终态 status）+ tool_result 块（conversationStore.ts:267-288 语义平移） */
  recordToolResultBlock(convId: string, msgId: string, tc: ToolCallPersistable, turnIndex?: number): void {
    if (tc.result === undefined) return
    const timestamp = Date.now()
    const {result: _result, ...persistable} = tc
    this.accumulate(convId, msgId, {upsertBlocks: [
      {id: `${msgId}-tc-${tc.id}`, messageId: msgId, blockType: 'tool_call', content: null,
       sequence: 0, timestamp, data: JSON.stringify(persistable), turnIndex},
      {id: `${msgId}-tr-${tc.id}`, messageId: msgId, blockType: 'tool_result', content: null,
       sequence: 0, timestamp, data: JSON.stringify({id: tc.id, result: tc.result}), turnIndex},
    ]})
  }

  /** compact 前：清空该 conv 未 flush 增量，防旧增量覆盖 compact 结果（§4.3）。保留状态对象。 */
  clearDeltaQueue(convId: string): void {
    const st = this.states.get(convId)
    if (st) st.patches.clear()
  }

  /** ★P3 修正：丢弃某消息的未 flush 增量。#mergeAndPersist 全量写分支（blocks==0 时，
   *  text 块 id 为 offset 型）已完整落库该消息；若不丢弃，随后的 finalize 会把桥接
   *  累积的 seq 型块补插进同一消息 → 两套 text 块 → blocksToMessage 拼接重复正文。 */
  discardMessage(convId: string, msgId: string): void {
    const st = this.states.get(convId)
    if (st) st.patches.delete(msgId)
  }

  /** 会话删除：flush 后整组清理（§4.3：防 dirty flush 复活已删消息；7.2b 必然事件触发） */
  clearConversation(convId: string): void {
    const st = this.states.get(convId)
    if (st?.timer) clearTimeout(st.timer)
    this.states.delete(convId)
  }

  /** 启动/会话恢复扫描（§4.2）：补齐所有未 finalize 的 assistant 消息。
   *  扫描 SQL 过滤 role='assistant' AND ended_at IS NULL（消息行级条件，DB 层判定）。
   *  think/tool_call 崩溃窗口内增量丢失不补（§8 已接受风险：loop 内存态不可恢复）。 */
  recoverUnfinalized(convId: string): void {
    const repo = this.repo as unknown as {
      finalizeAbnormal: (c: string, m: string, t: number) => boolean
      listUnfinalized?: (c: string) => Array<{id: string}>
    }
    if (!repo.listUnfinalized) return   // SQL 原语由 repo 层提供
    for (const {id} of repo.listUnfinalized(convId)) {
      repo.finalizeAbnormal(convId, id, Date.now())
    }
  }

  /** 应用退出：全部会话同步 flush（§4.3） */
  flushAllSync(): void {
    for (const convId of [...this.states.keys()]) this.flush(convId)
  }

  #scheduleFlush(convId: string): void {
    const st = this.#state(convId)
    if (st.timer) return
    st.timer = setTimeout(() => { st.timer = null; this.flush(convId) }, THROTTLE_MS)
  }

  #scheduleRetry(convId: string): void {
    const st = this.#state(convId)
    st.failureCount += 1
    if (st.failureCount >= MAX_CONSECUTIVE_FAILURES) {
      this.#emit({type: 'persist-degraded', convId, failureCount: st.failureCount})
    }
    // ★ 与计划的偏差（已记录于 task-5-report.md）：纯指数 1s→2s→4s 会在一个 60s 窗口内
    // 触发 5 次写库尝试，违反测试约束（每 60s ≤2 次）。重试间隔取
    // max(指数退避, 距上次尝试的节流剩余)——指数公式与上限保留，退避超过节流窗口时生效。
    const backoff = Math.min(RETRY_BASE_MS * 2 ** (st.failureCount - 1), RETRY_MAX_MS)
    const sinceLast = Date.now() - st.lastAttemptAt
    const delay = Math.max(backoff, THROTTLE_MS - sinceLast)
    if (!st.timer) {
      st.timer = setTimeout(() => { st.timer = null; this.flush(convId) }, delay)
    }
  }
}

/** 单例：惰性绑定真实 repo（与 startAgentCore.ts 使用同一工厂 createConversationRepository，
 *  位于 src/main/repositories/index.ts:28）。 */
import {createConversationRepository} from '../repositories'
import type {IConversationRepository} from '../repositories/interfaces'
let singleton: ConversationPersistence | null = null
export function getConversationPersistence(): ConversationPersistence {
  if (!singleton) {
    singleton = new ConversationPersistence(createConversationRepository() as unknown as IConversationRepository)
  }
  return singleton
}
