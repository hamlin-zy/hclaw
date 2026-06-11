/**
 * Model configuration, provider, agent type, and agent-start-params types.
 *
 * Layer 2 — depends on message, permissions, infra.
 */

import type { Attachment } from './message'
import type { RunMode } from './permissions'
import type { MCPServer } from './infra'

// ─── Model config ──────────────────────────────────────

export interface ModelConfig {
  provider: 'anthropic' | 'openai' | 'google' | 'ollama' | 'custom'
  model: string
  /** 认证类型：api-key (默认) 或 google-oauth2 */
  authType?: 'api-key' | 'google-oauth2'
  apiKey?: string
  /** 保存的凭据 ID */
  credentialId?: string
  baseUrl?: string
  projectId?: string
  /** 服务商显示名称（如 openrouter），用于日志 */
  _providerName?: string
  /**
   * 推理/思考强度（undefined=禁用，auto=默认高强度）
   * - low / medium / high: 基础强度
   * - xhigh / max: 高强度（DeepSeek/Anthropic 支持，OpenAI 会降级为 high）
   */
  thinkingEffort?: 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** 扩展特性（透传自 LLMProvider） */
  features?: ProviderFeatures
}

// ─── Model scheme ──────────────────────────────────────

export type ModelRole =
  | 'primary'
  | 'lightweight'
  | 'reasoning'
  | 'image_understanding'
  | 'audio_understanding'
  | 'video_understanding'
  | 'image_generation'
  | 'video_generation'
  | 'voice_clone'
  | 'voice_synthesis'
  | 'music_generation'

/**
 * Work mode - controls which model role the agent loop uses
 */
export type WorkMode = string

/**
 * @deprecated 工作模式直接使用方案角色名，不再需要中间映射。
 */
export const WORK_MODE_TO_MODEL_ROLE: Partial<Record<string, ModelRole>> = {
  'auto': 'primary',
}

/** @deprecated 显示名统一从 scheme role 的 displayName 读取。 */
export const WORK_MODE_LABELS: Record<string, string> = {
  'auto': '自动模式',
}

/** Task complexity level */
export type TaskComplexity = 'simple' | 'moderate' | 'complex'

/** Model type */
export type ModelType = 'text' | 'voice' | 'video' | 'image' | 'music' | 'multimodal'

// ─── Agent config ──────────────────────────────────────

/** LingShu Agent 类型 */
export type LingShuAgentType = string
/** @deprecated 使用 LingShuAgentType */
export type HClawAgentType = LingShuAgentType

/** Agent 类型配置 */
export interface AgentTypeConfig {
  /** Agent 类型标识 */
  type: string
  /** 何时使用 */
  whenToUse: string
  /** 触发条件列表（when_to_use 的别名） */
  triggers?: string[]
  /** 允许的工具列表 (['*'] = 全部, [] = 只读) */
  allowedTools?: string[]
  /** 禁止使用的工具 */
  disallowedTools?: string[]
  /** 默认模型角色 */
  defaultModelRole: 'inherit' | ModelRole
  /** Token 优化配置 */
  optimizations?: {
    /** 省略 CLAUDE.md */
    omitClaudeMd?: boolean
    /** 省略 gitStatus */
    omitGitStatus?: boolean
  }
}

/** 角色配置 */
export interface ModelRoleConfig {
  /** 指定 LLMProvider.id */
  endpointId: string
  /** 该服务商下的模型 ID */
  modelId: string
  /** 是否启用（否则 fallback 到 primary） */
  enabled: boolean
  /** 推理/思考强度（undefined=禁用，auto=自动高强度，low/medium/high/xhigh/max=手动指定） */
  thinkingEffort?: 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}

/** 模型方案角色新结构 */
export interface ModelSchemeRole {
  id: string
  role: string
  displayName?: string
  description?: string
  icon?: string
  endpointId: string
  modelId: string
  modelType: ModelType
  /** 推理/思考强度（undefined=禁用，auto=自动高强度，low/medium/high/xhigh/max=手动指定） */
  thinkingEffort?: 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  enabled: boolean
}

/** 模型方案新结构 */
export interface ModelScheme {
  id: string
  name: string
  description?: string
  roles: ModelSchemeRole[]
  enabled: boolean
}

// ─── LLM Provider ──────────────────────────────────────

/** 提供者类型 */
export type ProviderType = 'anthropic' | 'openai' | 'google' | 'ollama' | 'custom'

/** 认证类型 */
export type AuthType = 'api-key' | 'google-oauth2'

/** 提供者凭据 */
export interface ProviderCredentials {
  apiKey?: string
  accessToken?: string
  refreshToken?: string
  expiryDate?: number
}

/** 提供者下的模型 */
export interface ProviderModel {
  id: string
  name: string
  modelType?: ModelType
  enabled: boolean
}

/** 服务商扩展特性 */
export interface ProviderFeatures {
  /** 使用 Anthropic 兼容 API 时，system 是否以内容块数组发送（含 cache_control: ephemeral） */
  systemContentBlocks?: boolean
}

/** LLM 供应商（统一配置） */
export interface LLMProvider {
  id: string
  name: string
  type: ProviderType
  authType?: AuthType
  baseUrl?: string
  projectId?: string
  /** 扩展特性 */
  features?: ProviderFeatures
  /** API Key（仅 api-key 认证模式） */
  apiKey?: string
  credentials?: ProviderCredentials
  email?: string
  enabled: boolean
  models: ProviderModel[]
}

// ─── Intent analysis ───────────────────────────────────

/** 意图分析结果 */
export interface IntentAnalysisResult {
  /** 意图摘要 */
  summary: string
  /** 复杂程度 */
  complexity: TaskComplexity
  /** 预估步骤数 */
  estimatedSteps: number
  /** 是否需要 plan */
  needsPlanning: boolean
  /** 建议使用的模型角色（从分析数据） */
  suggestedModel: ModelRole
  /** 建议使用的 Agent 类型（可选） */
  suggestedAgentType?: string
}

// ─── Command definition ──────────────────────────────────

/** 命令定义（从文件系统加载） */
export interface CommandDefinition {
  id: string
  name: string
  description: string
  enabled: boolean
  content: string
  args?: Array<{
    name: string
    description?: string
    required?: boolean
    default?: string
  }>
  filePath?: string
  createdAt: number
  updatedAt: number
}

// ─── Agent template ────────────────────────────────────

/** Agent 模板定义 */
export interface AgentTemplate {
  id: string
  name: string
  description: string
  /** 用户自定义描述（覆盖系统描述），支持用户熟悉的方式 */
  userDescription?: string
  /** 何时使用（Agent 路由判断逻辑，影响 LLM 路由决策） */
  whenToUse?: string
  /** 系统提示词 */
  systemPrompt: string
  /** 默认模型配置 */
  modelConfig?: ModelConfig
  /** 允许使用的工具列表 */
  allowedTools?: string[]
  /** 是否启用 */
  enabled: boolean
  /** 预设技能 ID 列表 */
  skillIds?: string[]
  /** 标签，用于分类 */
  tags?: string[]
  createdAt: number
  updatedAt: number

  // ===== CC 扩展字段 =====
  /** 模型覆盖 (CC 字段) */
  model?: string
  /** 禁止的工具调用 (CC 字段) */
  disallowedTools?: string[]
  /** 记忆使用范围 (CC 字段) */
  memory?: 'user' | 'project' | 'none'
  /** 隔离模式 (CC 字段) */
  isolation?: 'worktree' | 'none'
  /** 权限模式设置 (CC 字段) */
  permissionMode?: 'auto' | 'safe'
  /** 最大执行轮次 (CC 字段) */
  maxTurns?: number
  /** 必需 MCP 服务器 (CC 字段) */
  requiredMcpServers?: string[]
  /** 触发条件列表 (CC 扩展) */
  triggers?: string[]
}

// ─── Agent start params ────────────────────────────────

export interface AgentStartParams {
  conversationId: string
  message: string
  attachments?: Attachment[]
  /** 消息元数据（含工作模式等），供 Agent Loop 识别处理模式 */
  messageMetadata?: Record<string, unknown>
  mode?: RunMode
  modelConfig: ModelConfig
  workingDir: string
  mcpServers?: MCPServer[]
  /** 已加载的 Skills 列表，注入到系统提示词 */
  skills?: string[]
  /** 会话标题，用于 LLM 日志和显示 */
  conversationTitle?: string
  /** 模型方案配置 */
  schemeConfig?: unknown
  /** 历史信息，用于恢复对话 */
  history?: Array<{
    role: string
    content: string
    toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
    toolCallId?: string
    toolResult?: string
    isError?: boolean
  }>
  /** 可用 Agent 模板列表 */
  agentTemplates?: AgentTemplate[]
}
