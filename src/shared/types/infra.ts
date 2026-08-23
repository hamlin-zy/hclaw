/**
 * Infrastructure types: MCP servers/tools, Skills, LLM call logs,
 * conversations, and workspace configuration.
 *
 * Layer 1 — depends only on skillTypes (external), not on other sub-files.
 */

import type { SkillExtensions } from '../skillTypes'

// ─── MCP Server & Tool ────────────────────────────────

export interface MCPServer {
  id: string
  name: string
  status: 'connected' | 'disconnected' | 'error' | 'stopped' | 'connecting' | 'reconnecting'
  tools: MCPTool[]
  transport: 'stdio' | 'sse' | 'http' | 'websocket' | 'streamable-http'
  enabled: boolean
  userDescription?: string
  // Stdio fields
  command?: string
  args?: string[]
  env?: Record<string, string>
  // SSE/HTTP/WebSocket fields
  url?: string
  headers?: Record<string, string>
  // 高级配置
  cwd?: string
  timeout?: number
  autoApprove?: string[]
  denyList?: string[]
  errorDetail?: string
}

export interface MCPTool {
  id: string
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

// ─── Skill ─────────────────────────────────────────────

export interface Skill {
  id: string
  name: string
  description: string
  /** 用户自定义描述（覆盖系统描述），支持用户熟悉的方式 */
  userDescription?: string
  enabled: boolean
  version: string
  /** 来源类型 */
  source?: 'builtin' | 'user' | 'plugin'
  /** 插件名称（仅 plugin source 有值） */
  pluginName?: string
  /** 插件的实际启用状态（仅 plugin source 有值），独立于技能个体的 enabled 状态 */
  pluginEnabled?: boolean
  /** 允许使用的工具列表 */
  allowedTools?: string[]
  /** 匹配关键词 */
  content?: string
  /** 文件路径 */
  filePath?: string
  /** 匹配分数（越大越匹配） */
  matchScore?: number
  /** 匹配原因（调试时用） */
  matchReason?: string
  /** 技能目录路径（支持扩展目录结构） */
  skillDir?: string
  /** 扩展资源（references/scripts/templates等） */
  extensions?: SkillExtensions
  /** 配置路径（路径匹配用） */
  paths?: string[]
  /** 执行模式：inline=注入信息，fork=启动 Agent，reference=引用加载，script=执行脚本 */
  context?: 'inline' | 'fork' | 'reference' | 'script'
  /** 模型覆盖（如 'opus', 'sonnet', 'haiku'） */
  model?: string
  /** 分类标签 */
  category?: string
  /** 许可协议 */
  license?: string
}

// ─── Audit log ─────────────────────────────────────────

export interface AuditLog {
  id: string
  timestamp: number
  action: string
  target: string
  result: 'success' | 'error'
  details?: string
}

// ─── LLM call log ─────────────────────────────────────

/** LLM 调用日志 */
export interface LlmCallLog {
  id: string
  timestamp: number
  /** 会话标题 */
  conversationTitle: string
  /** 服务商显示名称（如 openrouter），用于日志 */
  provider: string
  /** 模型名称 */
  model: string
  /** 耗时（秒） */
  duration: number
  /** 输入 token 数 */
  inputTokens: number
  /** 输出 token 数 */
  outputTokens: number
  /** 缓存命中的 token 数 */
  cacheReadTokens?: number
  /** 缓存创建的 token 数 */
  cacheWriteTokens?: number
  /** 推理/思考 token 数 */
  reasoningTokens?: number
  /** 输入内容（用户消息） */
  inputContent: string
  /** 输出内容（AI回复） */
  outputContent: string
  /** 系统提示词 token 预估 */
  systemPromptTokens?: number
  /** 用户输入 token 预估 */
  inputTokensEstimated?: number
  /** AI 输出 token 预估 */
  outputTokensEstimated?: number
  /** 历史信息 token 预估 */
  messagesTokens?: number
  /** 工具调用列表 */
  toolCalls?: Array<{
    id: string
    name: string
    input: Record<string, any>
    output?: string
    success?: boolean
  }>
  /** 附带的历史消息列表（用于展示） */
  messages?: Array<{
    role: string
    content: string
    toolCalls?: Array<{ id: string; name: string; arguments: Record<string, any> }>
    toolCallId?: string
    toolResult?: string
  }>
  /** 系统提示词 */
  systemPrompt?: string
}

// ─── Conversation & workspace ─────────────────────────

export interface Conversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageIds: string[]
  preview: string
  workspacePath: string
}

/** 会话摘要（来自 workspace.conf 的信息） */
export interface ConversationSummary {
  id: string
  title: string
  preview: string
  createdAt: number
  updatedAt: number
  pinned?: boolean
  /** 用户可见的 channel 字段：后端写入时由 channelId 决定 */
  channel?: string
  /** 会话运行状态：active（空闲）/ running（运行中）/ archived（已结束） */
  status?: 'active' | 'running' | 'archived'
  /** 父会话 ID（用于侧边栏缩进分组） */
  parentConvId?: string
  /** 来源会话 ID（session_handoff 交接创建时记录的交接发起会话） */
  handoffFromConvId?: string
}

export interface ConversationMeta {
  id: string
  title: string
  workspacePath: string
  createdAt: number
  updatedAt: number
  preview: string
  status: 'active' | 'running' | 'archived'
  pinned?: boolean
  /** 会话类型：user（用户主动创建）/ scheduler（定时任务） */
  sessionType?: 'user' | 'scheduler'
  scheduleId?: string
  /** 渠道标识：system / wechat / feishu / scheduler */
  channel?: string
  /** 父会话 ID（子会话单向记录） */
  parentConvId?: string
  /** 来源会话 ID（session_handoff 交接创建时记录的交接发起会话；区别于 parentConvId，交接新会话是独立顶层会话） */
  handoffFromConvId?: string
  /** 创建时的任务描述 */
  sourceTask?: string
  /** 创建时指定的能力 */
  sourceCapability?: { type: 'agent'; name: string }
  /** 标记为 agent tool 创建的子会话 */
  isChildSession?: boolean
  /** 会话级模型覆盖：undefined=无记录（默认 primary）、null=显式 auto、对象=指定模型 */
  modelOverride?: import('./model').ModelOverride | null
}

/** 会话管理页面使用的统计信息 */
export interface ConversationWithStats extends ConversationMeta {
  messageCount: number
  blockCount: number
}

/** 会话用量统计（父会话 + 全部后代子会话聚合） */
export interface ConversationUsageStats {
  /** 统计范围内的会话总数（含起点自身） */
  conversationCount: number
  /** 根会话数：parentConvId 为空，或父会话不在统计集合内（孤儿子会话算根） */
  parentCount: number
  /** 子会话数：parentConvId 非空且父会话在统计集合内 */
  childCount: number
  /** LLM 请求次数（Σ llmStats 条数） */
  requestCount: number
  /** 工具调用次数（Σ tool_use 块数） */
  toolCallCount: number
  /** 累计输入 token（Σ inputTokens） */
  totalInputTokens: number
  /** 累计输出 token（Σ outputTokens） */
  totalOutputTokens: number
  /** 累计缓存命中 token（Σ cacheReadTokens） */
  totalCacheReadTokens: number
  /** 累计缓存写入 token（Σ cacheWriteTokens） */
  totalCacheWriteTokens: number
  /** 累计纯解码时长（毫秒），平均吞吐 = ΣoutputTokens ÷ ΣdecodeMs（与 CacheRateTooltip 口径一致） */
  totalDecodeMs: number
  /** 累计首字延迟（毫秒），平均首字 = totalTtftMs ÷ ttftCount */
  totalTtftMs: number
  /** 携带首字延迟的 LLM 调用数（旧数据无 ttftMs 不计入） */
  ttftCount: number
  /** 分组用量（按 provider+model，totalTokens 降序） */
  breakdown: UsageBreakdown[]
}

/** 用于 workspace 存储 */
export interface WorkspaceData {
  lastOpenedAt: number
  conversations: ConversationSummary[]
}

/** workspace.conf 的结构 */
export interface WorkspaceConfig {
  currentWorkspacePath: string | null
  activeConversationId: string | null
  workspaces: Record<string, WorkspaceData>
}

// ─── LLM 用量独立表（llm_usage） ─────────────────────────

/** 单条 LLM 用量事件（= llm_usage 表一行） */
export interface LlmUsageRecord {
  id: string              // usage_<messageId>_<seq>
  conversationId: string
  messageId: string
  providerType: string    // anthropic/openai/google/ollama/custom（精确服务商类型）
  model: string
  /** providers 表服务商名（providers.name），历史数据可空 */
  providerName?: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  ttftMs?: number
  decodeMs?: number
  durationMs: number
  createdAt: number
}

/** 分组聚合行（按服务商或模型） */
export interface UsageBreakdown {
  key: string             // provider_type 或 model
  providerType?: string   // 按模型分组时附所属服务商（UI 小字标注）
  /** providers 表服务商名（providers.name），按服务商分组时展示用，历史数据可空 */
  providerName?: string
  requestCount: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number     // 输入+输出+缓存（含全部 token 流量）
  costUsd: number         // 实时价格 × token（未定价模型为 0）
  /** 组内累计纯解码时长（毫秒，历史数据/工具轮次可缺） */
  decodeMs?: number
  /** 组内累计首字延迟（毫秒，仅统计有 ttft 的样本） */
  ttftMs?: number
  /** 组内携带首字延迟的调用数 */
  ttftCount?: number
}

/** 时间趋势点；day 为分组键：按天 'YYYY-MM-DD'，按小时 'YYYY-MM-DD HH:00'（本地时区） */
export interface TrendPoint {
  day: string             // 按天 'YYYY-MM-DD'；按小时 'YYYY-MM-DD HH:00'
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
}

/** 时间范围；'custom' 配合 usage-stats:query 的 customStart/customEnd（YYYY-MM-DD，天级精度） */
export type TimeRange = 'today' | '7d' | '30d' | 'all' | 'custom'

/** 趋势分组粒度 */
export type TrendGranularity = 'day' | 'hour'

/** 全局用量统计 IPC 请求参数 */
export interface UsageStatsQueryParams {
  range: TimeRange
  view: 'provider' | 'model'
  /** 自定义范围起点（YYYY-MM-DD，仅 range='custom' 时生效） */
  customStart?: string
  /** 自定义范围终点（YYYY-MM-DD，仅 range='custom' 时生效） */
  customEnd?: string
  /** 趋势分组粒度：今天/自定义 ≤1 天 → 'hour'；其余 → 'day' */
  granularity?: TrendGranularity
}

/** 全局用量统计 IPC 返回 */
export interface GlobalUsageStats {
  kpi: {
    totalTokens: number     // 输入+输出+缓存读取+缓存写入（含全部 token 流量）
    totalCostUsd: number
    requestCount: number
    cacheHitRate: number | null   // 口径：cacheRead / (input + cacheRead)
    /** 累计输出 token（平均吞吐分子，渲染层用 tokensPerSecond 计算展示，口径与 tooltip 一致） */
    totalOutputTokens: number
    /** 累计纯解码时长（毫秒） */
    totalDecodeMs: number
    /** 累计首字延迟（毫秒） */
    totalTtftMs: number
    /** 携带首字延迟的调用数 */
    ttftCount: number
    /** 平均吞吐 t/s（Σ输出 ÷ Σ解码时长，computeKpis 统一口径）；无有效样本 → null */
    avgDecodeRate?: number | null
    /** 平均首字秒（Σ首字 ÷ 样本数 ÷ 1000）；无样本 → null */
    avgTtftSeconds?: number | null
  }
  trend: TrendPoint[]
  breakdown: UsageBreakdown[]
}
