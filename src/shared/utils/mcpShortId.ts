/**
 * MCP shortId 工具函数
 *
 * 与 main/agent/mcp/discovery.ts 中的 shortenServerId 保持算法一致
 * 用于在渲染层将工具名中的 shortId 反查为可读的服务器名
 */

/**
 * 判断工具名是否为 MCP 工具（支持所有三种前缀格式：m_ / mp_ / mcp_）
 */
export function isMcpToolName(name: string): boolean {
  return name.startsWith('m_') || name.startsWith('mp_') || name.startsWith('mcp_')
}

/**
 * 使用 DJB2 哈希算法生成 6 字符 shortId
 * 必须与 discovery.ts 中的 shortenServerId 算法完全一致
 */
export function shortenServerId(serverId: string): string {
  let hash = 5381
  for (let i = 0; i < serverId.length; i++) {
    hash = ((hash << 5) + hash) + serverId.charCodeAt(i)
    hash |= 0
  }
  return (Math.abs(hash) >>> 0).toString(36).slice(0, 6)
}

/**
 * 从 MCP 工具名中提取 shortId 和原始工具名
 *
 * 统一格式（当前）:
 *   m_<服务器名>_<工具名>   (普通 MCP)  如 m_codegraph_codegraph_explore
 *   mp_<服务器名>_<工具名>  (插件 MCP)  如 mp_github_create_or_update_file
 *   fallback: m_/mp_<6位hash>_<工具名>
 *
 * 旧格式（兼容）:
 *   mcp_<shortId>_<工具名>  如 mcp_6x7vml_navigate_page
 *   mcp_<服务器名>_<工具名>  如 mcp_GitHub_navigate_page
 */
export function parseMcpToolName(rawName: string): { shortId: string | null; toolName: string } | null {
  if (!isMcpToolName(rawName)) return null

  // 旧格式: mcp_<6位字母数字hash>_<toolName>（兼容历史数据）
  const oldMatch = rawName.match(/^mcp_([a-z0-9]{6})_(.+)$/)
  if (oldMatch) return { shortId: oldMatch[1], toolName: oldMatch[2] }

  // 新统一格式: m_/mp_<服务器名>_<toolName> 或 m_/mp_<6位hash>_<toolName>
  const newMatch = rawName.match(/^m(p?)_([a-z0-9]{6})_(.+)$/)
  if (newMatch) return { shortId: newMatch[2], toolName: newMatch[3] }

  // 无法精确拆分（服务器名含下划线），返回 null shortId，由上层通过 mcpServers 匹配
  const prefixLen = rawName.startsWith('mp_') ? 3 : 2
  const rest = rawName.slice(prefixLen)
  if (!rest) return null
  return { shortId: null, toolName: rest }
}

/**
 * 从 MCP 工具名中提取纯工具名部分（去掉 m_/mp_/mcp_ 前缀+服务器标识）
 * 用于兜底显示 —— 当无法从 mcpServers 反查时，至少显示工具名
 */
export function extractMcpToolName(rawName: string): string | null {
  if (!isMcpToolName(rawName)) return null

  // 旧格式：去掉 mcp_HHHHHH_ 前缀
  const oldMatch = rawName.match(/^mcp_[a-z0-9]{6}_(.+)$/)
  if (oldMatch) return oldMatch[1]

  // 新格式：去掉 m_/mp_HHHHHH_ 前缀（hash fallback）
  const hashMatch = rawName.match(/^m(p?)_[a-z0-9]{6}_(.+)$/)
  if (hashMatch) return hashMatch[2]

  // 新格式（服务器名）：去掉 m_/mp_/mcp_ 前缀返回完整剩余
  if (rawName.startsWith('mp_')) return rawName.slice(3) || null
  if (rawName.startsWith('m_')) return rawName.slice(2) || null
  return rawName.slice(4) || null // mcp_
}

/**
 * 从服务器列表中构建 shortId → 服务器信息映射
 *
 * @param servers MCPServer 列表（含 id 和 name 字段）
 * @returns Map<shortId, { name: string; isPlugin: boolean }>
 */
export function buildMcpShortIdMap(
  servers: Array<{ id: string; name: string }>
): Map<string, { name: string; isPlugin: boolean }> {
  const map = new Map<string, { name: string; isPlugin: boolean }>()
  for (const server of servers) {
    const shortId = shortenServerId(server.id)
    if (!map.has(shortId)) {
      map.set(shortId, {
        name: server.name,
        isPlugin: server.id.startsWith('plugin:'),
      })
    }
  }
  return map
}

/**
 * 解析 MCP 工具名的显示名
 *
 * 从 mcpServers 列表中查找匹配的服务器和工具。
 * 统一格式下注册名即显示名（m_<serverName>_<toolName> / mp_<serverName>_<toolName>），
 * 匹配成功直接返回原名；同时兼容旧 mcp_ 格式并转换。
 * 查找不到时返回 null（调用方应自行兜底）。
 */
export function resolveMcpDisplayName(
  rawName: string,
  servers: Array<{ id: string; name: string; tools?: Array<{ name: string }> }>
): string | null {
  if (!isMcpToolName(rawName)) return null

  for (const server of servers) {
    const prefix = server.id.startsWith('plugin:') ? 'mp_' : 'm_'
    const safeServerName = server.name.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
    if (!safeServerName) continue

    // 统一格式：m_<serverName>_<toolName> / mp_<serverName>_<toolName>
    const newFormatPrefix = `${prefix}${safeServerName}_`
    if (rawName.startsWith(newFormatPrefix)) {
      const toolName = rawName.slice(newFormatPrefix.length)
      if (server.tools?.some(t => t.name === toolName)) {
        return rawName // 注册名即显示名，直接返回
      }
    }

    // 旧格式兼容：mcp_<serverName>_<toolName> → 转换为 mp_/m_
    const oldFormatPrefix = `mcp_${safeServerName}_`
    if (rawName.startsWith(oldFormatPrefix)) {
      const toolName = rawName.slice(oldFormatPrefix.length)
      if (server.tools?.some(t => t.name === toolName)) {
        return `${prefix}${server.name}_${toolName}`
      }
    }

    // 旧格式兼容：通过 shortId 匹配（同时处理 mcp_ 和新格式 fallback hash）
    if (server.tools) {
      const shortId = shortenServerId(server.id)
      for (const tool of server.tools) {
        if (rawName === `mcp_${shortId}_${tool.name}` || rawName === `${prefix}${shortId}_${tool.name}`) {
          return `${prefix}${server.name}_${tool.name}`
        }
      }
    }
  }

  return null
}
