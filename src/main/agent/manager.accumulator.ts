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
import type {PendingAssistantMsg} from './manager.types'

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
 * #mergeAndPersist（user_message_injected / done / error）与
 * extractLastLoopMessages（done-completed，且发生在 #mergeAndPersist 之后），
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
 * 累积流事件到主进程消息缓存
 * 与渲染器的 handleStreamEvent 保持逻辑一致，但不依赖 UI 状态
 */
export function accumulateStreamEvent(
  pending: PendingAssistantMsg | null,
  conversationId: string,
  event: AgentStreamEvent,
  pendingNeedsTurnReset: Set<string>,
): PendingAssistantMsg | null {
  const hasTurnReset = pendingNeedsTurnReset.has(conversationId)

  switch (event.type) {
    case 'agent_start': {
      pendingNeedsTurnReset.delete(conversationId)
      break
    }
    case 'text': {
      const content = event.content || ''

      if (hasTurnReset) {
        pending = null
      }

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
      // 本轮 tool result 已处理完毕，下一次 text 事件是新回合的开始
      pendingNeedsTurnReset.add(conversationId)
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

    default:
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