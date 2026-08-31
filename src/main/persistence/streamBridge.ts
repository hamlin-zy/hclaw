/**
 * AgentStreamEvent -> ConversationPersistence 桥接(Phase 2 渲染端 record* 职责平移)。
 * 职责映射(源自 conversationStore.ts:213-295，逻辑平移；UI 事件流不受影响--7.5 双通道):
 *   recordTextBlock    -> 'text' 事件
 *   recordThinkBlock   -> 'thinking' 事件
 *   recordToolCallBlock -> 'tool_use'/'tool_start' 事件
 *   recordToolResultBlock -> 'tool_result'/'tool_completed'/'tool_denied' 事件
 * 不持久化: tool_progress / tool_detail / subagent_* / ask_user/permission_confirm
 * (设计 S4.2 已接受风险: 崩溃窗口内 think/tool_call 增量丢失不补)。
 */
import type {AgentStreamEvent} from '../agent/stream'
import type {PendingAssistantMsg} from '../agent/manager.types'
import type {ConversationPersistence, ToolCallPersistable} from './conversationPersistence'

// ── P5 修正：think 段号状态（writeBlockDelta 对 think 块是覆盖语义，交错思考
//    think→tool→think 场景下固定单 id 会覆盖丢段；渲染端现状为每段独立 id）──
const thinkSegByMsg = new Map<string, number>()          // msgId → 当前段号
const lastWasThinking = new Set<string>()                // msgId → 上一事件是否 thinking

// ── 方案 2 根治：LLM 调用轮次标注（turnIndex）────────────────────────────
// 契约：一次 LLM 调用 = 一个 turnIndex。tool_result/tool_denied 必然是一次
// 调用的收尾，其后首个 thinking/text 块开启下一轮；同轮内 think→text→think
// 交错不递增。此前 turnIndex 由 manager 传入且仅在 user_message_injected 时
// 递增，容器消息内多次 LLM 调用全部 undefined → DB turn_index 全 NULL →
// historyConverter 恒走 think 边界切段 fallback，单轮多段 think 被过度拆分
// 为 stub assistant → 重建序列 ≠ loop 内存态 → KV cache 断裂。
const turnSeqByMsg = new Map<string, number>()           // msgId → 当前轮次
const contentAfterToolByMsg = new Set<string>()          // msgId → tool_result 后已有内容块

/** 当前轮次（tool_use 等不开启新轮的块） */
function currentTurn(msgId: string): number {
  return turnSeqByMsg.get(msgId) ?? 0
}
/** 内容块（thinking/text）的轮次：若处于 tool_result 之后则开启下一轮 */
function turnForContent(msgId: string): number {
  if (contentAfterToolByMsg.has(msgId)) {
    contentAfterToolByMsg.delete(msgId)
    turnSeqByMsg.set(msgId, currentTurn(msgId) + 1)
  }
  return currentTurn(msgId)
}
/** tool_result/tool_denied 收尾 = 一次 LLM 调用结束，标记下一内容块开启新轮 */
function closeTurn(msgId: string): void {
  contentAfterToolByMsg.add(msgId)
}

// ── P4 修正：子会话排除（与渲染端 isChildConversation 守卫等价）──────────
// 子会话落库由 agentTool 独立累积器 childAcc 负责（agentTool.ts），桥接若不排除 =
// 流式块增量 + childAcc 全量写 + manager 保险丝三写方。
// ★ 裁决 R9：setChildConvChecker 仅导出、不注册（保持默认 no-op）——子会话事件
//   结构性不流经 manager（agentTool childAcc 直接跑 loop，P4 已查证），注册属
//   防御性可选，不做 main 初始化挂接。
let isChildConv: (convId: string) => boolean = () => false
export function setChildConvChecker(fn: (convId: string) => boolean): void { isChildConv = fn }

export function persistStreamEvent(
  p: ConversationPersistence,
  convId: string,
  msgId: string,
  pending: PendingAssistantMsg,
  event: AgentStreamEvent,
): void {
  if (isChildConv(convId)) return   // ★P4：子会话由 childAcc 唯一负责
  const thinkSeq = () => thinkSegByMsg.get(msgId) ?? 0
  switch (event.type) {
    case 'text': {
      const chunk = (event as {type: 'text'; content?: string}).content || ''
      if (chunk) p.recordTextChunk(convId, msgId, thinkSeq() + pending.toolCalls.length, chunk, turnForContent(msgId))
      lastWasThinking.delete(msgId)
      break
    }
    case 'thinking': {
      // 进入新 think 段（think→text→think 交错）→ 段号 +1（渲染端每段独立 id 语义）
      if (!lastWasThinking.has(msgId)) {
        thinkSegByMsg.set(msgId, thinkSeq() + 1)
      }
      lastWasThinking.add(msgId)
      const content = pending.thinkParts?.length ? pending.thinkParts.join('') : ((event as {content?: string}).content || '')
      if (content) p.recordThinkBlock(convId, msgId, `think-${msgId}-${thinkSeq()}`, content, 'thinking', turnForContent(msgId))
      break
    }
    case 'tool_use':
    case 'tool_start': {
      const tc = (event as {toolCall?: ToolCallPersistable}).toolCall
      if (!tc) break
      lastWasThinking.delete(msgId)
      p.recordToolCallBlock(convId, msgId, {...tc, status: tc.status ?? 'running'}, currentTurn(msgId))
      break
    }
    case 'tool_result':
    case 'tool_completed': {
      const ev = event as {toolCallId?: string; result?: unknown}
      const tc = pending.toolCalls.find(t => t.id === ev.toolCallId)
      if (!tc) break
      lastWasThinking.delete(msgId)
      // 终态修复语义（conversationStore.ts:267-271 平移）：result 由事件携带；
      // manager 私有 accumulateEvent 双轨已把 normalized result 写回 pending.toolCalls，
      // 桥接以事件优先（pending 未及更新时仍能落终态）。
      const result = ev.result ?? tc.result
      if (result === undefined) break
      const status = tc.status === 'running' || tc.status === undefined
        ? ((result as {success?: boolean}).success === false ? 'error' : 'success')
        : tc.status
      p.recordToolResultBlock(convId, msgId, {...tc, status, result} as ToolCallPersistable, currentTurn(msgId))
      closeTurn(msgId)
      break
    }
    case 'tool_denied': {
      const ev = event as {toolCallId?: string; reason?: string}
      const tc = pending.toolCalls.find(t => t.id === ev.toolCallId)
      if (!tc) break
      lastWasThinking.delete(msgId)
      const deniedReason = `[PERMISSION_DENIED] ${ev.reason || '权限被拒绝'}`
      p.recordToolResultBlock(convId, msgId, {
        ...tc,
        status: 'error',
        result: {output: '', error: deniedReason, toolResult: `[ERROR] ${deniedReason}`},
      }, currentTurn(msgId))
      closeTurn(msgId)
      break
    }
    default:
      // tool_progress/tool_detail/subagent_*/ask_user/permission_confirm/done/error 不落块
      break
  }
}

/** 消息终结时清理桥接段号状态（7.2：finalize 为必然事件触发，finalizeMessage 成功路径调用） */
export function resetBridgeMsgState(msgId: string): void {
  thinkSegByMsg.delete(msgId)
  lastWasThinking.delete(msgId)
  turnSeqByMsg.delete(msgId)
  contentAfterToolByMsg.delete(msgId)
}

/** text 段序号 = 已出现的非 text 块数(对齐 conversationStore.ts:216-221 语义)。
 *  think 段数: pending 有 think 内容即 1 段；若 manager 引入多 think 段累积须同步改段计数。 */
export function deriveTextSeq(pending: PendingAssistantMsg): number {
  const thinkSegs = (pending.thinkParts?.length ?? 0) > 0 || pending.thinkContent ? 1 : 0
  return thinkSegs + pending.toolCalls.length
}
