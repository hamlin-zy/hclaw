/**
 * System settings, prompt configuration, menu dialogs, channels, and subagent config.
 *
 * Layer 1 — no internal sub-file dependencies.
 */

// ─── Prompt configuration ──────────────────────────────

/** 提示词节点标识符 */
export type PromptNodeKey =
  | 'system.intro'
  | 'system.rules'
  | 'system.workflow'
  | 'system.output'
  | 'system.routing'
  | 'system.image'
  | 'system.media'
  | 'system.memory'
  | 'system.directories'

export type PromptNodeCategory = 'system' | 'service'

/** 提示词节点信息 */
export interface PromptNodeMeta {
  /** 节点键 */
  key: PromptNodeKey
  /** 显示名称 */
  name: string
  /** 描述说明 */
  description: string
  /** 分类 */
  category: PromptNodeCategory
  /** 默认提示词内容 */
  defaultValue: string
}

/** @deprecated 使用 PromptScheme 替代 */
export interface PromptConfig {
  /** 是否启用自定义提示词 */
  enabled: boolean
  /**
   * 模型专属配置
   * Key: 模型的唯一标识，格式为 `endpointId:modelId`
   * Value: 该模型下的自定义节点内容
   */
  modelConfigs: Record<string, Partial<Record<PromptNodeKey, string>>>
}

/** 提示词方案 */
export interface PromptScheme {
  id: string
  name: string
  description?: string
  /** 是否激活 */
  enabled: boolean
  /** 节点覆盖值，key=PromptNodeKey, value=自定义内容 */
  nodes: Partial<Record<PromptNodeKey, string>>
}

// ─── Menu dialog ───────────────────────────────────────

export type MenuDialogType =
  | 'llm-config'
  | 'scheme-config'
  | 'mcp'
  | 'tools'
  | 'agents'
  | 'skills'
  | 'hooks'
  | 'plugins'
  | 'commands'
  | 'prompt-config'
  | 'conversations'
  | 'schedules'
  | 'settings'
  | 'tool-list'
  | 'system-prompt'
  | 'about'
  | null

// ─── System settings ───────────────────────────────────

export interface SubagentConfig {
  maxConcurrency: number
  defaultTimeout: number
  retryAttempts: number
  priorityEnabled: boolean
}

export interface SystemSettings {
  agent: {
    maxTurns: number
    retryCount: number
    initialRetryDelay: number
    maxRetryDelay: number
    llmTimeout: number
  }
  model: {
    defaultMaxTokens: number
    defaultTemperature: number
  }
  mcp: {
    mcpTestTimeout: number
  }
  ui: {
    language: string
    theme: 'light' | 'dark' | 'yuanshandai' | 'shiyangjin' | 'system'
  }
  subagent?: SubagentConfig
  /** 链接打开方式 */
  linkOpening?: {
    /** 链接打开模式: builtin=内置浏览器, system=系统浏览器, ask=每次都问 */
    mode: 'builtin' | 'system' | 'ask'
  }
  /** 渠道配置 */
  channels?: {
    /** 连接成功后是否发送打招呼信息 */
    sendGreeting: boolean
    /** 连接超时时间（秒） */
    connectionTimeout: number
  }
}

// ─── Channel types ─────────────────────────────────────

export type ChannelType = 'feishu' | 'wechat'

export type ChannelStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface ChannelConfig {
  id: string
  name: string
  type: ChannelType
  enabled: boolean
  config: Record<string, any>
  status: ChannelStatus
  statusMessage: string
  lastConnectedAt: number | null
  errorCount: number
  createdAt: number
  updatedAt: number
}
