/**
 * MCP (Model Context Protocol) 核心类型定义
 *
 * 参考 MCP 规范定义客户端/服务端通信协议。
 * HClaw 作为 MCP Client 连接外部 MCP Server。
 */

// ─── 服务器配置 ────────────────────────────────────────

export interface MCPServerConfig {
  /** 唯一标识 */
  id: string
  /** 显示名称 */
  name: string
  /** 传输方式 */
  transport: 'stdio' | 'sse' | 'http' | 'websocket' | 'streamable-http'
  /** 命令行（stdio 模式） */
  command?: string
  /** 命令行参数 */
  args?: string[]
  /** 环境变量 */
  env?: Record<string, string>
  /** URL（sse/http/websocket 模式） */
  url?: string
  /** HTTP headers */
  headers?: Record<string, string>
  /** 工作目录（stdio 模式启动子进程时使用） */
  cwd?: string
  /**
   * 工具调用超时（毫秒）。
   * 缺省 = MCP_TOOL_TIMEOUT_NO_LIMIT_MS（不限时，见 @shared/types/mcp 常量说明）；
   * 显式配置更小值即可为单个 server 收紧超时。
   */
  timeout?: number
  /** 自动批准的工具名称列表 — 调用这些工具时无需用户确认 */
  autoApprove?: string[]
  /** 拒绝调用的工具名称列表 — Agent 禁止调用这些工具 */
  denyList?: string[]
  /** 只读守卫白名单：与 denyList 同口径的 MCP 原始工具名，命中即视为只读 */
  readOnlyTools?: string[]
  /** 只读守卫黑名单：与 denyList 同口径的 MCP 原始工具名，命中即视为写工具 */
  writeTools?: string[]
  /** 未知工具的判定策略，缺省=拦（fail-closed）；缺省不落盘，以区分「未配置」与「显式 deny」 */
  unknownPolicy?: 'allow' | 'deny'
  /** 是否自动启动 */
  autoStart?: boolean
  /** 是否启用 */
  enabled: boolean
  /** 用户自定义描述，用于指导 Agent 何时使用此服务器 */
  userDescription?: string
}

// ─── 服务器连接状态 ────────────────────────────────────

export type MCPServerStatus = 'disconnected' | 'connecting' | 'connected' | 'error' | 'stopped' | 'reconnecting'

export interface MCPServerState {
  config: MCPServerConfig
  status: MCPServerStatus
  /** 服务器信息 */
  serverInfo?: MCPServerInfo
  /** 可用工具 */
  tools: MCPToolDefinition[]
  /** 可用资源 */
  resources: MCPResource[]
  /** 错误信息 */
  error?: string
  /** 重连尝试次数 */
  reconnectAttempts?: number
  /** 最近一次错误时间戳 */
  lastErrorTime?: number
}

// ─── MCP 工具定义 ──────────────────────────────────────

/** MCP 工具行为标注（仅取只读守卫所需的两字段） */
export interface MCPToolAnnotations {
  /** 为 true 表示该工具不修改任何外部状态（MCP 规范默认 false） */
  readOnlyHint?: boolean
  /** 为 true 表示该工具可能执行破坏性更新（MCP 规范默认 true） */
  destructiveHint?: boolean
}

export interface MCPToolDefinition {
  name: string
  description?: string
  inputSchema: {
    type: 'object'
    properties?: Record<string, unknown>
    required?: string[]
  }
  annotations?: MCPToolAnnotations
}

// ─── MCP 资源 ──────────────────────────────────────────

export interface MCPResource {
  uri: string
  name: string
  description?: string
  mimeType?: string
}

export interface MCPResourceContent {
  uri: string
  mimeType?: string
  text?: string
  blob?: string // base64
}

// ─── MCP 服务器能力 ────────────────────────────────────

export interface MCPServerInfo {
  name: string
  version: string
  protocolVersion?: string
  capabilities?: {
    tools?: { listChanged?: boolean }
    resources?: { subscribe?: boolean; listChanged?: boolean }
    prompts?: { listChanged?: boolean }
    logging?: Record<string, unknown>
  }
}

// ─── MCP 工具调用结果 ──────────────────────────────────

export interface MCPToolCallResult {
  content: Array<{
    type: 'text' | 'image' | 'resource'
    text?: string
    data?: string
    mimeType?: string
    resource?: { uri: string; mimeType?: string; text?: string }
  }>
  isError?: boolean
}

// ─── Transport 配置 ────────────────────────────────────

/**
 * Transport 配置选项
 *
 * 注意: MCPTransport 接口已被 @modelcontextprotocol/sdk 替代，
 * 仅保留 MCPTransportOptions 供 testConnection() 的超时配置使用。
 */
export interface MCPTransportOptions {
  /**
   * 请求超时时间（毫秒），默认 MCP_TOOL_TIMEOUT_NO_LIMIT_MS（不限时）。
   *
   * 由 testConnection() 与运行期 callTool（client.ts 透传该字段给 SDK）共同读取；
   * 出口前会 clamp 到 Node setTimeout 的 delay 上限（见常量说明）。
   */
  requestTimeout?: number
  /** 关闭连接超时时间（毫秒），默认 5000 */
  shutdownTimeout?: number
  /** 连接/初始化握手超时时间（毫秒），默认 15000 */
  connectTimeout?: number
}
