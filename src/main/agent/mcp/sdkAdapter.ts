/**
 * SDK 类型映射适配器
 *
 * 将 @modelcontextprotocol/sdk 的类型映射到 HClaw 内部 MCP 类型，
 * 作为 Adapter 模式的胶水层。
 */

import type { MCPToolDefinition, MCPToolCallResult } from './types'

/**
 * 将 SDK Tool 类型转为 HClaw 的 MCPToolDefinition
 *
 * 丢弃的输出字段：
 * - outputSchema (2025-11-25 新规范，HClaw 暂不使用)
 * - annotations, icons, title (SDK 独有元数据)
 * - execution (Task support, HClaw 暂不支持)
 */
export function toMcpToolDefinition(tool: {
  name: string
  description?: string
  inputSchema: {
    type: 'object'
    properties?: Record<string, unknown>
    required?: string[]
  }
}): MCPToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }
}

/**
 * 将 SDK CallToolResult 转为 HClaw 的 MCPToolCallResult
 *
 * ContentBlock 映射规则：
 * - TextContent → { type: 'text', text }
 * - ImageContent → { type: 'image', data, mimeType }
 * - EmbeddedResource → { type: 'resource', resource }
 * - AudioContent → 丢弃（HClaw 不支持音频）
 * - ResourceLink → 丢弃（HClaw 不支持纯链接资源）
 * - structuredContent → 丢弃（mcpWorker.ts 只读 content 的 text 块）
 */
export function toMcpToolCallResult(result: {
  content: Array<{
    type: string
    text?: string
    data?: string
    mimeType?: string
    resource?: { uri: string; mimeType?: string; text?: string }
  }>
  isError?: boolean
}): MCPToolCallResult {
  return {
    content: result.content.map(c => {
      if (c.type === 'text') {
        return { type: 'text' as const, text: c.text }
      }
      if (c.type === 'image') {
        return { type: 'image' as const, data: c.data, mimeType: c.mimeType }
      }
      if (c.type === 'resource') {
        return { type: 'resource' as const, resource: c.resource || { uri: '' } }
      }
      // AudioContent, ResourceLink → 当前不支持，返回空文本占位
      return { type: 'text' as const, text: '' }
    }),
    isError: result.isError ?? false,
  }
}
