/**
 * AgentManager 消息累积器
 * 
 * 负责将流式事件累积到主进程消息缓存（pendingAssistantMsg），
 * 为后续持久化到 SQLite 做准备。
 */

import crypto from 'node:crypto'
import {logger} from './logger'
import {PENDING_MSG_MAX_BYTES} from './manager.constants'
import type {AgentStreamEvent} from './stream'
import type {PendingAssistantMsg} from './manager.types'

/** 截断字符串到上限，超出则记录警告 */
function capField(value: string, label: string, conversationId: string): string {
  if (value.length <= PENDING_MSG_MAX_BYTES) return value
  logger.warn(`[AgentManager] pendingAssistantMsg ${label} 超过容量上限，已截断`, {
    conversationId, maxBytes: PENDING_MSG_MAX_BYTES,
  })
  return value.slice(0, PENDING_MSG_MAX_BYTES)
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
      pending.content = capField(pending.content + content, '内容', conversationId)
      break
    }

    case 'thinking': {
      const thinkChunk = event.content || ''
      if (!pending) {
        pending = createPendingMsg()
      }
      pending.thinkContent = capField(
        (pending.thinkContent || '') + thinkChunk, 'thinkContent', conversationId,
      )
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
          textOffset: pending.content.length,
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
      pending.toolCalls[idx] = {
        ...pending.toolCalls[idx],
        status: result.output && !result.error ? 'success' : 'error',
        result,
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
      pending.toolCalls[idx] = {
        ...pending.toolCalls[idx],
        status: 'error',
        result: {output: '', error: event.reason || '权限被拒绝'},
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
    toolCalls: [],
    thinkContent: null,
    timestamp: Date.now(),
  }
}

/**
 * 将 tool_result 事件中的 result 转为 ToolCall.result 格式
 */
export function normalizeToolResult(result: unknown): {
  output: string
  error?: string
  artifacts?: Array<{
    filePath: string
    action: 'created' | 'modified' | 'deleted'
    content?: string
  }>
  diff?: string
} {
  if (!result) return {output: ''}
  const r = result as Record<string, unknown>
  let output = r.success ? String(r.output ?? '') : ''
  if (output.length > PENDING_MSG_MAX_BYTES) {
    logger.warn('[AgentManager] tool result 超过容量上限，已截断', {
      maxBytes: PENDING_MSG_MAX_BYTES,
      originalBytes: output.length,
    })
    output = output.slice(0, PENDING_MSG_MAX_BYTES) + '\n\n...(截断)'
  }
  return {
    output,
    error: r.error as string | undefined,
    artifacts: r.artifacts as Array<{
      filePath: string
      action: 'created' | 'modified' | 'deleted'
      content?: string
    }> | undefined,
    diff: r.diff as string | undefined,
  }
}