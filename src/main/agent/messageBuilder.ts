/**
 * 唯一消息构建者（设计 §2）：
 * Message 只在此构建——loop / memo / handoff / channel 全部复用。
 * 不碰 DB、不碰节流。
 * 附件单一形态：只写顶层 msg.attachments（形状由 toMessageAttachments 统一：
 * {id, name, type, size, path, isImage}）；metadata 不承载附件业务
 * （metadata.attachments 读侧兼容仅为历史数据，见 messageBlockHelper.ts 序列化注释）。
 */
import crypto from 'node:crypto'
import type {Message} from '../../shared/types'
import {toMessageAttachments} from './utils/userContentBuilder'

export interface BuildUserMessageInput {
  convId: string
  text: string
  /** R5：可选预置 id（sessionHandoffTool 的 userMsgId 需先于 requestHandoffStart 生成） */
  id?: string
  attachments?: Array<{path: string; name: string}>
  agentName?: string
  metadata?: Record<string, unknown>
}

export async function buildUserMessage(input: BuildUserMessageInput): Promise<Message> {
  // ★ P1：content 恒为纯文本（Message.content: string）。
  //   多模态 LLM 腿不在落库对象上：首轮注入由 startAgentCore.buildUserMessageContent
  //   构建（保留原处，裁决 R3）；历史重建由 convertUserHistoryMessage 从 attachments 读时重建。
  //   两腿同源 = attachments 单一来源。
  const attachments = input.attachments?.length ? toMessageAttachments(input.attachments) : undefined
  const msg = {
    id: input.id ?? crypto.randomUUID(),
    role: 'user' as const,
    content: input.text,
    timestamp: Date.now(),
    ...(input.agentName ? {agentName: input.agentName} : {}),
    ...(input.metadata ? {metadata: input.metadata} : {}),
    ...(attachments?.length ? {attachments} : {}),
  } as Message
  return msg
}
