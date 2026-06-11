/**
 * AgentManager 类型定义
 */

import type {AgentStreamEvent} from './stream'
import type {AgentTemplate, LlmCallLog, Message, SystemSettings, ToolCall} from '@shared/types'
import type {ChatMessage, ModelConfig} from './model/types'
import type {SerializableCapabilities} from '../common/capabilitySerializer'

// ─── 公开类型 ──────────────────────────────────────────

export interface AgentStartParams {
  conversationId: string
  messages: ChatMessage[]
  messageAttachments?: Array<{ path: string; name: string }>
  /** 消息元数据（如命令模板等），用于 Agent Loop 识别命令模式 */
  messageMetadata?: Record<string, unknown>
  modelConfig: ModelConfig
  workingDir: string
  maxTurns?: number
  customInstructions?: string
  skills?: string[]
  mcpServers?: import('@shared/types').MCPServer[]
  /** 可用的 Agent 模板列表 */
  agentTemplates?: import('@shared/types').AgentTemplate[]
  /** 模型方案配置 */
  schemeConfig?: {
    scheme: import('@shared/types').ModelScheme
    providers: import('@shared/types').LLMProvider[]
  }
  /** 会话标题 */
  conversationTitle?: string
  /** 工作模式（不传则使用默认值 'work'） */
  workMode?: string
  /**
   * 序列化的能力列表
   * 主进程序列化后传递给 Worker，Worker 直接使用，无需重新加载
   */
  capabilities?: SerializableCapabilities
  /**
   * Hook 执行后注入的额外上下文
   * 来自 SessionStart/UserPromptSubmit hook 的 additionalContext
   * 会在 LLM 调用时注入到消息中（历史消息之后，用户消息之前）
   */
  hookAdditionalContext?: string
}

// ─── 内部类型 ─────────────────────────────────────────

interface WorkerEntry {
  worker: import('worker_threads').Worker
  conversationId: string
  abortController: AbortController
}

// 导出给外部使用
export type {WorkerEntry}

export interface PendingAssistantMsg {
  id: string
  content: string
  toolCalls: ToolCall[]
  thinkContent: string | null
  timestamp: number
}

/** 压缩消息持久化事件 */
export interface CompactPersistEvent {
  messages: ChatMessage[]
  beforeTokens: number
  afterTokens: number
  savedTokens: number
  message: string
}