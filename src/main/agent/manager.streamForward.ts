/**
 * Agent 流事件 → 渲染进程转发载荷构造
 *
 * 从 manager.impl.ts 的 forwardToRenderer 提取的纯函数模块：
 * - 职责：构造 webContents.send('agent-stream') 的载荷
 * - llm_call_done 瘦身：渲染端 handleLlmCallDone 只用 stats 字段，
 *   messages/systemPrompt/inputContent/outputContent/toolCalls 等大字段
 *   每轮经 worker→主进程→渲染进程全链 IPC 传输是纯浪费（sdd 长任务几十上百轮持续放大）。
 * - 注意：LLM 日志窗口消费的是 worker→主进程原始事件（logLlmCall 在 handleStreamEvent
 *   中直接取走，走独立 llm-call-log 通道），不受此处瘦身影响。
 */

import type {AgentStreamEvent} from './stream'

/** llm_call_done 渲染端实际消费的字段（handleLlmCallDone / llmStats 展示） */
export function trimLlmCallDoneForRenderer(
  event: Extract<AgentStreamEvent, {type: 'llm_call_done'}>,
): Extract<AgentStreamEvent, {type: 'llm_call_done'}> {
  return {
    type: 'llm_call_done',
    conversationTitle: event.conversationTitle,
    provider: event.provider,
    model: event.model,
    duration: event.duration,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cacheReadTokens: event.cacheReadTokens,
    cacheWriteTokens: event.cacheWriteTokens,
    reasoningTokens: event.reasoningTokens,
  }
}

/** 构造转发到渲染进程的 agent-stream 载荷（llm_call_done 自动瘦身） */
export function createForwardPayload(conversationId: string, event: AgentStreamEvent): {
  conversationId: string
  event: AgentStreamEvent
} {
  const forwardEvent = event.type === 'llm_call_done'
    ? trimLlmCallDoneForRenderer(event as Extract<AgentStreamEvent, {type: 'llm_call_done'}>)
    : event
  return {conversationId, event: forwardEvent}
}
