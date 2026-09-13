/**
 * MCP 工具命名 —— 层 1：纯函数、零状态、不接收任何 peer 信息。
 *
 * 本模块是 MCP 工具名的唯一命名实现点：main（discovery.ts）用 #4/#5 生成注册名，
 * renderer / main 用 #6/#7/#8 解析回显示名。两侧共用同一段生成规则，
 * 因此"注册名与解析规则漂移"在结构上不可能再发生（spec §3.5）。
 *
 * 约束：零依赖（不得 import src/main、不得 import electron）。
 */

// ─── 类型 ────────────────────────────────────────────────────

/** 调用方提供的服务器身份（renderer 传 mcpServers，main 传自身配置） */
export interface McpServerIdentity {
  id: string
  name: string
  /** 仅 resolveMcpDisplayName 用于校验工具是否存在；其余函数忽略 */
  tools?: Array<{ name: string }>
}

/** 解析结果 */
export interface McpToolNameParts {
  /** 命中的服务器 id（含 plugin: 前缀，原样）；未命中 undefined */
  serverId?: string
  /** 命中的服务器名（原始名，非净化名） */
  serverName?: string
  /** 工具名（已剥离前缀与 server 段） */
  toolName: string
  /** 仅在 legacy 正则兜底命中时为 hash；候选命中恒 null */
  shortId: string | null
  /** 仅候选段命中时有值 = rawName 中实际命中的那一段；legacy 兜底恒 undefined */
  matchedSegment?: string
}

// ─── 1. 前缀判定 ─────────────────────────────────────────────

/** 判断工具名是否为 MCP 工具（m_ / mp_ / mcp_ 三前缀）。main 侧也在用（loop/setup.ts:32、worker.ts:13） */
export function isMcpToolName(name: string): boolean {
  return name.startsWith('m_') || name.startsWith('mp_') || name.startsWith('mcp_')
}

// ─── 2. 净化 ─────────────────────────────────────────────────

/** 净化名称：非法字符→`_`、连续 `_` 合并、去首尾 `_`。规则与旧 discovery.sanitizeToolName 逐字节一致 */
export function sanitizeToolName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
}

// ─── 3. shortId ──────────────────────────────────────────────

/**
 * DJB2 → base36 → slice(0,6)。**纯函数、无 memo**（旧 discovery.shortIdMap memo 随迁删除）。
 * 算法不得改动：shortenServerId('github')==='1vooo'、('codegraph')==='w39s0i'。
 */
export function shortenServerId(serverId: string): string {
  let hash = 5381
  for (let i = 0; i < serverId.length; i++) {
    hash = ((hash << 5) + hash) + serverId.charCodeAt(i)
    hash |= 0
  }
  return (Math.abs(hash) >>> 0).toString(36).slice(0, 6)
}

// ─── 4. 段生成（★核心） ──────────────────────────────────────

/**
 * 返回**去重后**的 server 段列表，**顺序即优先级**：
 * ① sanitizeToolName(serverName)（undefined / 空串 / 净化后为空时跳过）
 * ② sanitizeToolName(serverId.replace(/^plugin:/, ''))（为空或与 ① 相同则跳过）
 * ③ shortenServerId(serverId)（输入为原始 serverId，含 plugin: 前缀；与 ①② 相同则剔除；恒在列）
 */
export function buildMcpServerSegments(args: { serverId: string; serverName?: string }): string[] {
  const {serverId, serverName} = args
  const segs: string[] = []
  const seg1 = serverName ? sanitizeToolName(serverName) : ''
  if (seg1) segs.push(seg1)
  const seg2 = sanitizeToolName(serverId.replace(/^plugin:/, ''))
  if (seg2 && seg2 !== seg1) segs.push(seg2)
  const seg3 = shortenServerId(serverId)
  if (seg3 && !segs.includes(seg3)) segs.push(seg3)
  return segs
}

// ─── 5. 候选名 ───────────────────────────────────────────────

/**
 * segments.map(seg => `${prefix}${seg}_${safeTool}`) 后去重。
 * prefix = serverId.startsWith('plugin:') ? 'mp_' : 'm_'
 * safeTool = sanitizeToolName(toolName) || shortenServerId(toolName)
 */
export function buildMcpToolNameCandidates(args: { serverId: string; serverName?: string; toolName: string }): string[] {
  const prefix = args.serverId.startsWith('plugin:') ? 'mp_' : 'm_'
  const safeTool = sanitizeToolName(args.toolName) || shortenServerId(args.toolName)
  const out: string[] = []
  for (const seg of buildMcpServerSegments(args)) {
    const candidate = `${prefix}${seg}_${safeTool}`
    if (!out.includes(candidate)) out.push(candidate)
  }
  return out
}

// ─── 6. 解析（候选驱动） ─────────────────────────────────────

/**
 * 1. 三前缀不匹配 → null
 * 2. 给了 servers：对每个 server 的每个段做**最长段前缀匹配**（段后必须紧跟 `_`，剩余非空且不以 `_` 开头）；
 *    命中返回 {serverId, serverName, matchedSegment, toolName, shortId:null}；
 *    多个命中取**最长段**，同长取 **id 升序第一个**（确定性）。
 * 3. 未命中 → legacy 正则兜底 mcp_<hash>_ / m_<hash>_ / mp_<hash>_ → {shortId, toolName}
 *    （serverId / serverName / matchedSegment 均省略 —— matchedSegment 语义严格限定为"候选段命中"）。
 * 4. 仍不可拆 → {shortId: null, toolName: rest}
 */
export function parseMcpToolName(rawName: string, servers?: McpServerIdentity[]): McpToolNameParts | null {
  if (!isMcpToolName(rawName)) return null

  // 前缀长度：mcp_=4 / mp_=3 / m_=2（三前缀互斥，由 isMcpToolName 保证命中其一）
  const prefixLen = rawName.startsWith('mcp_') ? 4 : rawName.startsWith('mp_') ? 3 : 2
  const rest = rawName.slice(prefixLen)

  if (servers && servers.length > 0) {
    let best: {serverId: string; serverName: string; matchedSegment: string; toolName: string} | null = null
    for (const server of servers) {
      for (const seg of buildMcpServerSegments({serverId: server.id, serverName: server.name})) {
        if (!rest.startsWith(`${seg}_`)) continue
        const toolName = rest.slice(seg.length + 1)
        if (!toolName || toolName.startsWith('_')) continue
        const better =
          !best ||
          seg.length > best.matchedSegment.length ||
          (seg.length === best.matchedSegment.length && server.id < best.serverId)
        if (better) best = {serverId: server.id, serverName: server.name, matchedSegment: seg, toolName}
      }
    }
    if (best) {
      return {
        serverId: best.serverId,
        serverName: best.serverName,
        matchedSegment: best.matchedSegment,
        toolName: best.toolName,
        shortId: null,
      }
    }
  }

  // legacy 正则兜底（向后兼容历史数据）
  const oldMatch = rawName.match(/^mcp_([a-z0-9]{6})_(.+)$/)
  if (oldMatch) return {shortId: oldMatch[1], toolName: oldMatch[2]}
  const newMatch = rawName.match(/^m(p?)_([a-z0-9]{6})_(.+)$/)
  if (newMatch) return {shortId: newMatch[2], toolName: newMatch[3]}

  if (!rest) return null
  return {shortId: null, toolName: rest}
}

// ─── 7. 提取纯工具名 ─────────────────────────────────────────

/** 与 #6 同源实现，只返回 toolName */
export function extractMcpToolName(rawName: string, servers?: McpServerIdentity[]): string | null {
  const parts = parseMcpToolName(rawName, servers)
  return parts ? parts.toolName : null
}

// ─── 8. 显示名 ───────────────────────────────────────────────

/**
 * (A) 候选段命中（parts.serverId !== undefined，matchedSegment 必有值）：
 *     前缀按 parts.serverId 的 plugin 性取 mp_/m_ → `<前缀><matchedSegment>_<toolName>`；
 *     校验 servers 中 id === parts.serverId 的项的 tools 含 parts.toolName，否则 null。
 * (B) legacy 兜底（serverId === undefined && shortId !== null）：
 *     在 servers 中按 shortenServerId(s.id) === shortId 反查**第一个**命中者；
 *     校验其 tools 含 parts.toolName；返回 `<前缀><shortId>_<toolName>`；无命中 → null。
 * (C) 不可拆 → null。
 * 行为变化（有意修好，见 spec §3.4 变化 4 / §3.5.4）：server 段来源由『原始 server.name』改为『命中段 / hash』。
 */
export function resolveMcpDisplayName(rawName: string, servers: McpServerIdentity[]): string | null {
  const parts = parseMcpToolName(rawName, servers)
  if (!parts) return null

  if (parts.serverId !== undefined) {
    const server = servers.find((s) => s.id === parts.serverId)
    if (!server?.tools?.some((t) => t.name === parts.toolName)) return null
    const prefix = parts.serverId.startsWith('plugin:') ? 'mp_' : 'm_'
    return `${prefix}${parts.matchedSegment}_${parts.toolName}`
  }

  if (parts.shortId !== null) {
    const server = servers.find((s) => shortenServerId(s.id) === parts.shortId)
    if (!server?.tools?.some((t) => t.name === parts.toolName)) return null
    const prefix = server.id.startsWith('plugin:') ? 'mp_' : 'm_'
    return `${prefix}${parts.shortId}_${parts.toolName}`
  }

  return null
}
