/**
 * call_mcp_tool — MCP 工具通用调用器（catalog 通道）
 *
 * 背景：catalog 通道下 MCP 工具被移出原生 tools 数组（避免 MCP server 启停导致
 * prompt 缓存前缀失效），改由 <available_mcp_tools> 目录消息 + 本工具承载。
 *
 * 职责边界（只做三件事，不重复实现调用逻辑）：
 *   1. 解析 proxy 名 → 元数据（serverId / MCP 侧原始工具名 / 原始 schema）
 *   2. 权限判定：按 (serverId, 原始工具名) 实时重查 denyList / autoApprove
 *   3. 委托 toolRegistry 中已注册的 proxy.execute（复用 MessagePort / 主进程通路、
 *      超时保护与 formatMcpResult）
 *
 * ★ args 不做 zod 强校验：mcpSchemaToZod 只支持顶层简单类型（object / anyOf / $ref /
 *   嵌套一律退化为 unknown），用它校验会误伤合法参数；MCP server 侧本身有权威校验，
 *   报错文本原样回传模型自纠。
 *
 * ★ 权限下沉（本通道唯一防线）：Plan/Explore 等只读模式下本工具仍可用（不加黑名单），
 *   因此不能依赖 PermissionEngine 的「非破坏性放行」分支，必须在工具内部自行完成
 *   (serverId, 原始工具名) 判定。详见 spec §6.6 / §8.6。
 */
import {z} from 'zod'
import type {Tool, ToolContext, ToolResult} from '../types'
import {toolRegistry} from '../registry'
import {getMcpToolMeta, getMcpToolPermission} from '../../mcp/discovery'
import {permissionRulesManager} from '../../permissions/permissionRule'
import {logger} from '../../logger'

const inputSchema = z.object({
    name: z.string().describe('MCP 工具名，取自 <available_mcp_tools> 列表（如 m_github_create_issue）'),
    args: z.record(z.string(), z.unknown()).optional().describe('工具参数对象，结构见目录中该工具标注的 args'),
})

type CallMcpToolInput = z.infer<typeof inputSchema>

const NO_META_HINT =
    '未找到该 MCP 工具。请使用 <available_mcp_tools> 目录中列出的工具名（不要直接调用 MCP 工具原始名），' +
    '若目录中没有所需工具，说明对应的 MCP server 当前未连接。'

export const callMcpTool: Tool<CallMcpToolInput, unknown> = {
    name: 'call_mcp_tool',
    description: `调用本会话可用的 MCP 工具（工具名与参数结构见 <available_mcp_tools> 目录消息）。

用法：
- name：目录中列出的完整工具名（如 m_github_create_issue），不要使用 MCP server 侧的原始工具名
- args：按目录中该工具标注的 args 结构传入参数对象

注意：
- MCP 工具未以原生工具形式声明，直接调用 MCP 工具名会失败，必须通过本工具调用
- 目录消息是工具名的唯一权威来源；若目录已更新，以最后一条目录消息为准`,
    inputSchema,
    isDestructive: false,

    async execute(input: CallMcpToolInput, context: ToolContext): Promise<ToolResult> {
        const meta = getMcpToolMeta(input.name)
        if (!meta) {
            return {success: false, output: null, error: `${NO_META_HINT}（收到: ${input.name}）`}
        }

        // ── 权限判定：按 (serverId, MCP 侧原始工具名) 实时重查 ──
        const perm = await getMcpToolPermission(meta.serverId, meta.rawToolName)

        // ★ fail-closed：权限服务不可用（无通路 / 超时 / 异常）时直接阻断，不执行 proxy。
        //   否则 auto 模式 / 无确认回调（渠道会话）下 denyList 命中的工具会被静默执行。
        if (!perm.ok) {
            return {
                success: false,
                output: null,
                error: `MCP 权限服务暂不可用，已阻止调用「${meta.rawToolName}」，请稍后重试。`,
            }
        }

        const {denied, autoApproved} = perm

        if (denied) {
            logger.info('[call_mcp_tool] denied by MCP denyList', {
                serverId: meta.serverId,
                tool: meta.rawToolName,
            })
            return {
                success: false,
                output: null,
                error: `MCP 工具「${meta.rawToolName}」已被该 server 的 denyList 禁止调用（server: ${meta.serverId}）。`,
            }
        }

        if (!autoApproved) {
            // auto 模式下全局放行；safe 模式下未列入 autoApprove 的 MCP 工具需用户确认。
            // ★ 优先取本次执行的作用域模式（子代理固定 auto，且无确认通道）；
            //   缺省时回落进程级 permissionRulesManager（主会话 safe/auto）。
            const mode = context.permissionMode ?? (await permissionRulesManager.getContext()).mode
            if (mode !== 'auto' && context.requestConfirmation) {
                const decision = await context.requestConfirmation(
                    `⚠️ MCP 工具调用确认\n\nServer: ${meta.serverName || meta.serverId}\n工具: ${meta.rawToolName}\n参数: ${safeStringify(input.args)}\n\n该工具未列入自动批准列表，是否允许执行?`,
                )
                if (decision === 'deny') {
                    return {
                        success: false,
                        output: null,
                        error: `用户拒绝执行 MCP 工具「${meta.rawToolName}」。`,
                    }
                }
            }
        }

        const proxy = toolRegistry.get(input.name)
        if (!proxy) {
            return {
                success: false,
                output: null,
                error: `MCP 工具「${input.name}」当前未注册（server 可能已断开）。请重新查看 <available_mcp_tools> 目录后重试。`,
            }
        }

        try {
            const result = await proxy.execute(input.args ?? {}, context)
            return result as ToolResult
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            logger.error('[call_mcp_tool] proxy execute failed', {tool: input.name, error: message})
            return {success: false, output: null, error: `MCP 工具调用失败: ${message}`}
        }
    },
}

/** 参数摘要（确认文案用；超长截断避免确认框膨胀） */
function safeStringify(args: Record<string, unknown> | undefined): string {
    if (!args || Object.keys(args).length === 0) return '(无)'
    try {
        const s = JSON.stringify(args)
        return s.length > 300 ? `${s.slice(0, 300)}…` : s
    } catch {
        return '(无法序列化)'
    }
}
