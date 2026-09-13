/**
 * describeSkillsTool 只读详情查询工具单元测试
 *
 * 覆盖（spec: docs/superpowers/specs/2025-12-04-capability-catalog-hybrid-design.md §7.1，
 * 2025-12-04 修订：names 改为必填、取消全量返回）：
 * - A: 命中单个技能 → {skills:[...], notFound:[]}；输入 = 规范名时不含 requested
 * - B: 多名字部分未命中 → skills 含命中项、notFound 含未命中项
 * - C: 名称归一化匹配（大小写 / 连字符）→ name 为规范名 + requested 为原始输入
 * - D: 只返回启用技能（禁用技能不可命中）
 * - E: Minor-4 registry 抛错 → success:false + error，不伪装空 registry
 * - F: 入参非法按工具框架 schema 校验路径被拒绝
 * - G: 空值可选字段（description/trigger/source）整个省略，不输出 ''
 */
import {describe, it, expect, vi, afterEach} from 'vitest'
import {describeSkillsTool} from '@/main/agent/tools/builtin/describeSkillsTool'
import {skillRegistry} from '@/main/agent/skills/registry'

import {formatToolResult} from '@shared/utils/toolResult'

afterEach(() => {
    vi.restoreAllMocks()
    // 清理测试 D 注册的真实技能，避免跨用例污染
    skillRegistry.unregister('enabled-a')
    skillRegistry.unregister('disabled-b')
})

describe('describe_skills', () => {
    it('A: 传入存在的技能名只返回该技能', async () => {
        vi.spyOn(skillRegistry, 'getEnabled').mockReturnValue([
            {enabled: true, name: 'alpha', description: 'd', whenToUse: 'w', source: 'user'},
            {enabled: true, name: 'beta', description: 'b', whenToUse: 'wb', source: 'user'},
        ] as any)
        const result = await describeSkillsTool.execute({names: ['alpha']}, {} as any)
        expect(result.success).toBe(true)
        const parsed = JSON.parse(result.output as string)
        expect(parsed).toEqual({
            skills: [{name: 'alpha', description: 'd', trigger: 'w', source: 'user'}],
            notFound: [],
        })
        // 输入 == 规范名 → 不输出 requested（无漂移，无需噪音字段）
        expect(parsed.skills[0]).not.toHaveProperty('requested')
        // formatToolResult 渲染路径：LLM 实际收到的 tool_result 字符串
        expect(formatToolResult(result)).toBe(JSON.stringify(parsed))
    })

    it('B: 多名字且部分不存在 → skills 含命中项、notFound 含未命中项', async () => {
        vi.spyOn(skillRegistry, 'getEnabled').mockReturnValue([
            {enabled: true, name: 'alpha', description: 'd', source: 'user'},
        ] as any)
        const result = await describeSkillsTool.execute({names: ['alpha', 'ghost']}, {} as any)
        const parsed = JSON.parse(result.output as string)
        expect(parsed.skills.map((s: any) => s.name)).toEqual(['alpha'])
        expect(parsed.notFound).toEqual(['ghost'])
    })

    it('C: 名称归一化匹配（大小写 / 连字符）→ name 为规范名、requested 为原始输入', async () => {
        vi.spyOn(skillRegistry, 'getEnabled').mockReturnValue([
            {enabled: true, id: 'code-review', name: 'Code-Review', description: 'd', source: 'builtin'},
        ] as any)
        const result = await describeSkillsTool.execute({names: ['codereview', 'CODE_REVIEW']}, {} as any)
        const parsed = JSON.parse(result.output as string)
        // 两个不同原始输入均归一化命中同一技能 → 不产生重复项；
        // 约定：requested 取"首次命中该技能"的原始输入。
        expect(parsed.skills).toHaveLength(1)
        expect(parsed.skills[0]).toEqual({
            name: 'Code-Review',
            requested: 'codereview',
            description: 'd',
            source: 'builtin',
        })
        expect(parsed.notFound).toEqual([])
    })

    it('D: 只返回启用技能——禁用技能不可被命中', async () => {
        // 用真实 registry 语义（getEnabled = enabled && pluginEnabled !== false），
        // 不 mock getEnabled，以真实验证启用过滤。
        skillRegistry.register({
            id: 'enabled-a', name: 'enabled-a', description: 'ok',
            enabled: true, content: '', loadedAt: Date.now(),
        } as any)
        skillRegistry.register({
            id: 'disabled-b', name: 'disabled-b', description: 'nope',
            enabled: false, content: '', loadedAt: Date.now(),
        } as any)

        const result = await describeSkillsTool.execute({names: ['enabled-a', 'disabled-b']}, {} as any)
        const parsed = JSON.parse(result.output as string)
        expect(parsed.skills.map((s: any) => s.name)).toEqual(['enabled-a'])
        expect(parsed.notFound).toEqual(['disabled-b'])
    })

    it('E (Minor-4): registry 抛错时返回 success:false + 错误信息，不伪装空 registry', async () => {
        vi.spyOn(skillRegistry, 'getEnabled').mockImplementation(() => { throw new Error('boom') })
        const result = await describeSkillsTool.execute({names: ['alpha']}, {} as any)
        expect(result.success).toBe(false)
        expect(result.error).toContain('boom')
        expect(result.error).toContain('技能目录读取失败')
        expect(result.output).toBe('')
    })

    it('G: 空值可选字段整个省略（不输出 "" / undefined）', async () => {
        vi.spyOn(skillRegistry, 'getEnabled').mockReturnValue([
            {enabled: true, id: 'sparse', name: 'sparse', description: '', whenToUse: undefined, source: ''},
        ] as any)
        const result = await describeSkillsTool.execute({names: ['sparse']}, {} as any)
        const parsed = JSON.parse(result.output as string)
        expect(parsed.skills).toHaveLength(1)
        expect(parsed.skills[0]).toEqual({name: 'sparse'})
        expect(parsed.skills[0]).not.toHaveProperty('description')
        expect(parsed.skills[0]).not.toHaveProperty('trigger')
        expect(parsed.skills[0]).not.toHaveProperty('source')
    })

    it('F: 入参非法（缺 names / 空数组 / 空字符串）按框架 schema 校验被拒绝', async () => {
        // 本项目工具入参统一校验层在 src/main/agent/tools/executor.ts:277
        // （执行前 `tool.inputSchema.safeParse(toolCall.arguments)`），
        // 因此断言该 schema 对非法入参的拒绝行为。
        expect(describeSkillsTool.inputSchema.safeParse({}).success).toBe(false)
        expect(describeSkillsTool.inputSchema.safeParse({names: []}).success).toBe(false)
        expect(describeSkillsTool.inputSchema.safeParse({names: ['']}).success).toBe(false)
        expect(describeSkillsTool.inputSchema.safeParse({names: ['alpha']}).success).toBe(true)
    })
})
