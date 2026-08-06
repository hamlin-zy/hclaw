import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest'
import {filterTools} from '../../../../src/main/agent/loop/setup'
import {toolRegistry} from '../../../../src/main/agent/tools/registry'
import {makeTool, makeToolDefinition} from '../tools/testHelpers'
import type {AgentDefinition} from '@shared/agent'

const POOL = ['file_read', 'file_write', 'file_edit', 'bash', 'glob', 'grep']
    .map(makeToolDefinition)

function planDefinition(): AgentDefinition {
    return {
        source: 'user',
        agentType: 'Plan Agent',
        whenToUse: '规划',
        description: 'plan',
        systemPromptTemplate: '',
        renderedSystemPrompt: '',
        tools: ['glob', 'grep', 'file_read'],
        disallowedTools: ['agent', 'file_edit', 'file_write', 'notebook_edit', 'bash', 'browser_tool'],
    } as AgentDefinition
}

describe('filterTools 分派逻辑', () => {
    beforeEach(() => {
        for (const def of POOL) {
            if (!toolRegistry.has(def.name)) {
                toolRegistry.register(makeTool(def.name))
            }
        }
        // mock DB 路径，保证测试确定性
        vi.spyOn(toolRegistry, 'getToolDefinitions').mockResolvedValue(POOL)
    })
    afterEach(() => {
        vi.restoreAllMocks()
        for (const def of POOL) {
            toolRegistry.unregister(def.name)
        }
    })

    it('agentDefinition 存在 → 按 agent 白名单过滤（Plan 只读 3 工具）', async () => {
        const result = await filterTools(planDefinition(), 'General')
        const names = result.map(t => t.name).sort()
        expect(names).toEqual(['file_read', 'glob', 'grep'])
    })

    it('agentDefinition 为 undefined + agentType Plan → 按类型限制过滤', async () => {
        const result = await filterTools(undefined, 'Plan')
        const names = result.map(t => t.name).sort()
        expect(names).toEqual(['file_read', 'glob', 'grep'])
    })

    it('agentDefinition 为 undefined + agentType General → 全部保留', async () => {
        const result = await filterTools(undefined, 'General')
        expect(result).toHaveLength(POOL.length)
    })
})
