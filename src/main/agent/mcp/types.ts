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
    /** 工具调用超时（毫秒），默认 60000 */
    timeout?: number
    /** 自动批准的工具名称列表 — 调用这些工具时无需用户确认 */
    autoApprove?: string[]
    /** 拒绝调用的工具名称列表 — Agent 禁止调用这些工具 */
    denyList?: string[]
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

export interface MCPToolDefinition {
  name: string
  description?: string
  inputSchema: {
    type: 'object'
    properties?: Record<string, unknown>
    required?: string[]
  }
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
    logging?: {}
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
