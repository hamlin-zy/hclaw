/**
 * DescribeSkillsTool — 技能详情查询（只读）
 *
 * 会话目录只列出技能名；当某个名字看起来相关但 LLM 需要了解其用途时，
 * 通过此工具按确切名称获取这些技能的 name + description + trigger。只读、无副作用。
 *
 * 修订（2025-12-04 spec §7.1）：names 改为必填，取消"无参数全量返回"路径——
 * 全量返回会抵消 names-only 目录省 token 的目标，故强制精确按名查询。
 *
 * spec: docs/superpowers/specs/2025-12-04-capability-catalog-hybrid-design.md §7.1
 */
import {z} from 'zod'
import type {Tool, ToolContext, ToolResult} from '../types'
import {skillRegistry} from '../../skills/registry'
import {logger} from '../../logger'

const inputSchema = z.object({
    names: z.array(z.string().min(1)).min(1),
})

type DescribeSkillsInput = z.infer<typeof inputSchema>

interface DescribeSkillsOutput {
    /**
     * name 为**规范技能名**（正确可调用名）。
     * requested 仅在"LLM 传入的原始字符串 ≠ 规范名"时出现（漂移提示），
     * 便于模型判断是否命中目标技能、并以规范名做精准二次检索。
     * 为空/缺省的 description / trigger / source 一律整个省略该字段。
     */
    skills: Array<{name: string; requested?: string; description?: string; trigger?: string; source?: string}>
    notFound: string[]
}

/** 归一化：小写 + 去掉 `-`/`_`（与 registry.find() 的匹配规则一致） */
const normalize = (s: string) => s.toLowerCase().replace(/[-_]/g, '')

export const describeSkillsTool: Tool<DescribeSkillsInput, string> = {
    name: 'describe_skills',
    description:
        'The session catalog lists skill NAMES only. Call this with the EXACT skill ' +
        'name(s) shown in the session catalog when you need to know what they do before ' +
        'invoking. Requires `names` — a non-empty array of skill names. Returns each ' +
        'matched skill\'s canonical `name` (plus `requested` when your input differs from ' +
        'the canonical name) with description + trigger, plus any names that were not ' +
        'found. Empty optional fields are omitted. Read-only.',
    inputSchema,
    requiredPermissions: [],
    isDestructive: false,

    async execute(args: DescribeSkillsInput, _context: ToolContext): Promise<ToolResult<string>> {
        try {
            // 只在已启用技能范围内匹配（enabled && pluginEnabled !== false）。
            // 注意：registry.find() 会在全部技能（含禁用）中查找，不能直接用作最终判定。
            const enabled = skillRegistry.getEnabled()

            // trim + 去重（保留传入顺序）
            const names = [...new Set(args.names.map(n => n.trim()).filter(Boolean))]

            const skills: DescribeSkillsOutput['skills'] = []
            const notFound: string[] = []
            const matchedKeys = new Set<string>()

            for (const raw of names) {
                const norm = normalize(raw)
                const match =
                    enabled.find(s => s.id === raw) ||
                    enabled.find(s => s.name === raw) ||
                    enabled.find(s => normalize(s.name ?? '') === norm || normalize(s.id ?? '') === norm)

                if (!match) {
                    // 同一未命中名只记一次（names 已去重）
                    notFound.push(raw)
                    continue
                }

                // 同一技能仅输出一次；requested 取"首次命中该技能的原始输入"。
                const key = match.id ?? match.name
                if (matchedKeys.has(key)) continue
                matchedKeys.add(key)

                const item: DescribeSkillsOutput['skills'][number] = {name: match.name}
                // 仅当原始输入与规范名不同才附 requested（漂移提示，便于二次精准检索）
                if (raw !== match.name) item.requested = raw
                // 空值字段整个省略（不输出 ''/undefined）
                if (match.description) item.description = match.description
                if (match.whenToUse) item.trigger = match.whenToUse
                if (match.source) item.source = match.source
                skills.push(item)
            }

            const payload: DescribeSkillsOutput = {skills, notFound}
            return {success: true, output: JSON.stringify(payload)}
        } catch (err) {
            logger.error('[describe_skills] failed', {error: String(err)})
            // 不伪装空 registry：显式失败并携带错误信息（Minor-4）
            return {success: false, output: '', error: `技能目录读取失败: ${String(err)}`}
        }
    },
}
