/**
 * AgentManager 类型定义
 */

import type {AgentStreamEvent} from './stream'
import type {ToolCall} from '@shared/types'
import type {ChatMessage, ModelConfig} from './model/types'
import type {SerializableCapabilities} from '../common/capabilitySerializer'

// ─── 公开类型 ──────────────────────────────────────────

/** AsyncGenerator 类型，用于将回调式流事件转为异步迭代器 */
export type AgentStreamGenerator = AsyncGenerator<AgentStreamEvent>

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
  /** 会话级模型 override（由主进程解析后传给 Worker；null=显式 auto） */
  modelOverride?: import('@shared/types').ModelOverride | null
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
  /** Agent 定义（子 Agent 独立会话使用） */
  agentDefinition?: import('@shared/agent').AgentDefinition
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
  /** 方案 C：text 段内累积（惰性 join，消除 O(n²) 拼接）；finalizePending 时清空 */
  contentParts?: string[]
  /** 正文累积长度（O(1) 计数）——★ tool_use textOffset 派生依赖，替代 content.length */
  contentLength: number
  toolCalls: ToolCall[]
  thinkContent: string | null
  /** 方案 C：thinking 段内累积（对称 text） */
  thinkParts?: string[]
  thinkLength?: number
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