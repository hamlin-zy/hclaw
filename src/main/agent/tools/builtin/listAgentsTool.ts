/**
 * ListAgentsTool — agent 名册发现（只读）
 *
 * 会话目录不推送 agents 名册；委派意图出现时先通过此工具枚举，
 * 再用确切 name 经 `agent` 工具委派。只读、无副作用。
 * 跳过 `cmd:*` 条目（已禁用条目由 getEnabled 过滤）。
 *
 * spec: docs/superpowers/specs/2025-12-04-capability-catalog-hybrid-design.md §7.2
 */
import {z} from 'zod'
import type {Tool, ToolContext, ToolResult} from '../types'
import {agentRegistry} from '../../agentRegistry'
import {logger} from '../../logger'

const inputSchema = z.object({})

function pluginOf(a: {id?: string; tags?: string[]}): string | undefined {
    const t = a.tags?.find(tag => tag.startsWith('plugin:'))
    if (t) return t.slice('plugin:'.length)
    const id = a.id || ''
    const i = id.indexOf(':')
    return i > 0 && !id.startsWith('cmd:') ? id.slice(0, i) : undefined
}

export const listAgentsTool: Tool<Record<string, never>, string> = {
    name: 'list_agents',
    get description() {
        return (
            'No agent roster is provided in this session context. When delegation ' +
            'might help (parallel work, specialized review, exploration), call this ' +
            'first, then delegate via the `agent` tool using the exact returned name. ' +
            'Read-only.'
        )
    },
    get inputSchema() {
        return inputSchema
    },
    requiredPermissions: [],
    isDestructive: false,

    async execute(_args: Record<string, never>, _context: ToolContext): Promise<ToolResult<string>> {
        try {
            const items = agentRegistry.getEnabled()
                .filter((a: any) => !(a.id || '').startsWith('cmd:') && a.name?.trim())
                .map((a: any) => ({
                    name: a.name,
                    description: a.userDescription || a.description || '',
                    trigger: a.whenToUse || undefined,
                    plugin: pluginOf(a),
                }))
            return {success: true, output: JSON.stringify(items)}
        } catch (err) {
            logger.error('[list_agents] failed', {error: String(err)})
            // 不伪装空 registry：显式失败并携带错误信息（Minor-4）
            return {success: false, output: '', error: `Agent 名册读取失败: ${String(err)}`}
        }
    },
}
