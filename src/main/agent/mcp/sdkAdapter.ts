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
 * 采集的输出字段：
 * - annotations（仅取 readOnlyHint / destructiveHint 两字段，作为只读写守卫的判定依据；
 *   两者皆 undefined 时**不写该键** —— SDK 的 ToolAnnotations 全字段可选，
 *   只声明 title/idempotentHint 等的工具若投影成空壳 {readOnlyHint: undefined, ...}，
 *   会被 writeClassify 判成 write 而误拦，故此处按「无有效标注」处理）
 *
 * 丢弃的输出字段：
 * - outputSchema (2025-11-25 新规范，HClaw 暂不使用)
 * - icons, title (SDK 独有元数据)
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
  annotations?: {
    readOnlyHint?: boolean
    destructiveHint?: boolean
  }
}): MCPToolDefinition {
  const def: MCPToolDefinition = {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }
  if (tool.annotations
    && (tool.annotations.readOnlyHint !== undefined || tool.annotations.destructiveHint !== undefined)) {
    def.annotations = {
      readOnlyHint: tool.annotations.readOnlyHint,
      destructiveHint: tool.annotations.destructiveHint,
    }
  }
  return def
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
