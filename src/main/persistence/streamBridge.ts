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

// ── 块 id 轮次派生（2026-09-22 修复：废除段号漂移）────────────────────────
// 契约（冻结）：text 块 id = `text-${msgId}-t${turn}`；think 块 id = `think-${msgId}-t${turn}`。
// 一次 LLM 调用（= 一个 turnIndex）内：think 恒为一个块、text 恒为一个块，先后由同轮内
// 首次 INSERT 顺序决定。
// 废除项（原 P5 段号机制）：thinkSegByMsg / lastWasThinking —— 段号随 text 事件漂移，
// 使一段连续思考被 text 切成 think-…-12 / think-…-13，text 块后缀（段号 + toolCalls 数）
// 随之漂移，同一段正文被切成 text-…-31 / text-…-32 → 重启后 think 尾部碎片插进正文中间。
//
// 段累积保留（think 块是同 id 覆盖语义，必须累积后整体写），但重置边界由「转出 think 态」
// 改为「轮次边界」：同轮内 think→text→think 交错必须继续累加，否则覆盖写会丢掉前半段思考。
const thinkAccumByMsg = new Map<string, string>()        // msgId → 当前轮内 think 增量累积
const thinkAccumTurnByMsg = new Map<string, number>()    // msgId → 累积所属轮次

// ── 方案 2 根治：LLM 调用轮次标注（turnIndex）────────────────────────────
// 契约：一次 LLM 调用 = 一个 turnIndex。tool_result/tool_denied 必然是一次
// 调用的收尾，其后首个 thinking/text 块开启下一轮；同轮内 think→text→think
// 交错不递增。此前 turnIndex 由 manager 传入且仅在 user_message_injected 时
// 递增，容器消息内多次 LLM 调用全部 undefined → DB turn_index 全 NULL →
// historyConverter 恒走 think 边界切段 fallback，单轮多段 think 被过度拆分
// 为 stub assistant → 重建序列 ≠ loop 内存态 → KV cache 断裂。
const turnSeqByMsg = new Map<string, number>()           // msgId → 当前轮次
const contentAfterToolByMsg = new Set<string>()          // msgId → tool_result 后已有内容块
// 双通道重复投递防护：toolExecutor.execute 既 events.push(tool_start)（随
// execEvents 延迟 yield）又 onEvent 即时推送，且 executeToolCalls 在所有工具
// 结束后才 yield execEvents → 第二份 tool_start 落在 tool_completed（closeTurn
// 置标记）之后 → turnForContent 消费标记 → tool 块 turn_index 虚高 1 → 重建时
// text/think 与 tool_use 拆成两条 assistant → 跨 turn 前缀分叉 → 缓存断裂。
// 同一 msgId 的同一 toolCallId 只落一次块。
const persistedToolCallIds = new Map<string, Set<string>>()

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

/**
 * 释放「已跨轮」的 think 段累积（累积所属轮次 ≠ 当前轮次时）。
 * 同类重置的唯一出口：thinking 分支进入新轮时、以及 text/tool 事件转出 think 态时共用。
 */
function releaseStaleThinkAccum(msgId: string): void {
  const turn = thinkAccumTurnByMsg.get(msgId)
  if (turn === undefined || turn === currentTurn(msgId)) return
  thinkAccumByMsg.delete(msgId)
  thinkAccumTurnByMsg.delete(msgId)
}

/**
 * 转出 thinking 态（text / tool_use / tool_result / tool_denied 4 个分支共用）：
 * 释放已跨轮的段累积。
 * ★ 契约变更（块 id 轮次派生）：释放边界从「转出 think 态」改为「轮次边界」——
 *   同轮内 think→text→think 交错必须保留累积（think 块同 id 覆盖写，重置即丢前文）；
 *   tool_result/tool_denied 收尾后由 turnForContent 递增轮次，下一次转出时随之释放。
 * ★ 本函数不再参与任何块 id 派生（旧实现中段号 +1 在此触发）。
 */
function endThinking(msgId: string): void {
  releaseStaleThinkAccum(msgId)
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
  switch (event.type) {
    case 'text': {
      const chunk = (event as {type: 'text'; content?: string}).content || ''
      // ★ turnForContent 有副作用（消费 tool_result 标记、可能递增轮次）→ 同一事件只调用一次
      const turn = turnForContent(msgId)
      if (chunk) p.recordTextChunk(convId, msgId, `t${turn}`, chunk, turn)
      endThinking(msgId)   // 释放已跨轮的段累积（同轮保留 → 正文恒为一块）
      break
    }
    case 'thinking': {
      // ★ turnForContent 有副作用 → 同一事件只调用一次
      const turn = turnForContent(msgId)
      // 轮次变化才重置段累积（旧「段起始守卫 + 段号 +1」的替代）
      releaseStaleThinkAccum(msgId)
      // ★ 轮内增量累积，而非 pending.thinkParts.join('') 全量快照：
      //   thinkParts 是整条消息（跨所有 LLM 调用轮）的 UI 聚合，每轮写一份
      //   全量快照会使 historyConverter 按 turn 分组拼接后每轮 reasoningContent
      //   都携带之前所有轮的 thinking → 重建请求 input 暴涨（74.6k→151k tokens）。
      //   轮内累积（delta 之和）与 loop 内存态 execute.ts thinkingParts.join('')
      //   （每轮增量）逐字节一致：同 turn 的 think 增量之和 = 该轮全部 thinking。
      const delta = (event as {content?: string}).content || ''
      const accum = (thinkAccumByMsg.get(msgId) ?? '') + delta
      thinkAccumByMsg.set(msgId, accum)
      thinkAccumTurnByMsg.set(msgId, turn)
      if (accum) p.recordThinkBlock(convId, msgId, `think-${msgId}-t${turn}`, accum, 'thinking', turn)
      break
    }
    case 'tool_use':
    case 'tool_start': {
      const tc = (event as {toolCall?: ToolCallPersistable}).toolCall
      if (!tc) break
      // 双通道重复投递防护：同 id 只落一次（重复事件不得再次消费 turn 标记）
      let seen = persistedToolCallIds.get(msgId)
      if (!seen) {
        seen = new Set<string>()
        persistedToolCallIds.set(msgId, seen)
      }
      if (seen.has(tc.id)) break
      seen.add(tc.id)
      endThinking(msgId)   // 转出 think 态：释放已跨轮的段累积（同轮保留）
      // 契约补全：LLM 调用可能只返回 tool_calls（零 thinking/text），
      // 此时 tool_use 也处于 tool_result 之后 → 必须开启新轮，否则该调用的
      // tool_call 块沿用上一轮 turnIndex，重建时并入上一组 assistant，
      // 序列与 loop 内存态分叉 → 跨 turn 首请求 KV cache 断裂。
      p.recordToolCallBlock(convId, msgId, {...tc, status: tc.status ?? 'running'}, turnForContent(msgId))
      break
    }
    case 'tool_result':
    case 'tool_completed': {
      const ev = event as {toolCallId?: string; result?: unknown}
      const tc = pending.toolCalls.find(t => t.id === ev.toolCallId)
      if (!tc) break
      endThinking(msgId)   // 转出 think 态：释放已跨轮的段累积（同轮保留）
      // 终态修复语义（conversationStore.ts:267-271 平移）：result 由事件携带；
      // manager 私有 accumulateEvent 双轨已把 normalized result 写回 pending.toolCalls，
      // 桥接以事件优先（pending 未及更新时仍能落终态）。
      // ★ 内存优化 C1：tc.resultDurable 为真说明 tc.result 已被收缩为摘要（全文已落库），
      //   此时绝不可用摘要作回退——否则会把 {success,error} 摘要写进 tool_result 块，
      //   污染「loop=存储=重建」逐字节契约。回退返回 undefined → 走下方 break（不写库）。
      //   正常路径下 tool_result/tool_completed 事件结构上必带 result，回退仅为防御性。
      const result = ev.result ?? (tc.resultDurable ? undefined : tc.result)
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
      endThinking(msgId)   // 转出 think 态：释放已跨轮的段累积（同轮保留）
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

/** 消息终结时清理桥接段累积与轮次状态（7.2：finalize 为必然事件触发，finalizeMessage 成功路径调用） */
export function resetBridgeMsgState(msgId: string): void {
  thinkAccumByMsg.delete(msgId)
  thinkAccumTurnByMsg.delete(msgId)
  turnSeqByMsg.delete(msgId)
  contentAfterToolByMsg.delete(msgId)
  persistedToolCallIds.delete(msgId)
}

/** text 段序号 = 已出现的非 text 块数(对齐 conversationStore.ts:216-221 语义)。
 *  think 段数: pending 有 think 内容即 1 段；若 manager 引入多 think 段累积须同步改段计数。
 *  ★ 核验结论（2026-09-22 块 id 轮次派生）：本函数不参与块 id 派生——生产代码 0 调用点
 *  （仅 tests/main/conversationPersistence.test.ts 引用；manager.impl.ts:1427 为注释提及），
 *  且全量写路径的 text 块 id 为 offset 型 `${msgId}-text-${offset}`（messageBlockHelper.ts:105）、
 *  与增量路径（桥接）已无共享 id 空间。故保持不动。 */
export function deriveTextSeq(pending: PendingAssistantMsg): number {
  const thinkSegs = (pending.thinkParts?.length ?? 0) > 0 || pending.thinkContent ? 1 : 0
  return thinkSegs + pending.toolCalls.length
}
