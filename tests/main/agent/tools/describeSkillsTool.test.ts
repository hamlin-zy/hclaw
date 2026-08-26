/**
 * describeSkillsTool 只读详情查询工具单元测试
 *
 * 覆盖（spec: docs/superpowers/specs/2025-12-04-capability-catalog-hybrid-design.md §7.1）：
 * - U10a/U11: 返回结构完整且只读
 * - U12: 空 registry 返回 []
 */
import {describe, it, expect, vi, afterEach} from 'vitest'
import {describeSkillsTool} from '@/main/agent/tools/builtin/describeSkillsTool'
import {skillRegistry} from '@/main/agent/skills/registry'

import {formatToolResult} from '@shared/utils/toolResult'

afterEach(() => vi.restoreAllMocks())

describe('describe_skills', () => {
    it('U10a/U11: 返回结构完整且只读', async () => {
        const spy = vi.spyOn(skillRegistry, 'getEnabled').mockReturnValue([
            {enabled: true, name: 'alpha', description: 'd', whenToUse: 'w', source: 'user'},
        ] as any)
        const before = spy.mock.results.length
        const result = await describeSkillsTool.execute({} as any, {} as any)
        expect(result.success).toBe(true)
        const parsed = JSON.parse(result.output as string)
        expect(parsed).toEqual([{name: 'alpha', description: 'd', trigger: 'w', source: 'user'}])
        // formatToolResult 渲染路径：LLM 实际收到的 tool_result 字符串
        expect(formatToolResult(result)).toBe(JSON.stringify(parsed))
        expect(spy.mock.calls.length).toBeGreaterThan(before)
        // 只读性验证：getEnabled 被调用但 registry 数据未被修改
        expect(skillRegistry.getEnabled()).toEqual([
            {enabled: true, name: 'alpha', description: 'd', whenToUse: 'w', source: 'user'},
        ])
    })

    it('U12: 空 registry 返回 []', async () => {
        vi.spyOn(skillRegistry, 'getEnabled').mockReturnValue([])
        const result = await describeSkillsTool.execute({} as any, {} as any)
        expect(result.success).toBe(true)
        expect(JSON.parse(result.output as string)).toEqual([])
        expect(formatToolResult(result)).toBe('[]')
    })

    it('Minor-4: registry 抛错时返回 success:false + 错误信息，不伪装空 registry', async () => {
        vi.spyOn(skillRegistry, 'getEnabled').mockImplementation(() => { throw new Error('boom') })
        const result = await describeSkillsTool.execute({} as any, {} as any)
        expect(result.success).toBe(false)
        expect(result.error).toContain('boom')
        expect(result.output).toBe('')
    })
})
