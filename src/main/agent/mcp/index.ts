/**
 * MCP 模块入口
 *
 * 导出 MCP Client、工具发现、类型定义
 */

export { MCPClient, mcpClient } from './client'
export { registerMCPTools, unregisterMCPTools } from './discovery'
export type {
  MCPServerConfig,
  MCPServerState,
  MCPServerInfo,
  MCPToolDefinition,
  MCPResource,
  MCPResourceContent,
  MCPToolCallResult,
  MCPServerStatus,
} from './types'
