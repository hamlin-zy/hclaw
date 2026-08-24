/**
 * AgentManager 消息累积器
 * 
 * 负责将流式事件累积到主进程消息缓存（pendingAssistantMsg），
 * 为后续持久化到 SQLite 做准备。
 */

import crypto from 'node:crypto'
import {logger} from './logger'
import {PENDING_MSG_MAX_BYTES} from './manager.constants'
import {formatToolResult} from '@shared/utils/toolResult'
import type {AgentStreamEvent} from './stream'
import type {
    PendingAssistantMsg,
    ProgressEntry,
    SubAgentStreamEntry,
    ToolProgressState,
} from './manager.types'

/**
 * 方案 C：段内数组追加 + O(1) 长度计数；超限时截断末段。
 * 原地修改 parts，返回追加后的长度与是否发生截断（供调用方记录日志）。
 * 截断语义与旧 capField（逐字 slice 到 maxBytes）保持一致。
 */
export function appendCappedPart(
  parts: string[],
  chunk: string,
  length: number,
  maxBytes: number,
): {length: number; truncated: boolean} {
  parts.push(chunk)
  length += chunk.length
  if (length <= maxBytes) {
    return {length, truncated: false}
  }
  const overflow = length - maxBytes
  const last = parts[parts.length - 1]
  parts[parts.length - 1] = last.slice(0, Math.max(0, last.length - overflow))
  return {length: maxBytes, truncated: true}
}

/**
 * 方案 C：惰性拼接完成 —— join parts → content/thinkContent，清空 parts，返回原引用。
 *
 * 契约（重要）：finalize 之后 pending 不应再继续累积 text/thinking。
 * contentParts/thinkParts 已在此被清空，而 content/thinkContent 不参与后续累积，
 * 若 finalize 后再 push 并二次 finalize，新段会覆盖旧的 content/thinkContent。
 *
 * 当前调用图保证该契约成立：finalize 仅在终态路径触发——
 * #mergeAndPersist（user_message_injected / done / error），
 * 之后 pending 被置 null 或 worker 结束，不会再有后续 text/thinking 事件。
 *
 * 幂等性：parts 为空时原样返回，重复调用安全。contentLength 不重置——
 * 它仅用于累积阶段的 tool_use textOffset 派生，finalize 后不再参与 content 语义。
 */
export function finalizePending(pending: PendingAssistantMsg): PendingAssistantMsg {
  if (pending.contentParts && pending.contentParts.length > 0) {
    pending.content = pending.contentParts.join('')
    pending.contentParts = []
  }
  if (pending.thinkParts && pending.thinkParts.length > 0) {
    pending.thinkContent = pending.thinkParts.join('')
    pending.thinkParts = []
  }
  return pending
}

/**
 * 幽灵消息双写防御：渲染端已落库消息的文本指纹与主进程 pending 内容是否一致。
 *
 * nearbyText 为渲染端消息 text blocks 拼接后的前 200 字符（调用方截断），
 * pendingContent 为主进程累积的完整内容（P0 跨段累积后即全文）。
 * 判定规则（前缀包含关系，任一方向）：
 * - pendingContent 以 nearbyText 开头 → 渲染端部分落库（崩溃丢尾）→ 匹配，
 *   调用方 repairTextTail 补齐缺口
 * - nearbyText 以 pendingContent 开头 → DB 反超（容量截断等异常）→ 匹配，
 *   调用方 repair 因 dbLen ≥ fullLen 幂等跳过
 * - nearbyText 为空（渲染端占位无内容）→ 不匹配（防误杀，避免把空占位当已落库）
 * - pendingContent 为空 → 不匹配（防空前缀匹配一切）
 */
export function isRenderedCopyFingerprintMatch(nearbyText: string, pendingContent: string): boolean {
  if (nearbyText.length === 0 || pendingContent.length === 0) return false
  return pendingContent.startsWith(nearbyText) || nearbyText.startsWith(pendingContent)
}

/**
 * 累积流事件到主进程消息缓存
 * 与渲染器的 handleStreamEvent 保持逻辑一致，但不依赖 UI 状态
 *
 * @param registeredMsgId 渲染端已创建的空占位消息 id（ensureStreamingMessage 上报）。
 *   新建 pending（含 turn reset 重建）时复用该 id，确保主进程 pending 与渲染端
 *   流式消息 id 一致——否则 #mergeAndPersist 全量写兜底会以独立 id 产生幽灵副本
 *   （"所有助手消息渲染 2 份"根因，见 tasks/03-duplicate-assistant-bubbles.md）。
 */
export function accumulateStreamEvent(
  pending: PendingAssistantMsg | null,
  conversationId: string,
  event: AgentStreamEvent,
  registeredMsgId?: string,
): PendingAssistantMsg | null {
  switch (event.type) {
    case 'text': {
      const content = event.content || ''

      // ★ 崩溃落库修复：turn reset 不再丢弃已累积正文。旧逻辑在此置 pending=null，
      //   导致主进程任何时刻只持有最后一段文本——渲染进程崩溃时保险丝
      //   #mergeAndPersist 无法补齐 DB 缺口，未 flush 的增量永久丢失。
      //   跨段累积后 pending.content 即全文基准，contentLength/toolCalls/thinkParts
      //   均持续累计（toolCalls 按 id 去重；容量上限由 appendCappedPart 保证）。

      if (!content && !pending) {
        return null
      }
      if (!pending) {
        pending = createPendingMsg()
      }
      // ★ 方案 C：段内数组累积 + O(1) 计数；capField 截断语义保持（超限截当前段）
      pending.contentParts = pending.contentParts || []
      const {length, truncated} = appendCappedPart(
        pending.contentParts, content, pending.contentLength, PENDING_MSG_MAX_BYTES,
      )
      pending.contentLength = length
      if (truncated) {
        logger.warn('[AgentManager] pendingAssistantMsg 内容超过容量上限，已截断', {
          maxBytes: PENDING_MSG_MAX_BYTES,
        })
      }
      break
    }

    case 'thinking': {
      const thinkChunk = event.content || ''
      if (!pending) {
        pending = createPendingMsg()
      }
      pending.thinkParts = pending.thinkParts || []
      const {length, truncated} = appendCappedPart(
        pending.thinkParts, thinkChunk, pending.thinkLength || 0, PENDING_MSG_MAX_BYTES,
      )
      pending.thinkLength = length
      if (truncated) {
        logger.warn('[AgentManager] pendingAssistantMsg thinkContent 超过容量上限，已截断', {
          maxBytes: PENDING_MSG_MAX_BYTES,
        })
      }
      break
    }

    case 'tool_use':
    case 'tool_start': {
      const tc = event.toolCall
      if (!tc) {
        break
      }
      if (!pending) {
        pending = createPendingMsg()
      }
      // 避免重复添加同 id 的 toolCall
      const exists = pending.toolCalls.find(t => t.id === tc.id)
      if (!exists) {
        pending.toolCalls.push({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
          status: 'running',
          textOffset: pending.contentLength,
          reason: tc.reason,
          terminal: tc.terminal,
        })
      }
      break
    }

    case 'tool_result': {
      if (!pending || !event.toolCallId) {
        break
      }
      const idx = pending.toolCalls.findIndex(t => t.id === event.toolCallId)
      if (idx === -1) {
        break
      }
      const result = normalizeToolResult(event.result)
      const tc = pending.toolCalls[idx]
      pending.toolCalls[idx] = {
        ...tc,
        status: result.success ? 'success' : 'error',
        result,
        // ★ 需求1链路：agent 工具从 result._meta 恢复子会话 ID（taskId === childConvId）
        //   与 manager.impl.ts 私有 accumulateEvent 保持逻辑一致（双轨）
        ...(tc.name === 'agent' && result._meta?.childConvId
          ? {taskId: result._meta.childConvId as string}
          : {}),
      }
      break
    }

    case 'tool_completed': {
      // 与 tool_result 同构（stream.ts 中两者并存；completed 由工具执行器主动上报）
      if (!pending || !event.toolCallId) break
      const idx = pending.toolCalls.findIndex(t => t.id === event.toolCallId)
      if (idx === -1) break
      const normalized = normalizeToolResult(event.result)
      pending.toolCalls[idx] = {
        ...pending.toolCalls[idx],
        status: normalized.success ? 'success' : 'error',
        result: normalized,
      }
      break
    }

    case 'tool_denied': {
      if (!pending || !event.toolCallId) {
        break
      }
      const idx = pending.toolCalls.findIndex(t => t.id === event.toolCallId)
      if (idx === -1) {
        break
      }
      const deniedReason = `[PERMISSION_DENIED] ${event.reason || '权限被拒绝'}`
      pending.toolCalls[idx] = {
        ...pending.toolCalls[idx],
        status: 'error',
        // 与 loop 内存态 createToolResultMessage 失败格式逐字节一致（含 [ERROR] 前缀）
        result: {
          output: '',
          error: deniedReason,
          toolResult: `[ERROR] ${deniedReason}`,
        },
      }
      break
    }

    // ─── 快照 v2（统一恢复路径）：以下状态原为渲染层独占内存态，主进程同步累积 ───

    case 'tool_progress': {
      if (!pending || !event.toolCallId) break
      const states = (pending.toolStates ??= {})
      states[event.toolCallId] = {...states[event.toolCallId], progress: event.progress}
      appendProgressEntry(pending, event.toolCallId, event.progress)
      break
    }

    case 'tool_detail': {
      if (!pending || !event.toolCallId) break
      const states = (pending.toolStates ??= {})
      states[event.toolCallId] = {
        ...states[event.toolCallId],
        ...(event.progress !== undefined ? {progressPercent: event.progress} : {}),
        ...(event.eta !== undefined ? {eta: event.eta} : {}),
        detailStatus: event.status,
      }
      break
    }

    case 'subagent_start': {
      if (!pending) pending = createPendingMsg()
      const streams = (pending.subAgentStream ??= {})
      const bucket = (streams[event.taskId] ??= [])
      bucket.push({type: 'start', text: event.description, ts: Date.now()})
      capSubAgentBucket(bucket)
      break
    }

    case 'subagent_progress': {
      if (!pending) pending = createPendingMsg()
      const streams = (pending.subAgentStream ??= {})
      const bucket = (streams[event.taskId] ??= [])
      bucket.push({type: event.subAgentEvent, text: event.progress ?? '', ts: Date.now()})
      capSubAgentBucket(bucket)
      break
    }

    case 'ask_user': {
      // 阻塞态入快照：崩溃恢复后若丢失会导致 agent 永久等待用户输入（spec §4.2）
      if (!pending) pending = createPendingMsg()
      pending.pendingQuestion = {
        question: event.question,
        options: event.options,
        multiSelect: event.multiSelect,
        requestId: event.requestId,
      }
      break
    }

    case 'permission_confirm': {
      if (!pending) pending = createPendingMsg()
      pending.pendingPermissionConfirm = {question: event.question, requestId: event.requestId}
      break
    }

    case 'done':
    case 'error': {
      // 终态清空阻塞态（正常路径由用户应答后的后续事件覆盖，此处为兜底防陈旧阻塞态复活）
      if (pending) {
        pending.pendingQuestion = null
        pending.pendingPermissionConfirm = null
      }
      break
    }

    default:
  }

  // ★ id 对齐：无论新建还是 turn reset 重建，pending 一律复用渲染端占位 id
  //   （幂等：pending 已存在时重设相同值无副作用）
  if (pending && registeredMsgId) {
    pending.id = registeredMsgId
  }

  return pending
}

/**
 * 创建新的 pending assistant 消息
 */
export function createPendingMsg(): PendingAssistantMsg {
  return {
    id: crypto.randomUUID(),
    content: '',
    contentLength: 0,
    toolCalls: [],
    thinkContent: null,
    timestamp: Date.now(),
    // 快照 v2 状态的安全默认值（渲染端免判空）
    toolStates: {},
    progressLog: {},
    subAgentStream: {},
    pendingQuestion: null,
    pendingPermissionConfirm: null,
  }
}

// ─── 快照 v2 辅助：进度时间轴 / 子 Agent 流缓冲 ──────────────

const PROGRESS_LOG_MAX = 200   // 对齐渲染端 progressLog 时间轴的合理驻留上限
const SUB_AGENT_STREAM_MAX = 500  // 对齐渲染端 toolCallsStore 上限（toolCallsStore.ts:153）

function appendProgressEntry(pending: PendingAssistantMsg, toolCallId: string, text: string): void {
  const log = (pending.progressLog ??= {})
  const arr = (log[toolCallId] ??= [])
  arr.push({time: Date.now(), text})
  if (arr.length > PROGRESS_LOG_MAX) arr.splice(0, arr.length - PROGRESS_LOG_MAX)
}

function capSubAgentBucket(bucket: SubAgentStreamEntry[]): void {
  if (bucket.length > SUB_AGENT_STREAM_MAX) bucket.splice(0, bucket.length - SUB_AGENT_STREAM_MAX)
}

// ─── 崩溃恢复流快照（P1） ──────────────────────────────────

/** 渲染进程崩溃重载后的流式状态快照（只读，供 recoverSessions 播种） */
export interface StreamSnapshot {
  streamingMessageId: string
  /** 跨段累积全文（与 #mergeAndPersist 保险丝同源） */
  content: string
  thinkContent: string | null
  toolCalls: PendingAssistantMsg['toolCalls']
  /**
   * DB 中该消息已有的 text 块数。渲染端以此为 textSeq 基线派生新块 id，
   * 防止恢复后 streamBlocks 清空导致 seq 从 0 重计、与旧块 id 碰撞
   * （碰撞 → UPDATE-append 进旧块 → 正文错序，done 时修补也无法纠正顺序）。
   */
  dbTextBlockCount: number

  // ─── 快照 v2（统一恢复路径，spec §4.2 状态覆盖面扩展）──────────
  /** toolCall 进度态（progress/percent/eta/detailStatus），键为 toolCallId */
  toolStates: Record<string, ToolProgressState>
  /** 工具进度时间轴，键为 toolCallId */
  progressLog: Record<string, ProgressEntry[]>
  /** 子 Agent 流缓冲，键为 taskId */
  subAgentStream: Record<string, SubAgentStreamEntry[]>
  /** ask_user 阻塞态（null = 无） */
  pendingQuestion: PendingAssistantMsg['pendingQuestion']
  /** permission_confirm 阻塞态（null = 无） */
  pendingPermissionConfirm: PendingAssistantMsg['pendingPermissionConfirm']
  /** 运行中工具数（由 toolCalls.status 派生，保证与列表自洽） */
  runningToolCount: number
  /**
   * 工具执行区提示文案。主进程不生成 UI 文案，恒为 null；
   * 渲染端 applySeed 时按 toolCalls 派生，字段保留以稳定快照契约
   */
  executingToolsMessage: null
}

/**
 * 构建活跃 pending 的只读快照。
 *
 * ★ 绝不调用 finalizePending——那会清空 contentParts/thinkParts，
 *   快照后到达的 text/thinking 事件将因 parts 被消费而丢段。
 *   此处以 join 只读拼接，pending 保持可继续累积。
 *
 * @returns pending 为 null 时返回 null（worker 在跑但尚无任何累积的边界）
 */
export function buildStreamSnapshot(pending: PendingAssistantMsg | null, dbTextBlockCount = 0): StreamSnapshot | null {
  if (!pending) return null
  return {
    streamingMessageId: pending.id,
    content: pending.contentParts?.join('') || pending.content || '',
    thinkContent: pending.thinkParts?.length
      ? pending.thinkParts.join('')
      : (pending.thinkContent ?? null),
    toolCalls: [...pending.toolCalls],
    dbTextBlockCount,
    // v2：浅拷贝防外部改写 pending 内部状态（保持只读契约）
    toolStates: {...(pending.toolStates ?? {})},
    progressLog: Object.fromEntries(
      Object.entries(pending.progressLog ?? {}).map(([k, v]) => [k, [...v]]),
    ),
    subAgentStream: Object.fromEntries(
      Object.entries(pending.subAgentStream ?? {}).map(([k, v]) => [k, [...v]]),
    ),
    pendingQuestion: pending.pendingQuestion ?? null,
    pendingPermissionConfirm: pending.pendingPermissionConfirm ?? null,
    // 由 toolCalls 状态派生，保证与列表永远自洽
    runningToolCount: pending.toolCalls.filter(t => t.status === 'running').length,
    executingToolsMessage: null,
  }
}

/**
 * 将 tool_result 事件中的 result 转为 ToolCall.result 格式
 *
 * ★ 缓存一致性契约：返回的 toolResult 必须与 loop 内存态 createToolResultMessage
 *   （formatToolResult）逐字节一致。它是 historyConverter 重建时回传的最终字符串，
 *   一致则跨 turn 重建后的 API 请求前缀与上一轮 loop 末逐 token 相同，最大化缓存命中。
 *
 * output 保持原始值（对象不强制 String 化，避免 [object Object] 丢失格式）；
 * toolResult 为格式化后的最终字符串（成功=输出/格式化 JSON，失败=[ERROR] 前缀）。
 */
export function normalizeToolResult(result: unknown): {
  success: boolean
  output: unknown
  error?: string
  toolResult: string
  artifacts?: Array<{
    filePath: string
    action: 'created' | 'modified' | 'deleted'
    content?: string
  }>
  diff?: string
  _meta?: Record<string, unknown>
} {
  if (!result) return {success: true, output: '', toolResult: ''}
  const r = result as Record<string, unknown>
  const success = r.success === true
  // 总是保留 output 内容，不因 success=false 丢弃（工具可能既有输出又有报错）
  const rawOutput = r.output
  // 字符串超限截断（仅字符串类型；对象交给 JSON 序列化后由 toolResult 侧统一处理）
  let output = rawOutput
  if (typeof rawOutput === 'string' && rawOutput.length > PENDING_MSG_MAX_BYTES) {
    logger.warn('[AgentManager] tool result 超过容量上限，已截断', {
      maxBytes: PENDING_MSG_MAX_BYTES,
      originalBytes: rawOutput.length,
    })
    output = rawOutput.slice(0, PENDING_MSG_MAX_BYTES) + '\n\n...(截断)'
  }
  return {
    success,
    output,
    error: r.error as string | undefined,
    // 与 createToolResultMessage / formatToolResult 完全一致（成功/失败统一格式）
    // success 判定与 createToolResultMessage 的 !result.success 等价（仅 true 视为成功）
    toolResult: formatToolResult({
      success,
      output,
      error: r.error as string | undefined,
    }),
    artifacts: r.artifacts as Array<{
      filePath: string
      action: 'created' | 'modified' | 'deleted'
      content?: string
    }> | undefined,
    diff: r.diff as string | undefined,
    // ★ 透传 _meta（如 agent 工具的 childConvId），供 tool_result 分支恢复 taskId
    ...(r._meta ? {_meta: r._meta as Record<string, unknown>} : {}),
  }
}