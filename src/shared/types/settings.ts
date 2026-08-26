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
  | 'permission-rules'
  | 'llm-config'
  | 'scheme-config'
  | 'mcp'
  | 'tools'
  | 'agents'
  | 'skills'
  | 'plugins'
  | 'commands'
  | 'prompt-config'
  | 'conversations'
  | 'schedules'
  | 'settings'
  | 'tool-list'
  | 'system-prompt'
  | 'task-history'
  | 'task-history-conv'
  | 'update-notice'
  | 'about'
  | null

// ─── System settings ───────────────────────────────────

/** 默认最大 Token 数（模型输出的软上限，可在设置中调整） */
export const DEFAULT_MAX_TOKENS = 50000

export interface SubagentConfig {
  maxConcurrency: number
  defaultTimeout: number
  retryAttempts: number
  priorityEnabled: boolean
  /** 子 Agent 嵌套最大递归深度，默认值 3 */
  maxDepth: number
}

export interface UiBackground {
    enabled: boolean
    imagePath: string
    overlay: number
    blur: number
}

export interface SystemSettings {
  agent: {
    maxTurns: number
    retryCount: number
    initialRetryDelay: number
    maxRetryDelay: number
    llmTimeout: number
    /** 发送前交接引导阈值（0-1；0 = 关闭引导）。默认 0.5 */
    handoffThresholdRatio: number
    /** loop 内接近窗口上限时的行为。默认 'auto-handoff' */
    midLoopOverflowMode: 'auto-handoff' | 'graceful-stop'
    /** 新会话默认安全模式（会话级 fallback 的全局默认；保存时同步 system_settings.permission_mode） */
    defaultPermissionMode?: 'safe' | 'auto'
    /** 新会话默认显示模式（会话级 fallback 的全局默认；保存时同步 message-display-mode 配置） */
    defaultDisplayMode?: 'detailed' | 'compact' | 'ultra-compact'
  }
  model: {
    defaultMaxTokens: number
    defaultTemperature: number
  }
  mcp: {
    mcpTestTimeout: number
  }
  ui: {
    theme: 'light' | 'dark' | 'yuanshandai' | 'shiyangjin' | 'system'
    background?: UiBackground
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
  /** 技能目录详细描述开关（true=完整描述格式，false/undefined=仅名称索引，缺省关闭） */
  fullSkillDescriptions?: boolean
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
