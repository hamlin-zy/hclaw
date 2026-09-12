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
  /** 会话级权限模式（主进程按 meta 固化 / 全局默认回退解析后下发；worker 仅应用内存，不落库） */
  permissionMode?: import('@shared/types').RunMode
  /**
   * 序列化的能力列表
   * 主进程序列化后传递给 Worker，Worker 直接使用，无需重新加载
   */
  capabilities?: SerializableCapabilities
  /** Agent 定义（子 Agent 独立会话使用） */
  agentDefinition?: import('@shared/agent').AgentDefinition
  /**
   * 跨轮任务恢复快照：Worker 启动时从 DB 活跃批次读取并下发，
   * Worker 侧 seed 回 taskStore（进程内存态每次运行全新，无恢复则
   * 新一轮对话中 task_update 找不到上一轮任务）。
   */
  taskBatchSnapshot?: {
    batch: { id: string; name: string; status: 'active' | 'completed' }
    tasks: import('@shared/types').Task[]
  } | null
}

// ─── 内部类型 ─────────────────────────────────────────

interface WorkerEntry {
  worker: import('worker_threads').Worker
  conversationId: string
  abortController: AbortController
}

// 导出给外部使用
export type {WorkerEntry}

/**
 * ★ 内存优化 C1：pending 态工具调用。
 * 在共享 ToolCall 基础上增加纯内存标记 resultDurable——仅由主进程 AgentManager 使用，
 * 绝不落库（persistence record* 与 messageBlockHelper 白名单均显式剥离），故不是
 * @shared/types 的 ToolCall 契约的一部分。
 */
export type PendingToolCall = ToolCall & {
  /**
   * ★ 内存优化 C1：该工具调用的 result 已成功落库（收到 message-flushed ACK）后收缩为摘要。
   * 置位后 result 不再持有 output/toolResult/diff/artifacts 全文，释放主进程峰值内存。
   */
  resultDurable?: boolean
}

export interface PendingAssistantMsg {
  id: string
  content: string
  /** 方案 C：text 段内累积（惰性 join，消除 O(n²) 拼接）；finalizePending 时清空 */
  contentParts?: string[]
  /** 正文累积长度（O(1) 计数）——★ tool_use textOffset 派生依赖，替代 content.length */
  contentLength: number
  toolCalls: PendingToolCall[]
  thinkContent: string | null
  /** 方案 C：thinking 段内累积（对称 text） */
  thinkParts?: string[]
  thinkLength?: number
  timestamp: number

  // ─── 快照 v2（统一恢复路径，spec §4.2）：以下状态原为渲染层独占内存态 ───
  /** toolCall 进度单值/百分比/ETA（原 toolCallsStore.states[].progress 等） */
  toolStates?: Record<string, ToolProgressState>
  /** 工具进度时间轴（原 progressLog，FIFO 上限 200 条/toolCall） */
  progressLog?: Record<string, ProgressEntry[]>
  /** 子 Agent 流缓冲（原 subAgentStream，上限 500 条/taskId） */
  subAgentStream?: Record<string, SubAgentStreamEntry[]>
  /** ask_user 阻塞态（丢失会导致 agent 卡死等输入，spec §4.2 第 1 点） */
  pendingQuestion?: {question: string; options?: string[]; multiSelect?: boolean; requestId?: string} | null
  /** permission_confirm 阻塞态 */
  pendingPermissionConfirm?: {question: string; requestId?: string} | null
  /** tools 变动确认阻塞态（丢失会导致刷新后弹窗不重现、agent 永久等待决策） */
  pendingToolsChangeConfirm?: {requestId: string; added: string[]; removed: string[]} | null
}

export interface ToolProgressState {
  progress?: string
  progressPercent?: number
  eta?: number
  detailStatus?: 'queued' | 'running' | 'completed' | 'failed'
}

export interface ProgressEntry {
  time: number
  text: string
}

export interface SubAgentStreamEntry {
  type: string
  text: string
  ts: number
}

/** 压缩消息持久化事件 */
export interface CompactPersistEvent {
  messages: ChatMessage[]
  beforeTokens: number
  afterTokens: number
  savedTokens: number
  message: string
}