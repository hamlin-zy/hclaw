/**
 * System settings, prompt configuration, menu dialogs, channels, and subagent config.
 *
 * Layer 1 — 仅依赖同为 Layer 1 的 ./theme（零依赖），无环。
 */
import type {ThemeSetting} from './theme'

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
  | 'tool-manage'
  | 'agents'
  | 'skills'
  | 'plugins'
  | 'commands'
  | 'prompt-scheme'
  | 'conversations'
  | 'schedules'
  | 'settings'
  | 'tool-catalog'
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
  /** 子 Agent 嵌套最大递归深度，默认值 3 */
  maxDepth: number
}

export interface UiBackground {
  enabled: boolean
  imagePath: string
  overlay: number
  blur: number
}

/** 语言守卫策略：off=停止新注入；first-only=仅会话首次预防注入；first-and-drift=首次 + 漂移纠正 */
export type LanguageGuardStrategy = 'off' | 'first-only' | 'first-and-drift'

/**
 * 母语来源模式：
 * - 'system'（缺省）= 跟随系统：每次启动由主进程刷新 nativeLocale = app.getLocale()
 * - 'manual' = 用户手选：启动兜底不再覆盖，系统语言变化也不跟随
 */
export type NativeLocaleMode = 'system' | 'manual'

/** 语言守卫（母语漂移纠正）设置 */
export interface LanguageSettings {
    /** 母语来源模式。缺省视为 'system'（跟随系统） */
    nativeLocaleMode?: NativeLocaleMode
    /**
     * 当前生效的母语 locale（如 'zh-CN'）。
     * 跟随系统模式下由启动兜底每次刷新为 app.getLocale()（主进程侧）；
     * manual 模式下为用户手选值，启动不覆盖。
     */
    nativeLocale?: string
    /** 策略，默认 'first-and-drift' */
    strategy?: LanguageGuardStrategy
    /** 会话内累计注入次数上限（含首次预防注入）。默认 3；'always' = 不设限 */
    correctionLimit?: number | 'always'
}

export interface SystemSettings {
  agent: {
    maxTurns: number
    retryCount: number
    initialRetryDelay: number
    maxRetryDelay: number
    llmTimeout: number
    /** 发送前交接引导阈值（0-1；0 = 关闭引导）。默认 0.5；ratio=0 为跨模式的全局关闭哨兵 */
    handoffThresholdRatio: number
    /** 交接阈值口径。默认 'ratio'（按窗口比例）；'tokens' 按固定 token 数 */
    handoffThresholdMode?: 'ratio' | 'tokens'
    /** 按窗口大小模式的固定阈值（token）。默认 200_000；仅 mode='tokens' 生效，下限 50_000 */
    handoffThresholdTokens?: number
    /** loop 内接近窗口上限时的行为。默认 'auto-handoff' */
    midLoopOverflowMode: 'auto-handoff' | 'graceful-stop'
    /** LLM 循环检测档位。默认 'notify'；'off' 时零开销 */
    loopDetection?: {
        mode: 'notify' | 'pause' | 'off'
        /** 连续相同签名轮数阈值，下限 2，默认 3 */
        threshold: number
    }
    /** 新会话默认安全模式（会话级 fallback 的全局默认；保存时同步 system_settings.permission_mode） */
    defaultPermissionMode?: 'safe' | 'auto'
    /** 新会话默认显示模式（会话级 fallback 的全局默认；保存时同步 message-display-mode 配置） */
    defaultDisplayMode?: 'detailed' | 'compact' | 'ultra-compact'
  }
  model: {
    defaultMaxTokens: number
    defaultTemperature: number
    /**
     * 图片压缩质量（1-100，整数）。默认 85，代码层 clamp 到 1-100（UI 下限建议 40）。
     * 仅影响 load_image 加载的图片；未超过体积/尺寸阈值的小图不会被重新编码。
     */
    imageCompressQuality?: number
  }
  ui: {
    theme: ThemeSetting
    background?: UiBackground
  }
  subagent?: SubagentConfig
  /** 用户习惯记忆设置 */
  memory?: {
    /** 总开关（缺省 true） */
    enabled: boolean
  }
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
  /** 语言守卫（母语漂移纠正）设置 */
  language?: LanguageSettings
  /** 快捷键覆盖项（仅存偏离默认的绑定；空/缺省 = 全默认） */
  shortcuts?: {
    overrides?: Partial<Record<import('@shared/shortcuts').ShortcutAction, string>>
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
