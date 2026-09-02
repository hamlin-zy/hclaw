/**
 * Core message, block, attachment, task, and skill/command execution types.
 * 
 * Layer 1 — no internal sub-file dependencies.
 */

// ─── Tool calls ────────────────────────────────────────

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
  status: 'pending' | 'running' | 'success' | 'error' | 'cancelled'
  /** 此工具的调用时机（assistant 返回内容中的偏移），用于渲染时定位位置 */
  textOffset?: number
  /** 执行进度信息 */
  progress?: string
  /** 执行原因（LLM 说明为什么要执行此操作） */
  reason?: string
  /** 终端信息（如 bash 执行） */
  terminal?: {
    name: string     // 'powershell' | 'cmd' | 'bash'
    platform: string // 'windows' | 'macos' | 'linux'
  }
  /** 工具详细状态 */
  detailStatus?: 'queued' | 'running' | 'completed' | 'failed'
  /** 进度百分比（0-100） */
  progressPercent?: number
  /** 预计剩余时间（秒） */
  eta?: number
  /** 执行超时时间（毫秒），由主进程在工具启动时注入，用于 UI 倒计时显示 */
  timeoutMs?: number
  /** Token 消耗（agent 执行） */
  tokenUsage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
  }
  /** 子 Agent 任务 ID（agent 工具派生子 Agent 时，用于区分不同的子任务） */
  taskId?: string
  /** 子 Agent 任务描述（agent 工具显示用） */
  taskDescription?: string
  /** 技能名称（skill 工具显示用） */
  skillName?: string
  result?: {
    /** 工具是否执行成功（与 toolResult 格式化的成败判定一致） */
    success?: boolean
    /** 工具原始输出：字符串或对象（对象由 formatToolResult 统一格式化） */
    output: unknown
    error?: string
    /**
     * 已格式化 tool_result 内容（与发送给 API 的字符串逐字节一致）。
     * 新数据由 normalizeToolResult / formatToolResult 落库，重建时原样回传，
     * 保证跨 turn 前缀一致；旧数据无此字段时由 historyConverter 回退重建。
     */
    toolResult?: string
    /** 文件变更列表，用于 UI 显示变更 */
    artifacts?: Array<{
      filePath: string
      action: 'created' | 'modified' | 'deleted'
      content?: string
    }>
    /** 变更内容（如 file_edit 等工具的 diff 显示） */
    diff?: string
    /** 工具内部透传元数据（如 agent 工具的 childConvId，用于恢复子会话 ID） */
    _meta?: Record<string, unknown>
  }
}

export interface ToolResult {
  toolCallId: string
  output: string
  error?: string
}

export interface ToolCallInfo {
  id: string
  name: string
  arguments: Record<string, unknown>
  /** 执行原因（LLM 说明为什么要执行此操作） */
  reason?: string
  /** 终端信息（如 bash 执行） */
  terminal?: {
    name: string
    platform: string
  }
  /** 执行超时时间（毫秒），由主进程在工具启动时注入，用于 UI 倒计时显示 */
  timeoutMs?: number
}

// ─── Think / Steps / Tasks ────────────────────────────

export interface ThinkBlock {
  id: string
  content: string
  status: 'thinking' | 'complete'
  timestamp: number
  /** Anthropic extended thinking 签名，在后续请求中必须原样回传 */
  signature?: string
}

export interface StepNode {
  id: string
  name: string
  status: 'pending' | 'running' | 'success' | 'error'
  duration?: number
  children?: StepNode[]
}

export interface StepsBlock {
  id: string
  steps: StepNode[]
  completedCount: number
  totalCount: number
}

export type TaskStatus = 'pending' | 'running' | 'success' | 'error' | 'completed' | 'failed'

export interface Task {
  id: string
  title: string
  status: TaskStatus
  description?: string
  subtasks?: Task[]
}

export interface TasksBlock {
  id: string
  tasks: Task[]
}

// ─── File changes ──────────────────────────────────────

export interface FileChange {
  id: string
  filePath: string
  fileName: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  additions: number
  deletions: number
  diff: string
}

export interface FileChangeGroup {
  id: string
  userMessageId: string
  userQuestion: string
  timestamp: number
  changes: FileChange[]
}

// ─── Content blocks & media ───────────────────────────

export type BlockType = 'think' | 'text' | 'tool_call' | 'tool_result' | 'media' | 'end'

export type ContentBlockType = 'think' | 'text' | 'tool_use' | 'media' | 'end'

/** 媒体类型 */
export type MediaType = 'audio' | 'image' | 'video'

/**
 * 媒体扩展名 → MediaType 映射
 * 在 mediaExtractor 和 MediaPlayer 之间共享，避免重复定义
 */
export const MEDIA_EXT_MAP: Record<string, MediaType> = {
  mp3: 'audio', wav: 'audio', flac: 'audio', aac: 'audio',
  ogg: 'audio', m4a: 'audio', wma: 'audio', opus: 'audio',
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image',
  webp: 'image', bmp: 'image', svg: 'image', avif: 'image',
  mp4: 'video', webm: 'video', avi: 'video', mov: 'video',
  mkv: 'video', wmv: 'video', flv: 'video',
}

/** 根据文件名/URL 推断媒体类型（复用 MEDIA_EXT_MAP） */
export function inferMediaTypeFromUrl(urlOrPath: string): MediaType | null {
  if (!urlOrPath) return null
  const ext = urlOrPath.toLowerCase().split('?')[0].split('/').pop()?.split('.').pop()
  return ext ? (MEDIA_EXT_MAP[ext] ?? null) : null
}

/**
 * 媒体内容块
 * 用于在助手消息中内联渲染音频/图片/视频
 */
export interface MediaBlock {
  type: MediaType
  url: string            // hclaw-media:// 本地路径 或 https:// 网络地址
  caption?: string       // 标题/描述
  fileName?: string      // 原始文件名
  mimeType?: string      // MIME 类型
  thumbnail?: string     // 视频缩略图 URL
  width?: number         // 图片/视频 宽度
  height?: number        // 图片/视频 高度
}

/**
 * 有序内容块，按时间序记录 assistant 消息中的思考/文本/工具调用
 *
 * assistant 消息不再使用单一的 content + thinkBlock + toolCalls 扁平结构，
 * 而是通过 contentBlocks[] 数组记录 LLM 输出的完整时间序。
 * 旧消息（无 contentBlocks）仍通过扁平字段后向兼容。
 */
export interface ContentBlock {
  id: string
  type: ContentBlockType
  /** For 'think' blocks */
  thinkBlock?: ThinkBlock
  /** For 'text' blocks */
  text?: string
  /** For 'tool_use' blocks */
  toolCall?: ToolCall
  /** For 'media' blocks */
  media?: MediaBlock
  /** For 'end' blocks：消息收尾哨兵（承载 endedAt），用于保留块级时间序 */
  endedAt?: number
  /** LLM 调用轮次序号（方案 2：跨 turn 重建时按此分组还原多 assistant，旧数据可缺省） */
  turnIndex?: number
}

export interface MessageBlock {
  id: string
  messageId: string
  blockType: BlockType
  content: string | null
  data: string | null   // JSON serialized
  sequence: number
  timestamp: number
  endedAt?: number
  /** LLM 调用轮次序号（agent 循环内第几次 LLM 调用）。方案 2：跨 turn 重建时按此分组无损还原多 assistant */
  turnIndex?: number
}

/** 块级增量写入补丁（流式期间渲染进程高频路径） */
export interface BlockDeltaPatch {
  /** 本次新增/增长块。渲染端已生成 id/type/content/data/timestamp；sequence 由主进程分配（渲染端传 0）。finalize 收尾时可不传 */
  upsertBlocks?: MessageBlock[]
  /** 首次建行时传：role/timestamp + 瘦身 metadata（Task 5 后不含块字段）。后续 flush / finalize 只传 endedAt */
  messageFields?: { role?: string; timestamp?: number; metadata?: Record<string, unknown>; endedAt?: number }
  /** done/error 收尾传 true：补 messages.ended_at + end 块 */
  finalize?: boolean
}

// ─── Attachment ────────────────────────────────────────

export interface Attachment {
  id: string
  name: string
  type: string
  size: number
  path?: string
  preview?: string
  /** 媒体预览 URL，用于图片预览 */
  previewUrl?: string
  /** 是否为图片 */
  isImage?: boolean
}

// ─── LLM stats / Permission confirm ───────────────────

/** LLM 调用统计 */
export interface LlmStats {
  inputTokens: number
  outputTokens: number
  provider: string
  model: string
  duration: number
  /** providers 表服务商名（providers.name），历史数据可空 */
  providerName?: string
  /** providers.id（稳定服务商维度），历史数据可空 */
  providerId?: string
  /** 缓存命中的 token 数 */
  cacheReadTokens?: number
  /** 缓存创建的 token 数 */
  cacheWriteTokens?: number
  /** 推理/思考 token 数（仅部分模型返回） */
  reasoningTokens?: number
  /** 首字延迟（毫秒） */
  ttftMs?: number
  /** 纯解码时长（毫秒） */
  decodeMs?: number
  /** 解码吞吐（t/s） */
  tokensPerSecond?: number
}

/** 解码吞吐保守下限（毫秒）：decodeMs 低于此值视为首 token 边界虚短，按此值计算 t/s 防爆表 */
export const MIN_DECODE_MS = 500

/** 权限确认 */
export interface PermissionConfirm {
  /** 请求 ID */
  requestId: string
  /** 确认问题 */
  question: string
  /** 待确认的命令列表 */
  commands?: string[]
  /** status: 'pending' | 'approved' | 'denied' | 'always' */
  status: 'pending' | 'approved' | 'denied' | 'always'
  /** 创建时间 */
  createdAt: number
  /** 响应时间 */
  respondedAt?: number
}

// ─── Skill / Command execution ────────────────────────

/** 技能执行记录 */
export interface SkillExecution {
  executionId: string
  skillId: string
  skillName: string
  status: 'matched' | 'loading' | 'executing' | 'done' | 'error'
  phase?: string
  currentStep?: string
  progress?: { current: number; total: number; label?: string }
  references?: { loaded: string[]; pending?: string[] }
  script?: {
    name: string
    status: 'pending' | 'running' | 'done' | 'error'
    output?: string
    error?: string
  }
  logs: Array<{
    timestamp: number
    type: 'info' | 'warn' | 'error' | 'output' | 'debug'
    message: string
  }>
  result?: {
    type: 'inline' | 'script_output' | 'reference'
    content: string
  }
  error?: {
    phase: string
    message: string
  }
  startTime: number
  endTime?: number
}

/** 命令执行上下文 - 从用户消息 metadata 解析 */
export interface CommandExecutionContext {
  /** 命令 ID，plugin:command 格式 */
  commandId: string
  /** 命令名称，不包含前缀 */
  commandName: string
  /** 用户输入的参数 */
  commandArgs?: string
  /** 命令执行提示模板（可替换 $ARGUMENTS） */
  commandTemplate: string
}

/** 从消息的 metadata 中解析命令执行上下文 */
export function parseCommandContext(metadata?: Record<string, unknown>): CommandExecutionContext | null {
  if (!metadata) return null

  const commandTemplate = metadata.commandTemplate as string | undefined
  const commandId = metadata.commandId as string | undefined

  if (!commandTemplate || !commandId) return null

  // Extract command name (format: plugin:commandName)
  const parts = commandId.split(':')
  const cmdName = parts.length > 1 ? parts[1] : commandId

  return {
    commandId,
    commandName: cmdName,
    commandTemplate,
  }
}

/** 命令执行状态 - 用于 UI 显示 */
export interface CommandExecution {
  /** 命令 ID */
  commandId: string
  /** 命令名称，不包含前缀 */
  commandName: string
  /** 用户输入的参数 */
  commandArgs?: string
  /** 执行状态 */
  status: 'loading' | 'running' | 'done' | 'error'
  /** 开始时间 */
  startTime: number
  /** 结束时间 */
  endTime?: number
}

/**
 * 用户自定义命令 UserCommandDef
 * User-defined command, compatible with plugin CommandDef but with extra metadata.
 */
export interface UserCommandDef {
  id: string
  name: string
  description?: string
  content: string
  args?: Array<{
    name: string
    description?: string
    required?: boolean
    default?: string
  }>
  tags?: string[]
  enabled: boolean
  createdAt: number
  updatedAt: number
  triggerType?: 'none' | 'skill' | 'agent'
  triggerTarget?: string
}

// ─── Version constants ─────────────────────────────────

/** HClaw 应用版本号 */
export const HCLAW_VERSION = '0.1.0'

/** 当前 messages.json 的 schema 版本 */
export const MESSAGES_SCHEMA_VERSION = '2.0'

// ─── Capability catalog types ──────────────────────────

export type CapabilityType = 'skill' | 'agent' | 'command'

export interface CatalogEntry {
  name: string
  type: CapabilityType
  description: string
  trigger?: string
  /** 来源层级，用于 rank 排序（缺失视为 250） */
  source?: 'builtin' | 'user' | 'plugin'
}

export const SOURCE_KIND_CATALOG = 'capability-catalog' as const
/** command-task（<command-task>）内部消息标记：真实持久化消息，UI 层据此过滤为不可见 */
export const SOURCE_KIND_COMMAND_TASK = 'command-task' as const
/** 系统（会话级环境快照）内部消息标记：日期等环境信息 digest 变化时追加，UI 层过滤为不可见 */
export const SOURCE_KIND_SYSTEM_ENV = 'system-env' as const

export interface CatalogMetadata {
  sourceKind: typeof SOURCE_KIND_CATALOG
  catalogEntries: CatalogEntry[]
  /** 上次发布的 digest，恢复会话时读回 */
  catalogDigest?: string
}

// ─── Message (top-level) ──────────────────────────────

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  attachments?: Attachment[]
  toolCalls?: ToolCall[]
  thinkBlock?: ThinkBlock
  /** 有序内容块数组（替代扁平 content + thinkBlock + toolCalls），按时间序记录思考/文本/工具调用块 */
  contentBlocks?: ContentBlock[]
  stepsBlock?: StepsBlock
  tasksBlock?: TasksBlock
  /** 计划执行的命令列表（由用户消息本身携带） */
  plannedCommands?: string[]
  /** 消息结束时间 */
  endedAt?: number
  /** 崩溃恢复标记（§4.2）：finalizeAbnormal 写入 metadata，readMessages 平铺到顶层 */
  abnormalTermination?: boolean
  /** 消息 schema minor 版本，用于格式迁移 */
  _v?: number
  /** 预留扩展字段，未使用，非核心字段 */
  metadata?: Record<string, unknown>
  /** 扩展字段，非核心，用于 UI 显示 */
  agentName?: string
  agentType?: string
  model?: string

  /** 技能执行状态 */
  skillExecution?: SkillExecution

  /** 命令执行状态 */
  commandExecution?: CommandExecution

  /** 权限确认 */
  permissionConfirm?: PermissionConfirm

  /** LLM 调用统计信息，用于对话时判断用量 */
  llmStats?: LlmStats[]
}

/** 持久化 Envelope 格式 */
export interface MessagesFileV2 {
  schemaVersion: string
  conversationId: string
  lastModified: number
  messages: Message[]
}
