/**
 * MCP Streamable HTTP Transport — 基于官方 SDK StreamableHTTPClientTransport
 *
 * MCP 规范推荐的 HTTP 传输方式，支持：
 * - HTTP POST 发送请求（JSON-RPC）
 * - 流式响应（Server-Sent Events）
 * - 会话管理（sessionId）
 * - OAuth 认证
 * - 自动重连
 */

export { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
