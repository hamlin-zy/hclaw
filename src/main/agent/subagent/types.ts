/**
 * Sub-Agent 类型定义
 *
 * 主 Agent 通过调用 `agent` 工具派生子 Agent 执行子任务。
 * 最多 3 个子 Agent 并发运行。
 */

import type {AgentStreamEvent} from '../stream'
import type {ModelConfig} from '../model/types'
import type {HClawAgentType} from '@shared/types'
import type {AgentDefinition} from '@shared/agent'

// ─── 子任务定义 ────────────────────────────────────────

export interface SubAgentTask {
  /** 唯一任务 ID */
  id: string
  /** 任务描述（作为子 Agent 的指令） */
  description: string
  /** 允许使用的工具白名单（空=所有已注册工具） */
  allowedTools?: string[]
  /** 额外上下文消息（可选，注入到子 Agent 历史） */
  context?: string
  /** 超时毫秒，默认 15 分钟 */
  timeout?: number
  /** Agent 类型 - 决定工具限制和模型选择 */
  agentType?: HClawAgentType
  /** 优先级（数值越大优先级越高，仅在 priorityEnabled 时生效） */
  priority?: number
}

// ─── 子任务结果 ────────────────────────────────────────

export interface SubAgentResult {
  taskId: string
  success: boolean
  /** 子 Agent 最终文本输出 */
  output: string
  /** 执行过程中的关键事件摘要 */
  summary?: string
  error?: string
}

// ─── 子任务运行时状态 ──────────────────────────────────

export interface SubAgentStatus {
  taskId: string
  state: 'pending' | 'running' | 'completed' | 'failed' | 'timeout' | 'aborted'
  startedAt?: number
  completedAt?: number
}

// ─── 子 Agent 流式事件 ─────────────────────────────────

export type SubAgentEvent =
  | { type: 'subagent_start'; taskId: string; description: string }
  | { type: 'subagent_progress'; taskId: string; event: AgentStreamEvent }
  | { type: 'subagent_done'; taskId: string; result: SubAgentResult }

// ─── 子 Agent 启动参数 ─────────────────────────────────

export interface SubAgentStartParams {
  task: SubAgentTask
  /** 继承主 Agent 的模型配置 */
  modelConfig: ModelConfig
  /** 工作目录 */
  workingDir: string
  /** 中止信号 */
  abortSignal?: AbortSignal
  /** Agent 类型 */
  agentType?: HClawAgentType
  /** Agent 定义（用于工具过滤和提示词） */
  agentDefinition?: AgentDefinition
    /** 系统设置（包含 maxTurns 等配置） */
    settings?: import('@shared/types').SystemSettings
}
