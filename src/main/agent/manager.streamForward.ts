/**
 * Agent 流事件 → 渲染进程转发载荷构造
 *
 * 从 manager.impl.ts 的 forwardToRenderer 提取的纯函数模块：
 * - 职责：构造 webContents.send('agent-stream') 的载荷
 * - llm_call_done 瘦身：渲染端 handleLlmCallDone 只用 stats 字段，
 *   messages/systemPrompt/inputContent/outputContent/toolCalls 等大字段
 *   每轮经 worker→主进程→渲染进程全链 IPC 传输是纯浪费（sdd 长任务几十上百轮持续放大）。
 * - 注意：LLM 日志窗口消费的是 llm-trace 落盘记录（llmTraceRecorder），
 *   不受此处瘦身影响。
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
    providerType: event.providerType,   // 新增
    providerName: event.providerName,   // 新增：providers 表服务商名
    providerId: event.providerId,   // providers.id（稳定维度，用量归因）
    model: event.model,
    duration: event.duration,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cacheReadTokens: event.cacheReadTokens,
    cacheWriteTokens: event.cacheWriteTokens,
    reasoningTokens: event.reasoningTokens,
    ttftMs: event.ttftMs,
    decodeMs: event.decodeMs,
    tokensPerSecond: event.tokensPerSecond,
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

/**
 * 从 worker error 消息中提取真实错误信息。
 *
 * worker.ts 发送的错误结构为 { type:'error', conversationId, event:{type:'error', error: err.message} }，
 * 错误信息在 msg.event.error；顶层 msg.error 是旧格式兜底。
 * 此前只读 msg.error → undefined → 回退 'Worker error'，真实错误被吞掉。
 *
 * 三级回退：event.error → 顶层 error → 'Worker error'（最终兜底文案）
 */
export function extractWorkerErrorMessage(msg: { event?: { error?: string }; error?: string } | null | undefined): string {
  return msg?.event?.error || msg?.error || 'Worker error'
}
