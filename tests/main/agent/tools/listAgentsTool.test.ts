/**
 * listAgentsTool 只读发现工具单元测试
 *
 * 覆盖（spec: docs/superpowers/specs/2025-12-04-capability-catalog-hybrid-design.md §7.2）：
 * - U10: 返回结构完整，跳过 cmd:* 与已禁用条目
 * - U12: 空 registry 返回 []
 */
import {describe, it, expect, vi, afterEach} from 'vitest'
import {listAgentsTool} from '@/main/agent/tools/builtin/listAgentsTool'
import {agentRegistry} from '@/main/agent/agentRegistry'

afterEach(() => vi.restoreAllMocks())

describe('list_agents', () => {
    it('U10: 返回结构完整，跳过 cmd:* 与已禁用条目', async () => {
        vi.spyOn(agentRegistry, 'getEnabled').mockReturnValue([
            {enabled: true, name: 'Explore Agent', description: 'explore', whenToUse: 'search'},
            {enabled: true, id: 'cmd:foo', name: 'cmdfoo', description: 'x'},
            {enabled: true, name: 'Planner', description: 'plan', tags: ['plugin:ecc']},
        ] as any)
        const result = await listAgentsTool.execute({} as any, {} as any)
        expect(result.success).toBe(true)
        const parsed = JSON.parse(result.output)
        expect(parsed.map((a: any) => a.name)).toEqual(['Explore Agent', 'Planner'])
        expect(parsed[1].plugin).toBe('ecc')
    })

    it('U12: 空 registry 返回 []', async () => {
        vi.spyOn(agentRegistry, 'getEnabled').mockReturnValue([] as any)
        const result = await listAgentsTool.execute({} as any, {} as any)
        expect(result.success).toBe(true)
        expect(JSON.parse(result.output)).toEqual([])
    })

    it('Minor-4: registry 抛错时返回 success:false + 错误信息，不伪装空 registry', async () => {
        vi.spyOn(agentRegistry, 'getEnabled').mockImplementation(() => { throw new Error('boom') })
        const result = await listAgentsTool.execute({} as any, {} as any)
        expect(result.success).toBe(false)
        expect(result.error).toContain('boom')
        expect(result.output).toBe('')
    })
})
