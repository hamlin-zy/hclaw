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
import {buildMcpToolNameCandidates} from '@shared/mcp/naming'

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

// ─── 为每个 MCP 工具创建代理 ──────────────────────────────────

function createMCPToolProxy(args: {
  serverId: string
  toolDef: MCPToolDefinition
  proxyName: string
  serverName?: string
}): {tool: Tool; meta: McpToolMeta} {
  const {serverId, toolDef, proxyName, serverName} = args
  const isWorker = !!parentPort

  let userDesc: string | undefined
  let autoApprove = false
  if (!isWorker) {
    const server = mainProcessMcpClient.getServer(serverId)
    userDesc = server?.config.userDescription
    autoApprove = mainProcessMcpClient.isToolAutoApproved(serverId, toolDef.name)
  }

  const inputSchema = mcpSchemaToZod(toolDef.inputSchema)
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
      const toolFullName = proxyName

      try {
        // Worker 线程：通过 MessagePort 调 MCP Worker
        if (isWorker) {
          if (mcpPort) {
            const callId = crypto.randomUUID().slice(0, 8)
            const port = mcpPort  // local ref for TS narrowing
            let handler: ((msg: any) => void) | null = null
            try {
              return await withToolTimeout(
                new Promise<ToolResult>((resolve) => {
                  handler = (msg: any) => {
                    if (msg.callId === callId) {
                      port.off('message', handler!)
                      resolve(msg.result)
                    }
                  }
                  port.on('message', handler)
                  port.postMessage({type: 'call_tool', callId, serverId, toolName: toolDef.name, args})
                }),
                toolFullName,
                timeoutMs
              )
            } finally {
              // 超时/异常路径同样移除监听器，避免共享 mcpPort 上泄漏
              if (handler) port.off('message', handler)
            }
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

// ─── 命名分配（层 2：冲突消解）─────────────────────────────────

/** 待分配的服务器（含工具清单与展示字段） */
export interface McpServerWithTools {
  id: string
  name: string
  /** 透传至 proxy.description 的「场景说明」前缀 */
  userDescription?: string
  tools: MCPToolDefinition[]
}

/**
 * 纯分配：给定"要分配的服务器集合"与"已占用名字快照"，产出每个 (serverId, rawToolName) 的 proxyName。
 * 不读写任何模块状态。导出仅为可单测（test-only 接缝）。
 *
 * 四条规则，顺序固定、不可交换：
 * 1. 确定性排序 —— servers 按 id 升序；同一 server 内 tools 按 name 升序。
 * 2. 逐项取第一个未占用候选 —— 函数内先做快照 takenLocal = new Map(taken)。
 *    → "字典序定胜负"由此自然涌现（同名组里 id 最小者拿候选1）。
 * 3. 候选耗尽兜底 —— 全部候选都被占用时，取**最后一个候选 c** 追加 `${c}_${n}`（n 从 2 递增）直到空闲。
 * 4. 自身旧名视为可复用 —— 由**调用方**在构造 taken 时剔除；本函数内部**不**剔除。
 */
export function allocateMcpToolNames(
  servers: McpServerWithTools[],
  taken: ReadonlyMap<string, string>,
): Map<string, Map<string, string>> {
  const takenLocal = new Map(taken)
  const result = new Map<string, Map<string, string>>()

  const orderedServers = [...servers].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  for (const server of orderedServers) {
    const nameMap = new Map<string, string>()
    result.set(server.id, nameMap)

    const orderedTools = [...server.tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const toolDef of orderedTools) {
      const candidates = buildMcpToolNameCandidates({
        serverId: server.id,
        serverName: server.name,
        toolName: toolDef.name,
      })

      let chosen = candidates.find((c) => !takenLocal.has(c))
      if (!chosen) {
        // 规则 3：全部候选被占用 → 取最后一个候选追加确定性后缀
        const base = candidates[candidates.length - 1]
        let n = 2
        while (takenLocal.has(`${base}_${n}`)) n++
        chosen = `${base}_${n}`
      }

      takenLocal.set(chosen, server.id)
      nameMap.set(toolDef.name, chosen)
    }
  }
  return result
}

/** 构造"已占用名字快照"，并剔除本批 serverId 自身旧名（规则 4 的调用方职责） */
function buildTakenMap(selfServerIds: Iterable<string>): Map<string, string> {
  const selfIds = new Set(selfServerIds)
  const taken = new Map<string, string>()
  for (const [proxyName, meta] of mcpToolMeta) {
    if (!selfIds.has(meta.serverId)) taken.set(proxyName, meta.serverId)
  }
  return taken
}

// ─── 公开 API ──────────────────────────────────────────

/**
 * 注册 MCP Server 的所有工具到 ToolRegistry
 *
 * ★ 契约：传入的 `tools` 必须是**最终清单**（已按 denyList 过滤）。
 *   本函数不做任何 permit 过滤 —— 发现期的 deny 过滤唯一实现点是
 *   `MCPClient.getEffectiveTools`（client.ts），活调用方 worker.ts 的 tools
 *   即来自 MCP Worker 下发的 getEffectiveTools 输出（mcpWorker.ts:359 / :449）。
 */
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

  // 步骤 1（F4）：先注销自身旧名 —— 释放旧 proxyName、清除孤儿注册项（组 4 / 组 8 的修复点）
  unregisterMCPTools(serverId)

  // 步骤 2/3：构造 taken（已剔除本服务器自身旧名）→ 分配
  const taken = buildTakenMap([serverId])
  const alloc = allocateMcpToolNames(
    [{id: serverId, name: finalServerName ?? '', userDescription: finalUserDesc, tools: serverTools}],
    taken,
  )
  const nameMap = alloc.get(serverId) ?? new Map<string, string>()

  let registered = 0
  for (const toolDef of serverTools) {
    const proxyName = nameMap.get(toolDef.name)
    if (!proxyName) continue
    const {tool: proxy, meta} = createMCPToolProxy({
      serverId,
      toolDef,
      proxyName,
      serverName: finalServerName,
    })
    if (finalUserDesc) {
      proxy.description = `[MCP:${serverId}] 场景说明: ${finalUserDesc}\n${toolDef.description || toolDef.name}`
    }
    toolRegistry.register(proxy)
    // 元数据与 registry 同生共死：proxyName 是唯一 key（由 allocateMcpToolNames 分配，
    // 不得二次推导）
    mcpToolMeta.set(proxyName, meta)
    registered++
  }
  return registered
}

/**
 * 批量注册：一次分配全体服务器的工具名（字典序确定性），与传入顺序无关。
 * 步骤：0 按 id 去重（保留首次出现）→ 1 逐 server 先注销自身旧名（F4）
 *      → 2 构造 taken → 3 allocateMcpToolNames → 4 注册（透传 name / userDescription）
 */
export function registerAllMcpTools(servers: McpServerWithTools[]): number {
  // 规则 0：按 id 去重（保留首次出现；防重复 id 造成后者覆盖前者 + 二次占名）
  const seen = new Set<string>()
  const uniq: McpServerWithTools[] = []
  for (const s of servers) {
    if (seen.has(s.id)) continue
    seen.add(s.id)
    uniq.push(s)
  }

  // 步骤 1（F4）：逐 server 先注销自身旧名（释放旧名 + 清孤儿注册项）
  for (const s of uniq) unregisterMCPTools(s.id)

  // 步骤 2/3：分配
  const taken = buildTakenMap(uniq.map((s) => s.id))
  const alloc = allocateMcpToolNames(uniq, taken)

  // 步骤 4：注册
  let registered = 0
  for (const s of uniq) {
    const nameMap = alloc.get(s.id) ?? new Map<string, string>()
    for (const toolDef of s.tools) {
      const proxyName = nameMap.get(toolDef.name)
      if (!proxyName) continue
      const {tool: proxy, meta} = createMCPToolProxy({
        serverId: s.id,
        toolDef,
        proxyName,
        serverName: s.name,
      })
      if (s.userDescription) {
        proxy.description = `[MCP:${s.id}] 场景说明: ${s.userDescription}\n${toolDef.description || toolDef.name}`
      }
      toolRegistry.register(proxy)
      mcpToolMeta.set(proxyName, meta)
      registered++
    }
  }
  return registered
}

/**
 * 注销 MCP Server 的所有工具
 *
 * proxyName 精确匹配注销：mcpToolMeta 是注册名的**唯一来源**（注册时由 allocateMcpToolNames 写入）。
 * 元数据缺失（如未经过注册入口）时直接返回 0 —— P1 之后不存在"按名推导"的第二条路径。
 */
export function unregisterMCPTools(serverId: string, _tools?: MCPToolDefinition[], _serverName?: string): number {
  let unregistered = 0
  for (const [proxyName, meta] of mcpToolMeta) {
    if (meta.serverId !== serverId) continue
    toolRegistry.unregister(proxyName)
    mcpToolMeta.delete(proxyName)
    unregistered++
  }
  return unregistered
}
