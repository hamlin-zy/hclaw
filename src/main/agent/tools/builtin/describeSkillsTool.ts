/**
 * DescribeSkillsTool — 技能详情查询（只读）
 *
 * 会话目录只列出技能名；当某个名字看起来相关但 LLM 需要了解其用途时，
 * 通过此工具获取全部技能的 name + description + trigger。只读、无副作用。
 *
 * spec: docs/superpowers/specs/2025-12-04-capability-catalog-hybrid-design.md §7.1
 */
import {z} from 'zod'
import type {Tool, ToolContext, ToolResult} from '../types'
import {skillRegistry} from '../../skills/registry'
import {logger} from '../../logger'

const inputSchema = z.object({})

export const describeSkillsTool: Tool<Record<string, never>, string> = {
    name: 'describe_skills',
    description:
        'The session catalog lists skill NAMES only. Call this when a name looks ' +
        'relevant but you need to know what it does before invoking it. Returns ' +
        'name + description + trigger for every available skill. Read-only.',
    inputSchema,
    requiredPermissions: [],
    isDestructive: false,

    async execute(_args: Record<string, never>, _context: ToolContext): Promise<ToolResult<string>> {
        try {
            const items = skillRegistry.getEnabled()
                .filter(s => s.name?.trim())
                .map(s => ({
                    name: s.name,
                    description: s.description || '',
                    trigger: s.whenToUse || undefined,
                    source: s.source || undefined,
                }))
            return {success: true, output: JSON.stringify(items)}
        } catch (err) {
            logger.error('[describe_skills] failed', {error: String(err)})
            // 不伪装空 registry：显式失败并携带错误信息（Minor-4）
            return {success: false, output: '', error: `技能目录读取失败: ${String(err)}`}
        }
    },
}
