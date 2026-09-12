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
import {formatMcpResult} from './formatResult'

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

// formatMcpResult 已抽取到 ./formatResult.ts，此处通过 import 共用

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

// ─── MCP 工具元数据映射（proxy 注册名 ↔ 原始身份/原始 schema）─────
//
// 动机：proxy 注册名（m_<server>_<tool>）不携带 (serverId, 原始工具名) 与原始 schema，
// 而 catalog 通道下 call_mcp_tool 需要：
//   1. 权限判定 → 必须用 MCP 侧原始工具名（mcps.deny_list / auto_approve 存的是原始名）
//   2. 目录渲染 → 必须用原始 inputSchema（mcpSchemaToZod 只支持顶层简单类型，
//      array/object/anyOf/$ref 一律退化为 unknown，proxy.inputSchema 已丢失约束）
//
// 生命周期与 toolRegistry 一致，均在 worker 线程内。不跨进程。

export interface McpToolMeta {
  /** m_<server>_<tool>，即 tools 数组 / 目录中展示的名字 */
  proxyName: string
  /** 唯一稳定标识（插件 MCP 含 plugin: 前缀） */
  serverId: string
  /** 展示名 */
  serverName?: string
  /** MCP 侧原始工具名（权限判定用这个，不是 proxy 名） */
  rawToolName: string
  /** MCP 侧原始工具描述（能力目录渲染用；缺失时目录回退到 rawToolName） */
  description?: string
  /** 原始 inputSchema（未经 mcpSchemaToZod 转换） */
  rawInputSchema: MCPToolDefinition['inputSchema']
}

const mcpToolMeta = new Map<string, McpToolMeta>()   // key = proxyName

/** 按 proxy 注册名查询 MCP 工具元数据 */
export function getMcpToolMeta(proxyName: string): McpToolMeta | undefined {
  return mcpToolMeta.get(proxyName)
}

/** 获取全部 MCP 工具元数据（供能力目录收集） */
export function getAllMcpToolMeta(): McpToolMeta[] {
  return Array.from(mcpToolMeta.values())
}

/** 清空全部元数据（worker 批量注销 MCP 工具时同步清理） */
export function clearAllMcpToolMeta(): void {
  mcpToolMeta.clear()
}

// ─── 执行期权限判定（MCP 专属通路）────────────────────────────
//
// 现状：denyList 只在注册/发现期过滤，autoApprove 在注册期物化到 Tool.autoApprove。
// catalog 通道下 MCP 工具不在 tools 数组内，proxy 的这两个字段不再被 executor 使用，
// 因此 call_mcp_tool 必须按 (serverId, 原始工具名) 实时重查。
//
// 主进程直连 mainProcessMcpClient；worker 线程需经 MessagePort 转发到 MCP Worker
// （agent worker 内没有 MCPClient 实例）。

export interface McpToolPermission {
  /** denyList 命中 → 禁止调用 */
  denied: boolean
  /** autoApprove 命中 → 调用无需用户确认 */
  autoApproved: boolean
  /**
   * 权限查询是否成功。
   * false = 权限服务不可用（无 MessagePort 通路 / 3s 超时 / 抛异常），
   * 此时 denied/autoApproved 均为占位值，调用方**必须 fail-closed**（直接阻断，不得执行）。
   */
  ok: boolean
}

/** 权限查询超时（超时无法判定 → 返回 ok:false，由调用方 fail-closed 阻断，而非退回用户确认） */
const MCP_PERMISSION_QUERY_TIMEOUT_MS = 3000

/**
 * 按 (serverId, 原始工具名) 实时查询 denyList / autoApprove。
 *
 * ★ fail-closed：查询失败/超时/无通路时返回 {ok:false}，调用方必须直接阻断调用。
 *   原实现按「未命中」处理并退回用户确认，但 auto 模式 / 无确认回调（渠道会话）下
 *   根本不会确认，会导致 denyList 命中的工具被静默执行（§6.6 声明这是唯一防线）。
 */
export async function getMcpToolPermission(serverId: string, rawToolName: string): Promise<McpToolPermission> {
  const fallback: McpToolPermission = {denied: false, autoApproved: false, ok: false}
  try {
    if (parentPort) {
      if (!mcpPort) return fallback
      const port = mcpPort
      return await new Promise<McpToolPermission>((resolve) => {
        const callId = crypto.randomUUID().slice(0, 8)
        const handler = (msg: any) => {
          if (msg?.type === 'tool_permission_result' && msg.callId === callId) {
            clearTimeout(timer)
            port.off('message', handler)
            resolve({denied: !!msg.denied, autoApproved: !!msg.autoApproved, ok: true})
          }
        }
        const timer = setTimeout(() => {
          port.off('message', handler)
          resolve(fallback)
        }, MCP_PERMISSION_QUERY_TIMEOUT_MS)
        port.on('message', handler)
        port.postMessage({type: 'get_tool_permission', callId, serverId, toolName: rawToolName})
      })
    }
    // 主进程：直连
    return {
      denied: mainProcessMcpClient.isToolDenied(serverId, rawToolName),
      autoApproved: mainProcessMcpClient.isToolAutoApproved(serverId, rawToolName),
      ok: true,
    }
  } catch {
    return fallback
  }
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
): {tool: Tool; proxyName: string; meta: McpToolMeta} {
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
  const proxyName = sanitizeToolName(rawName)
    const baseDesc = `[MCP:${serverId}] ${userDesc ? `场景说明: ${userDesc}\n` : ''}`

  const tool: Tool = {
    name: proxyName,
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

  return {
    tool,
    proxyName,
    meta: {
      proxyName,
      serverId,
      serverName,
      rawToolName: toolDef.name,
      description: toolDef.description,
      rawInputSchema: toolDef.inputSchema,
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
    const {tool: proxy, proxyName, meta} = createMCPToolProxy(serverId, toolDef, finalServerName)
        if (finalUserDesc) {
            proxy.description = `[MCP:${serverId}] 场景说明: ${finalUserDesc}\n${toolDef.description || toolDef.name}`
        }
    toolRegistry.register(proxy)
    // 元数据与 registry 同生共死：proxy 名是唯一 key（注册名可能因冲突回退到 shortId，
    // 不能靠 buildMcpToolName 二次推导）
    mcpToolMeta.set(proxyName, meta)
    registered++
  }
  return registered
}

/**
 * 注销 MCP Server 的所有工具
 *
 * ★ 优先按元数据映射（proxyName 精确匹配）注销：buildMcpToolName 依赖模块级
 *   usedToolNames 去重集合，二次调用同一 (serverId, toolName) 会返回 fallback
 *   shortId 名（与注册名不同），导致注销失效。元数据表持有注册时的真实 proxyName。
 */
export function unregisterMCPTools(serverId: string, tools?: MCPToolDefinition[], serverName?: string): number {
    let unregistered = 0
    for (const [proxyName, meta] of mcpToolMeta) {
        if (meta.serverId !== serverId) continue
        toolRegistry.unregister(proxyName)
        mcpToolMeta.delete(proxyName)
        unregistered++
    }
    if (unregistered > 0) return unregistered

    // 兜底：元数据缺失（如未经过 registerMCPTools 的历史路径）仍按旧逻辑推导名称
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

    for (const toolDef of serverTools) {
        const rawName = buildMcpToolName(serverId, finalServerName, toolDef.name)
    toolRegistry.unregister(sanitizeToolName(rawName))
    unregistered++
  }
  return unregistered
}
