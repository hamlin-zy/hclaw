/**
 * MCP Transport 配置选项
 *
 * 注意: MCPTransport 接口已被 @modelcontextprotocol/sdk 替代，
 * 仅保留 MCPTransportOptions 供 testConnection() 的超时配置使用。
 */

/**
 * Transport 配置选项
 */
export interface MCPTransportOptions {
  /** 请求超时时间（毫秒），默认 60000 */
  requestTimeout?: number
  /** 关闭连接超时时间（毫秒），默认 5000 */
  shutdownTimeout?: number
  /** 连接超时时间（毫秒），默认 60000 */
  connectTimeout?: number
}
