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
import type {PermissionRule} from '@shared/types'
import type {Tool, ToolContext, ToolResult} from '../types'
import {toolRegistry} from '../registry'
import {getMcpToolMeta, getMcpToolPermission} from '../../mcp/discovery'
import {permissionRulesManager} from '../../permissions/permissionRule'
import {permissionEngine, matchesToolRulePattern, isProxyScopedMcpToolPattern} from '../permission'
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

        // ── 显式权限规则（权限面板）──
        // 顺序说明：放在 MCP denyList 之后（denyList 是 server 级硬约束，优先级最高），
        // 但放在 autoApprove 之前 —— 规则 deny 必须能压过 autoApprove，否则面板里加的
        // 拒绝规则会被 server 的 autoApprove 静默绕过。
        //
        // ★ 规则分工（避免与 executor 的 PermissionEngine.check 双重判定）：
        //   - `m_*`（proxy 名）规则 = MCP 专属严格层，由**本工具内**消费：
        //     deny 硬拒 / ask 弹确认 / allow 跳过确认（含 m_github_* glob）。
        //   - `call_mcp_tool` / `*`（含 call_mcp_*）名规则 = **引擎层**语义：executor 对
        //     tool=call_mcp_tool 的判定已消费这些规则（deny/ask 均表现为「需确认」，
        //     弹窗由 executor 发起；用户允许后才会走到这里）。工具内不再重复判定，
        //     否则会出现双弹窗，或「用户已授权却被工具内硬拒」的矛盾结论。
        //     工具内仅借其 allow 结论 / 引擎已判定的既有事实跳过自己的确认。
        const rules = await permissionRulesManager.getRules()

        // proxy 作用域：唯一能产生「工具内硬拒」的来源
        const matchedRule = findMatchingMcpRule(rules, meta.proxyName)

        if (matchedRule?.action === 'deny') {
            logger.info('[call_mcp_tool] denied by permission rule', {
                tool: meta.rawToolName,
                rule: matchedRule.tool,
            })
            return {
                success: false,
                output: null,
                error: `MCP 工具「${meta.rawToolName}」被本地权限规则「${matchedRule.tool}」禁止调用，请先在权限设置中移除或修改该规则。`,
            }
        }

        // 引擎层规则命中（* / call_mcp_tool / call_mcp_*）：deny/ask 已由 executor 弹过确认
        // （用户允许才走到这里），allow 则由引擎放行 —— 工具内一律不再重复确认/拒绝。
        const engineHandled = rules.some(r => r.tool && matchesToolRulePattern(r.tool, 'call_mcp_tool'))

        // 跳过工具内确认的条件：autoApprove / proxy 作用域 allow / 引擎层规则已判定。
        const skipInternalConfirm = autoApproved || matchedRule?.action === 'allow' || engineHandled

        // auto 模式下全局放行；safe 模式下未列入 autoApprove 的 MCP 工具需用户确认。
        // ★ 优先取本次执行的作用域模式（子代理固定 auto，且无确认通道）；
        //   缺省时回落进程级 permissionRulesManager（主会话 safe/auto）。
        // ★ proxy 作用域 ask 规则视为**模式无关**：引擎层对 ask 规则在 auto 下仍弹
        //   （check() 先匹配规则再短路 auto），工具内不得因 auto / autoApprove / 引擎层已
        //   判定而静默放行，否则面板里的「询问」规则形同虚设。
        const needsConfirm =
            matchedRule?.action === 'ask' ||
            (!skipInternalConfirm &&
                (context.permissionMode ?? (await permissionRulesManager.getContext()).mode) !== 'auto')

        // ★ ask 规则在无确认通道时 fail-closed：该规则语义就是「必须经用户同意」，
        //   没有通道却放行等于静默绕过（子代理固定 auto 且无确认回调，正是这种形态）。
        //   非 auto 的缺省确认在无通道时保持既有语义（与 native 通道一致，直接执行）。
        if (needsConfirm && !context.requestConfirmation && matchedRule?.action === 'ask') {
            return {
                success: false,
                output: null,
                error: `MCP 工具「${meta.rawToolName}」被本地权限规则「${matchedRule.tool}」设为需确认，但当前会话没有确认通道，已阻止调用。`,
            }
        }

        if (needsConfirm && context.requestConfirmation) {
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
            if (decision === 'always') {
                // 「始终允许」→ 落库一条针对该 proxy 的 allow 规则（颗粒度对齐单个 MCP 工具），
                // 否则下次调用仍会弹确认（旧实现只处理 deny，always 被静默吞掉）。
                await permissionEngine.addRule({tool: meta.proxyName, action: 'allow'})
                // 立即通知前端刷新规则列表，无需等待 agent loop 的下一次迭代
                context.onEvent?.({type: 'permission-rules-updated'})
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

/**
 * 从权限规则中挑选命中的 **proxy 作用域** MCP 规则。
 *
 * - 只接受精确等于 proxyName、或 glob 命中 proxyName 的 pattern（如 m_github_create_issue、
 *   m_github_*）；这些才是 MCP 专属严格层，可产生本工具内的「硬拒 / 弹确认 / 放行」。
 * - **排除** 引擎层 pattern（`*` 与任何命中 `call_mcp_tool` 的 pattern，如 `call_mcp_tool`
 *   本身、`call_mcp_*`）：它们已由 executor 的 PermissionEngine.check(tool='call_mcp_tool')
 *   消费，工具内再判会导致双弹窗或与用户授权矛盾的结论。
 * - `bash:` 前缀规则属于另一命名空间，直接忽略。
 * - 优先级：精确 proxy 名规则 > glob 规则；同级别（glob vs glob）按 createdAt
 *   后写覆盖 —— repository.getRules() 已按 created_at 升序返回，故「最后命中的
 *   glob」即「后创建者」，结论不再依赖 DB 行序。
 */
function findMatchingMcpRule(
    rules: readonly PermissionRule[],
    proxyName: string,
): PermissionRule | undefined {
    let best: PermissionRule | undefined
    let bestIsExact = false
    for (const rule of rules) {
        const pattern = rule.tool
        // 排除引擎层 pattern（* / call_mcp_tool / call_mcp_*）
        if (!isProxyScopedMcpToolPattern(pattern)) continue
        const isExact = pattern === proxyName
        const matched = isExact || matchesToolRulePattern(pattern, proxyName)
        if (!matched) continue
        if (!best || isExact || !bestIsExact) {
            best = rule
            bestIsExact = isExact
        }
    }
    return best
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
