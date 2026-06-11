/**
 * Agent stream events, tool lifecycle events, and stream payload types.
 *
 * Layer 3 — depends on message (Task, ToolCallInfo) and model (IntentAnalysisResult).
 */

import type { Task, ToolCallInfo } from './message'
import type { IntentAnalysisResult } from './model'

// ─── Agent start / progress / detail ──────────────────

/** Agent 启动事件 */
export interface AgentStartEvent {
  type: 'agent_start'
  agentType: string
  agentId: string
  model: string
  tools: string[]
  isolation?: string
}

/** Agent 进度事件 */
export interface AgentProgressEvent {
  type: 'agent_progress'
  agentId: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  totalTokens: number
  toolUseCount: number
  currentTool?: string
  currentActivity?: string
}

/** 工具详细状态 */
export interface ToolDetailEvent {
  type: 'tool_detail'
  toolCallId: string
  toolName: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  progress?: number
  eta?: number
}

// ─── Agent state ───────────────────────────────────────

export interface AgentState {
  status: 'idle' | 'thinking' | 'running' | 'paused' | 'error'
  /**
   * Agent 运行阶段细分，用于 UI 精细化状态提示
   * - idle: 空闲
   * - starting: 已发起 agentStart，IPC 调用中，等待首个事件
   * - streaming: LLM 流式响应中（thinking / text）
   * - executing_tools: 工具执行中
   * - waiting_for_response: 工具执行完毕，等待 LLM 恢复
   */
  phase: 'idle' | 'starting' | 'streaming' | 'executing_tools' | 'waiting_for_response' | 'responding'
  mode: 'auto'
  currentTask?: string
  progress?: number
  currentModelName?: string
  currentModelProvider?: string
}

// ─── Agent stream event ────────────────────────────────

export interface AgentStreamEvent {
  type:
    | 'begin' | 'text' | 'thinking'
    | 'tool_start' | 'tool_progress' | 'tool_result' | 'tool_denied'
    | 'done' | 'error'
    | 'ask_user' | 'permission_confirm'
    | 'subagent_start' | 'subagent_progress' | 'subagent_done'
    | 'tasks_update'
    | 'skill_matched' | 'skill_start' | 'skill_phase' | 'skill_reference_loaded'
    | 'skill_script_start' | 'skill_script_output' | 'skill_script_done'
    | 'skill_log' | 'skill_end'
    | 'llm_call_done' | 'intent_analyzed' | 'mode_change'
    | 'context_compacted' | 'compact_status'
    | 'permission-rules-updated'
    | 'agent_start' | 'agent_progress' | 'tool_detail' | 'tool_use'
    | 'settings-updated' | 'app-restart'
  content?: string
  /** settings-updated 事件的配置数据 */
  settings?: Record<string, any>
  toolCall?: ToolCallInfo
  toolCallId?: string
  progress?: string
  result?: { success: boolean; output: unknown; error?: string }
  reason?: 'completed' | 'aborted' | 'error'
  error?: string
  question?: string
  options?: string[]
  multiSelect?: boolean
  requestId?: string
  // Sub-Agent 字段
  taskId?: string
  description?: string
  subAgentEvent?: string
  /** 子 Agent 的执行进度描述 */
  subAgentProgress?: string
  success?: boolean
  output?: string
  // Tasks 字段
  tasks?: Task[]
  // Skill 字段
  skillId?: string
  skillName?: string
  skillReason?: string
  skillStatus?: 'matched' | 'loading' | 'executing' | 'done' | 'error'
  skillPhase?: string
  skillProgress?: { current: number; total: number; label?: string }
  skillReferences?: { loaded: string[]; pending?: string[] }
  skillScript?: { name: string; status: 'pending' | 'running' | 'done' | 'error'; output?: string }
  skillLog?: { level: 'info' | 'warn' | 'error' | 'output' | 'debug'; message: string }
  skillResult?: { type: 'inline' | 'script_output' | 'reference'; content?: string }
  skillError?: { phase: string; message: string }
  skillMode?: 'inline' | 'fork' | 'reference' | 'script'
  // Command 字段
  commandId?: string
  commandName?: string
  commandArgs?: string
  // 意图分析字段
  intentResult?: IntentAnalysisResult
  // 模式切换字段
  mode?: 'auto'
  // 上下文压缩
  beforeTokens?: number
  afterTokens?: number
  savedTokens?: number
  compactedMessages?: number
  preservedInfo?: string[]
  // 压缩状态（compact_status）
  compactStatus?: 'waiting' | 'compacting' | 'completed'
  // Agent 启动字段（agent_start）
  agentId?: string
  // Agent 进度字段（agent_progress）
  outputTokens?: number
  totalTokens?: number
  toolUseCount?: number
  // 工具详细状态字段（tool_detail）
  toolName?: string
  status?: 'queued' | 'running' | 'completed' | 'failed'
  eta?: number
}

// ─── Stream payload ────────────────────────────────────

/** agent-stream IPC 发送的消息负载 */
export interface AgentStreamPayload {
  conversationId: string
  event: AgentStreamEvent
}
