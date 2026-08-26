import {describe, it, expect, beforeAll} from 'vitest'
import {toolRegistry, registerBuiltinTools} from '@/main/agent/tools'
import {filterToolsForAgent} from '@/main/agent/tools/filter'
import type {AgentDefinition} from '@shared/agent'

describe('R4/R6 catalog tools registration & filtering', () => {
    beforeAll(() => {
        registerBuiltinTools()
    })

    it('R4: 两个新工具均已注册且无重名冲突', () => {
        const names = ['describe_skills', 'list_agents']
        for (const n of names) {
            expect(toolRegistry.get(n)).toBeDefined()
        }
    })

    it('R6a: 主 agent（无白名单）可见两工具', () => {
        const all = toolRegistry.getAll()
        const visible = filterToolsForAgent(
            {tools: []} as unknown as AgentDefinition,
            all,
        ).map(t => t.name)
        expect(visible).toContain('describe_skills')
        expect(visible).toContain('list_agents')
    })

    it('R6b: explore 白名单下不可见', () => {
        const all = toolRegistry.getAll()
        const visible = filterToolsForAgent(
            {tools: ['glob', 'grep', 'file_read']} as unknown as AgentDefinition,
            all,
        ).map(t => t.name)
        expect(visible).not.toContain('describe_skills')
        expect(visible).not.toContain('list_agents')
    })

    it('F1: built-in 子代理不可见 list_agents', () => {
        const all = toolRegistry.getAll()
        const visible = filterToolsForAgent(
            {source: 'built-in', tools: '*'} as unknown as AgentDefinition,
            all,
        ).map(t => t.name)
        expect(visible).not.toContain('list_agents')
        expect(visible).not.toContain('agent')
    })

    // R5（审批行为）：依据 Task 0 V-1 结论——safe 模式下 isDestructive=false 的工具
    // 经 PermissionEngine.check() 自动放行、无需白名单。describe_skills / list_agents
    // 均为 isDestructive=false 的只读发现工具，走"均自动放行"分支，故此处以注释性
    // 用例记录依据，不再断言白名单集合内容。
    it('R5: 两工具 safe 模式自动放行（V-1 结论，注释性用例）', () => {
        for (const name of ['describe_skills', 'list_agents']) {
            const tool = toolRegistry.get(name)
            expect(tool).toBeDefined()
            expect(tool!.isDestructive).toBeFalsy()
        }
    })
})
