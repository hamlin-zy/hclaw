/**
 * Hook 系统类型定义 - 配置化版本
 *
 * HClaw 的 Hook 系统支持在关键生命周期事件发生时自动执行自定义操作
 */

// ─── Hook 事件类型 ─────────────────────────────────────

export type HookEvent =
  // Session
  | 'SessionStart'
  | 'SessionEnd'
  | 'UserPromptSubmit'
  | 'UserPromptExpansion'
  | 'InstructionsLoaded'
  | 'ConfigChange'
  | 'CwdChanged'

  // Tool
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'PermissionRequest'
  | 'PermissionDenied'

  // Agent
  | 'SubagentStart'
  | 'SubagentStop'
  | 'TeammateIdle'
  | 'TaskCreated'
  | 'TaskCompleted'

  // Think (LLM 思考周期)
  | 'ThinkStart'
  | 'ThinkEnd'

  // MCP
  | 'Elicitation'
  | 'ElicitationResult'

  // File
  | 'FileChanged'

  // Worktree
  | 'WorktreeCreate'
  | 'WorktreeRemove'

  // Response
  | 'Stop'
  | 'StopFailure'

  // Compact
  | 'PreCompact'
  | 'PostCompact'

  // Context Retrieval
  | 'ContextRetrieval'

  // Notification
  | 'Notification'

export type HookType = 'command' | 'function' | 'prompt' | 'http' | 'agent'

// ─── Hook Handler 函数类型 ─────────────────────────────────────

/**
 * Function 类型 Hook 的处理函数
 * 直接在主进程中执行，用于复杂逻辑或需要访问应用状态
 */
export type HookHandler = (context: HookContext) => Promise<HookResult> | HookResult

// ─── Hook 事件定义（用于 UI 显示）────────────────────────────────────

export interface HookEventDefinition {
  /** 事件名称 */
  event: HookEvent
  /** 显示名称 */
  name: string
  /** 描述 */
  description: string
  /** 分类 */
  category: 'session' | 'tool' | 'agent' | 'mcp' | 'file' | 'permission' | 'task' | 'response'
  /** 支持的 Hook 类型 */
  supportedTypes: HookType[]
  /** 是否支持 matcher */
  supportsMatcher: boolean
  /** 上下文参数 */
  contextParams: string[]
}

// ─── Hook 配置 ─────────────────────────────────────

export interface HookConfig {
  type: HookType
  /** 命令类型 */
  command?: string
  /** Function 类型 - 直接调用函数 */
  handler?: HookHandler
  /** Prompt 类型 */
  prompt?: string
  /** HTTP 类型 */
  url?: string
  method?: 'GET' | 'POST' | 'PUT'
  headers?: Record<string, string>
  body?: string
  /** Agent 类型 */
  agentPrompt?: string
  agentType?: string
  /** 通用 */
  shell?: 'bash' | 'powershell'
  timeout?: number
  once?: boolean
  async?: boolean
  matcher?: string
  /** 是否捕获 stdout 作为输出（用于 ContextRetrieval 等需注入内容的 hook） */
  captureOutput?: boolean
}

export interface HookDefinition {
  id: string
  name: string
  description: string
  events: HookEvent[]
  config: HookConfig
  enabled: boolean
  source: 'builtin' | 'user' | 'plugin'
  pluginName?: string
  createdAt: number
  updatedAt: number
}

// ─── Hook 上下文 ─────────────────────────────────────

export interface HookContext {
  /** 触发的事件名称（由 executor 自动填充） */
  event?: string
  sessionId?: string
  pluginRoot?: string
  toolName?: string
  args?: unknown
  prompt?: string
  result?: unknown
  error?: string
  /** 事件原因描述（Stop: completed/error/interrupted; SessionEnd: clear/logout/other） */
  reason?: string
  // 事件特定
  filePath?: string
  cwd?: string
  taskId?: string
  taskName?: string
  configKey?: string
  configValue?: unknown
  elicitationRequest?: unknown
  elicitationResult?: unknown
  worktreeName?: string
  worktreePath?: string
    /** 本次 loop 的最新消息（SessionEnd 钩子传递） */
    lastMessages?: Array<{ role: string; content: string }>
}

// ─── Hook 执行结果 ─────────────────────────────────────

/**
 * Hook 执行结果
 * 
 * 支持 Claude Code 规范的 hookSpecificOutput 结构：
 * - decision: 阻止/允许决策
 * - additionalContext: 向 Claude 添加额外上下文
 * - permissionDecision: 权限决策（PreToolUse 等）
 */
export interface HookResult {
  allowed: boolean
  modified?: {
    prompt?: string
    context?: Record<string, unknown>
    args?: unknown
  }
  error?: string
  warning?: string
  retry?: boolean
  /** 命令 hook 的 stdout 输出（captureOutput=true 时捕获） */
  output?: string
  
  /** Claude Code 规范: 阻止/允许决策 */
  decision?: 'block' | 'allow' | 'continue'
  /** Claude Code 规范: 阻止原因说明 */
  reason?: string
  
  /** Claude Code 规范: 额外上下文（会注入到 Claude 的上下文中） */
  additionalContext?: string
  
  /** Claude Code 规范: 权限决策（用于 PreToolUse/PermissionRequest） */
  permissionDecision?: 'allow' | 'deny' | 'block'
  permissionDecisionReason?: string
  
  /** Claude Code 规范: 更新的输入参数 */
  updatedInput?: Record<string, unknown>
  
  /** Claude Code 规范: 更新的工具输出（用于 PostToolUse） */
  updatedToolOutput?: Record<string, unknown>
  
  /** Claude Code 规范: 会话标题 */
  sessionTitle?: string
}

// ─── 序列化类型（用于存储）────────────────────────────────────

export interface SerializedHook {
  id: string
  name: string
  description: string
  events: string[]
  config: HookConfig
  enabled: boolean
  source: 'builtin' | 'user' | 'plugin'
  pluginName?: string
  createdAt: number
  updatedAt: number
}
