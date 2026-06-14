/**
 * MCP 工具发现 — 将 MCP Server 的工具注册到 ToolRegistry
 *
 * 流程：
 * 1. 连接 MCP Server → 发现工具
 * 2. 为每个 MCP 工具创建代理 Tool 实例
 * 3. 注册到全局 ToolRegistry
 * 4. 调用时转发到 MCP Server
 */

import {logger} from '../logger'
import {z} from 'zod'
import crypto from 'crypto'
import {MessagePort, parentPort} from 'worker_threads'
import {toolRegistry} from '../tools/registry'
import type {Tool, ToolContext, ToolResult} from '../tools/types'
import type {MCPToolDefinition} from './types'
import {mcpClient as mainProcessMcpClient} from './client'
import {createTimeoutResult, ToolTimeoutError, withToolTimeout} from '../tools/toolTimeout'

// ─── MessagePort 注入（Phase 2）────────────────────────────────
//
// Phase 2: Agent Worker 通过 MessagePort 直连 MCP Worker，
// 共享 MCP 连接池，无需每个 Worker 自建连接。
let mcpPort: MessagePort | null = null

/** 设置 MCP Worker 的 MessagePort（从 worker.ts 启动时注入） */
export function setMcpMessagePort(port: MessagePort | null): void {
    mcpPort = port
}

/** 获取当前可用的 MCPClient（主进程使用）或 MessagePort（Worker 使用） */
function getCurrentClient(): any {
    return mcpPort || mainProcessMcpClient
}

/** 从 MCP 响应中提取纯文本内容 */
function formatMcpResult(result: any): Pick<ToolResult, 'success' | 'output' | 'error'> {
    const textParts = (result.content || [])
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n')
    return {
        success: !result.isError,
        output: textParts || '(无输出)',
        error: result.isError ? textParts : undefined,
    }
}

// ─── 服务器 ID 缩短 ────────────────────────────────────────────

/**
 * 将 MCP 服务器 ID 缩短为 6 字符哈希前缀
 * 避免工具名过长（如 mcp_plugin_github_my-server_list_issues → mcp_a3f2b1_list_issues）
 *
 * 内部维护 serverId ↔ shortId 双向映射，确保同一 serverId 始终映射到同一 shortId
 */
const shortIdMap = new Map<string, string>()
const reverseShortIdMap = new Map<string, string>()

function shortenServerId(serverId: string): string {
  const cached = shortIdMap.get(serverId)
  if (cached) return cached

  let hash = 5381
  for (let i = 0; i < serverId.length; i++) {
    hash = ((hash << 5) + hash) + serverId.charCodeAt(i)
    hash |= 0
  }
  const shortId = (Math.abs(hash) >>> 0).toString(36).slice(0, 6)

  shortIdMap.set(serverId, shortId)
  reverseShortIdMap.set(shortId, serverId)
  return shortId
}

/** 从 shortId 反查原始 serverId */
export function resolveServerId(shortId: string): string | undefined {
  return reverseShortIdMap.get(shortId)
}

// ─── 工具名净化 ───────────────────────────────────────────────

/**
 * 净化工具名称，确保符合 OpenAI/Anthropic 的 function.name 模式要求
 * 模式要求: ^[a-zA-Z0-9_-]+$
 *
 * 将非法字符替换为下划线，移除前缀或后缀下划线
 */
function sanitizeToolName(name: string): string {
    return name
        .replace(/[^a-zA-Z0-9_-]/g, '_')   // 非法字符 → 下划线
        .replace(/_+/g, '_')                // 连续下划线 → 单下划线
        .replace(/^_|_$/g, '')              // 移除首尾下划线
}

// ─── 为每个 MCP 工具创建代理 ──────────────────────────────────

/**
 * 已使用的工具名集合，用于检测新格式下的命名冲突
 */
const usedToolNames = new Set<string>()

/**
 * 生成 MCP 工具注册名
 *
 * 格式统一为 UI 展示同名：
 * - 普通 MCP: m_<服务器名>_<工具名>（如 m_codegraph_codegraph_explore）
 * - 插件 MCP: mp_<服务器名>_<工具名>（如 mp_github_create_or_update_file）
 * - 服务器名不可用时 fallback 到 m_/mp_<shortId>_<工具名>
 *
 * 此命名与 LLM 看到的 function name 完全一致，消除 LLM "去前缀" 行为。
 */
function buildMcpToolName(serverId: string, serverName: string | undefined, toolName: string): string {
    const isPlugin = serverId.startsWith('plugin:')
    const prefix = isPlugin ? 'mp_' : 'm_'
    const safeName = serverName ? sanitizeToolName(serverName) : ''

    // 尝试用 serverName 作为前缀（可读）
    if (safeName) {
        const candidate = `${prefix}${safeName}_${toolName}`
        if (!usedToolNames.has(candidate)) {
            usedToolNames.add(candidate)
            return candidate
        }
    }

    // fallback: 用 shortId（唯一但不可读）
    const shortId = shortenServerId(serverId)
    const fallback = `${prefix}${shortId}_${toolName}`
    usedToolNames.add(fallback)
    return fallback
}

function createMCPToolProxy(
  serverId: string,
  toolDef: MCPToolDefinition,
  serverName?: string,
): Tool {
    const isWorker = !!parentPort

    let userDesc: string | undefined
    let autoApprove = false
    if (!isWorker) {
        const server = mainProcessMcpClient.getServer(serverId)
        userDesc = server?.config.userDescription
        autoApprove = mainProcessMcpClient.isToolAutoApproved(serverId, toolDef.name)
    }

  const inputSchema = mcpSchemaToZod(toolDef.inputSchema)
  const rawName = buildMcpToolName(serverId, serverName, toolDef.name)
    const baseDesc = `[MCP:${serverId}] ${userDesc ? `场景说明: ${userDesc}\n` : ''}`

  return {
    name: sanitizeToolName(rawName),
      description: `${baseDesc}${toolDef.description || toolDef.name}`,
    inputSchema,
    isDestructive: false,
      autoApprove,

      /**
       * Phase 2 优化:
       * - Worker 线程: 通过 MessagePort 直连 MCP Worker（共享连接池）
       * - 无 MessagePort 时: 返回错误（不自建连接）
       * - 主进程: 直接调 mainProcessMcpClient（仅用于 UI 侧 MCP IPC）
       */
    async execute(args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
          // 获取 MCP 服务器的超时配置（默认 60 秒）
          const serverConfig = !isWorker ? mainProcessMcpClient.getServer(serverId)?.config : null
          const timeoutMs = serverConfig?.timeout != null ? serverConfig.timeout : 60_000
          const toolFullName = rawName

          try {
              // Worker 线程：通过 MessagePort 调 MCP Worker
              if (isWorker) {
                  if (mcpPort) {
                      const callId = crypto.randomUUID().slice(0, 8)
                      const port = mcpPort  // local ref for TS narrowing
                      return await withToolTimeout(
                          new Promise<ToolResult>((resolve) => {
                              const handler = (msg: any) => {
                                  if (msg.callId === callId) {
                                      port.off('message', handler)
                                      resolve(msg.result)
                                  }
                              }
                              port.on('message', handler)
                              port.postMessage({type: 'call_tool', callId, serverId, toolName: toolDef.name, args})
                          }),
                          toolFullName,
                          timeoutMs
                      )
                  }
                  // 无 MessagePort（MCP Worker 未就绪或崩溃），不注册此工具
                  return {success: false, output: null, error: 'MCP Worker 不可用，工具未注册'}
              }

              // 主进程：直接调用（带超时保护）
              return await withToolTimeout(
                  mainProcessMcpClient.callTool(serverId, toolDef.name, args).then(formatMcpResult),
                  toolFullName,
                  timeoutMs
              )
          } catch (err: any) {
              // 处理超时错误
              if (err instanceof ToolTimeoutError) {
                  return createTimeoutResult(toolFullName, err.timeoutMs)
              }
              logger.error('[MCP Discovery] callTool failed', {error: err.message, tool: toolFullName})
              return {success: false, output: null, error: `MCP 工具调用失败: ${err.message}`}
          }
    },
  }
}

// ─── 将 MCP inputSchema 转换为 Zod Schema ────────────────────

function mcpSchemaToZod(
  schema: MCPToolDefinition['inputSchema'],
): z.ZodType<any> {
  const properties = schema.properties || {}
  const required = schema.required || []

  const shape: Record<string, z.ZodTypeAny> = {}

  for (const [key, prop] of Object.entries(properties)) {
    const propObj = prop as { type?: string; description?: string; enum?: string[] }
    let field: z.ZodTypeAny

    switch (propObj.type) {
      case 'string':
        field = propObj.enum
          ? z.enum(propObj.enum)
          : z.string()
        break
      case 'number':
      case 'integer':
        field = z.number()
        break
      case 'boolean':
        field = z.boolean()
        break
      case 'array':
        field = z.array(z.unknown())
        break
      default:
        field = z.unknown()
    }

    if (propObj.description) {
      field = field.describe(propObj.description)
    }

    if (!required.includes(key)) {
      field = field.optional()
    }

    shape[key] = field
  }

  return z.object(shape)
}

// ─── 公开 API ──────────────────────────────────────────

/**
 * 过滤 denyList 中的工具
 */
function filterDeniedTools(serverId: string, tools: MCPToolDefinition[]): MCPToolDefinition[] {
    const mcp = getCurrentClient()
    const deniedNames = mcp.getDeniedToolNames?.(serverId) ?? []
    if (!deniedNames.length) return tools

    const filtered = tools.filter(t => !mcp.isToolDenied(serverId, t.name))
    if (filtered.length !== tools.length) {
        logger.debug(`[MCP] ${serverId}: 过滤 ${tools.length - filtered.length} 个被 denyList 禁止的工具`)
    }
    return filtered
}

/** 注册 MCP Server 的所有工具到 ToolRegistry */
export function registerMCPTools(
    serverId: string,
    tools?: MCPToolDefinition[],
    userDescription?: string,
    serverName?: string,
): number {
    let serverTools = tools
    let finalUserDesc = userDescription
    let finalServerName = serverName

    if (!serverTools) {
        const mcp = getCurrentClient()
        const server = mcp.getServer?.(serverId)
        if (!server) return 0
        serverTools = server.tools
        finalUserDesc = server.config.userDescription
        finalServerName = finalServerName || server.name
    }

    if (!serverTools?.length) return 0

    serverTools = filterDeniedTools(serverId, serverTools)

  let registered = 0
    for (const toolDef of serverTools) {
    const proxy = createMCPToolProxy(serverId, toolDef, finalServerName)
        if (finalUserDesc) {
            proxy.description = `[MCP:${serverId}] 场景说明: ${finalUserDesc}\n${toolDef.description || toolDef.name}`
        }
    toolRegistry.register(proxy)
    registered++
  }
  return registered
}

/** 注销 MCP Server 的所有工具 */
export function unregisterMCPTools(serverId: string, tools?: MCPToolDefinition[], serverName?: string): number {
    let serverTools = tools
    let finalServerName = serverName
    if (!serverTools) {
        const mcp = getCurrentClient()
        const server = mcp.getServer?.(serverId)
        if (!server) return 0
        serverTools = server.tools
        finalServerName = finalServerName || server.name
    }

    if (!serverTools?.length) return 0
    serverTools = filterDeniedTools(serverId, serverTools)

  let unregistered = 0
    for (const toolDef of serverTools) {
        const rawName = buildMcpToolName(serverId, finalServerName, toolDef.name)
    toolRegistry.unregister(sanitizeToolName(rawName))
    unregistered++
  }
  return unregistered
}
