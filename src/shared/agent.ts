/**
 * Agent 定义类型系统
 * 参考 CC 的 AgentDefinition，适配 HClaw 需求
 */

/**
 * Agent 来源类型
 */
export type AgentSource = 'built-in' | 'user'

/**
 * Agent 类型（可扩展，不再局限于 4 种）
 */
type AgentType = string

/**
 * Agent 隔离模式
 */
type AgentIsolationMode = 'worktree' | 'none'

/**
 * Agent 权限模式（可覆盖全局设置）
 */
type AgentPermissionMode = 'auto' | 'safe'

/**
 * 基础 Agent 定义接口
 */
interface BaseAgentDefinition {
  /** 唯一标识符（如 'plan', 'explore'） */
  agentType: AgentType

  /** 何时使用此 Agent（简短描述） */
  whenToUse: string

  /** 触发条件列表（when_to_use 的别名） */
  triggers?: string[]

  /** 完整描述 */
  description: string

  /** 系统提示词模板（支持占位符） */
  systemPromptTemplate: string

  /** 允许的工具白名单（undefined 或 ['*'] = 所有工具） */
  tools?: string[]

  /** 禁止的工具黑名单 */
  disallowedTools?: string[]

  /** Agent 类型标签（用于分类和 UI 展示） */
  tags?: string[]

  /** 颜色主题（用于 UI） */
  color?: string

  /** 模型覆盖（继承父 Agent 的模型） */
  model?: string

  /** 权限模式覆盖 */
  permissionMode?: AgentPermissionMode

  /** 最大轮次限制 */
  maxTurns?: number

  /** 隔离模式 */
  isolation?: AgentIsolationMode

  /** 是否为后台任务 */
  background?: boolean

  /** 必需的 MCP 服务器模式 */
  requiredMcpServers?: string[]

  /** 原始文件名（用于 user agents） */
  filename?: string
}

/**
 * Built-in Agent 定义
 *
 * 提示词通过 systemPromptTemplate 字段提供（支持 {working_dir} 等模板变量），
 * 在运行时由 renderSystemPrompt() 渲染。
 */
interface BuiltInAgentDefinition extends BaseAgentDefinition {
  source: 'built-in'

  /** 初始化回调（Agent 启动时调用） */
  callback?: () => void
}

/**
 * User Agent 定义（静态模板）
 */
interface UserAgentDefinition extends BaseAgentDefinition {
  source: 'user'

  /** 渲染后的系统提示词（模板占位符替换后的结果） */
  renderedSystemPrompt: string
}

/**
 * 联合类型
 */
export type AgentDefinition = BuiltInAgentDefinition | UserAgentDefinition

/**
 * 提示词渲染参数
 */
export interface RenderPromptParams {
  /** 当前权限模式 */
  permissionMode: AgentPermissionMode

  /** 工作目录 */
  workingDir: string

  /** Agent 类型 */
  agentType?: AgentType
}
