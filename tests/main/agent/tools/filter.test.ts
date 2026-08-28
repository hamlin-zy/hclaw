import {describe, it, expect} from 'vitest'
import {filterToolsForAgent, parseToolSpec} from '../../../../src/main/agent/tools/filter'
import {makeTool} from './testHelpers'
import type {AgentDefinition} from '@shared/agent'

// 测试工具池：全局黑名单 Skill 在内，验证第 1 层过滤
const TOOL_POOL = ['skill', 'agent', 'file_read', 'file_write', 'file_edit', 'bash', 'glob', 'grep', 'notebook_edit', 'browser_tool']
    .map(t => makeTool(t))

function agent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
    return {
        source: 'user',
        agentType: 'Test Agent',
        whenToUse: '',
        description: 'test',
        systemPromptTemplate: '',
        renderedSystemPrompt: '',
        ...overrides,
    } as AgentDefinition
}

describe('filterToolsForAgent', () => {
    it('第 1 层：全局黑名单 skill 永远被移除', () => {
        const result = filterToolsForAgent(agent(), TOOL_POOL)
        expect(result.some(t => t.name === 'skill')).toBe(false)
    })

    it('第 2 层：built-in 来源移除 agent 工具', () => {
        const result = filterToolsForAgent(agent({source: 'built-in'}), TOOL_POOL)
        expect(result.some(t => t.name === 'agent')).toBe(false)
    })

    it('第 2 层：user 来源保留 agent 工具', () => {
        const result = filterToolsForAgent(agent(), TOOL_POOL)
        expect(result.some(t => t.name === 'agent')).toBe(true)
    })

    it('第 3 层：agent 级黑名单移除指定工具', () => {
        const result = filterToolsForAgent(agent({disallowedTools: ['file_edit', 'file_write']}), TOOL_POOL)
        expect(result.some(t => t.name === 'file_edit')).toBe(false)
        expect(result.some(t => t.name === 'file_write')).toBe(false)
        expect(result.some(t => t.name === 'file_read')).toBe(true)
    })

    it('第 3 层：CC 风格黑名单（Edit/Write）经别名解析生效', () => {
        const result = filterToolsForAgent(agent({disallowedTools: ['Edit', 'Write']}), TOOL_POOL)
        expect(result.some(t => t.name === 'file_edit')).toBe(false)
        expect(result.some(t => t.name === 'file_write')).toBe(false)
    })

    it('第 3 层：黑名单中未知名条目被忽略，不影响其余过滤', () => {
        const result = filterToolsForAgent(agent({disallowedTools: ['TaskWrite', 'bash']}), TOOL_POOL)
        expect(result.some(t => t.name === 'bash')).toBe(false)
        expect(result.some(t => t.name === 'file_read')).toBe(true)
    })

    it('第 4 层：白名单仅保留指定工具（Plan 场景核心回归）', () => {
        const result = filterToolsForAgent(agent({tools: ['glob', 'grep', 'file_read']}), TOOL_POOL)
        const names = result.map(t => t.name).sort()
        expect(names).toEqual(['file_read', 'glob', 'grep'])
    })

    it('第 4 层：单工具白名单', () => {
        const result = filterToolsForAgent(agent({tools: ['glob']}), TOOL_POOL)
        expect(result.map(t => t.name)).toEqual(['glob'])
    })

    it('第 4 层：CC 风格白名单（Read）经别名解析生效', () => {
        const result = filterToolsForAgent(agent({tools: ['Read']}), TOOL_POOL)
        expect(result.map(t => t.name)).toEqual(['file_read'])
    })

    it('第 4 层：通配符 * 返回全部（除 1-3 层已移除）', () => {
        const result = filterToolsForAgent(agent({tools: ['*']}), TOOL_POOL)
        expect(result.some(t => t.name === 'skill')).toBe(false)
        expect(result.some(t => t.name === 'file_edit')).toBe(true)
        expect(result.some(t => t.name === 'file_read')).toBe(true)
    })

    it('第 4 层：白名单全部解析失败 → 返回空数组（无工具注入）', () => {
        const result = filterToolsForAgent(agent({tools: ['nonexistent']}), TOOL_POOL)
        expect(result).toEqual([])
    })

    it('白名单与黑名单叠加：先黑后白', () => {
        const result = filterToolsForAgent(
            agent({tools: ['file_edit', 'bash'], disallowedTools: ['bash']}),
            TOOL_POOL,
        )
        expect(result.map(t => t.name)).toEqual(['file_edit'])
    })

    it('组合场景：Plan 配置全量 → 恰好 3 个只读工具', () => {
        const result = filterToolsForAgent(agent({
            tools: ['glob', 'grep', 'file_read'],
            disallowedTools: ['agent', 'file_edit', 'file_write', 'notebook_edit', 'bash', 'browser_tool'],
        }), TOOL_POOL)
        const names = result.map(t => t.name).sort()
        expect(names).toEqual(['file_read', 'glob', 'grep'])
    })

    it('组合场景：Implementer 配置全量 → 6 个开发工具', () => {
        const result = filterToolsForAgent(agent({
            tools: ['file_read', 'file_write', 'file_edit', 'bash', 'grep', 'glob'],
        }), TOOL_POOL)
        const names = result.map(t => t.name).sort()
        expect(names).toEqual(['bash', 'file_edit', 'file_read', 'file_write', 'glob', 'grep'])
    })

    it('对外 API：parseToolSpec 仍可从 filter 模块导入（re-export 兼容）', () => {
        expect(parseToolSpec('bash:always')).toEqual({toolName: 'bash', rule: 'always'})
    })
})
