import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest'
import {filterTools, filterToolsForDegrade} from '../../../../src/main/agent/loop/setup'
import {toolRegistry} from '../../../../src/main/agent/tools/registry'
import {makeTool, makeToolDefinition} from '../tools/testHelpers'
import * as modelCapability from '../../../../src/main/agent/modelCapability'
import type {AgentDefinition} from '@shared/agent'

const POOL = ['file_read', 'file_write', 'file_edit', 'bash', 'glob', 'grep']
    .map(makeToolDefinition)

const POOL_WITH_VISION = [
    ...POOL,
    makeToolDefinition('analyze_image'),
]

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
        // 清理能力过滤用例注册的工具（registry 为全局单例）
        toolRegistry.unregister('analyze_image')
        toolRegistry.unregister('mcp__server__analyze_image')
    })

    it('agentDefinition 存在 → 按 agent 白名单过滤（Plan 只读 3 工具）', async () => {
        const result = await filterTools(planDefinition(), 'General', 'deepseek-v4-flash')
        const names = result.map(t => t.name).sort()
        expect(names).toEqual(['file_read', 'glob', 'grep'])
    })

    it('agentDefinition 为 undefined + agentType Plan → 按类型限制过滤', async () => {
        const result = await filterTools(undefined, 'Plan', 'deepseek-v4-flash')
        const names = result.map(t => t.name).sort()
        expect(names).toEqual(['file_read', 'glob', 'grep'])
    })

    it('agentDefinition 为 undefined + agentType General → 全部保留', async () => {
        const result = await filterTools(undefined, 'General', 'deepseek-v4-flash')
        expect(result).toHaveLength(POOL.length)
    })

    it('多模态模型（supportsImageInput=true）→ 移除 analyze_image', async () => {
        vi.spyOn(modelCapability, 'supportsImageInput').mockReturnValue(true)
        // 注册 analyze_image + mock getToolDefinitions 返回含它的池
        if (!toolRegistry.has('analyze_image')) toolRegistry.register(makeTool('analyze_image'))
        vi.spyOn(toolRegistry, 'getToolDefinitions').mockResolvedValue(POOL_WITH_VISION)
        const result = await filterTools(undefined, 'General', 'deepseek-v4-flash-vision-exp')
        const names = result.map(t => t.name)
        expect(names).not.toContain('analyze_image')
        expect(names).toContain('file_read')
    })

    it('非多模态模型（supportsImageInput=false）→ 保留 analyze_image', async () => {
        vi.spyOn(modelCapability, 'supportsImageInput').mockReturnValue(false)
        vi.spyOn(toolRegistry, 'getToolDefinitions').mockResolvedValue(POOL_WITH_VISION)
        const result = await filterTools(undefined, 'General', 'deepseek-v4-flash')
        const names = result.map(t => t.name)
        expect(names).toContain('analyze_image')
    })

    it('agentDefinition 白名单已排除 analyze_image + 非多模态 → 仍不含（白名单语义不变）', async () => {
        vi.spyOn(modelCapability, 'supportsImageInput').mockReturnValue(false)
        const def = planDefinition() // 白名单含 ['glob','grep','file_read']
        const result = await filterTools(def, 'General', 'deepseek-v4-flash')
        const names = result.map(t => t.name)
        expect(names).toEqual(['file_read', 'glob', 'grep'])
        expect(names).not.toContain('analyze_image')
    })

    it('MCP 工具不被误伤：mcp__server__analyze_image 在多模态时保留', async () => {
        vi.spyOn(modelCapability, 'supportsImageInput').mockReturnValue(true)
        const mcpDef = makeToolDefinition('mcp__server__analyze_image')
        if (!toolRegistry.has('mcp__server__analyze_image')) toolRegistry.register(makeTool('mcp__server__analyze_image'))
        vi.spyOn(toolRegistry, 'getToolDefinitions').mockResolvedValue([...POOL_WITH_VISION, mcpDef])
        const result = await filterTools(undefined, 'General', 'vision-model')
        const names = result.map(t => t.name)
        expect(names).not.toContain('analyze_image')        // 精确名被移除
        expect(names).toContain('mcp__server__analyze_image') // 前缀名保留
    })

    it('既有用例回归：planDefinition + General 不受影响', async () => {
        vi.spyOn(modelCapability, 'supportsImageInput').mockReturnValue(false)
        const result = await filterTools(planDefinition(), 'General', 'any-model')
        expect(result.map(t => t.name).sort()).toEqual(['file_read', 'glob', 'grep'])
    })
})

describe('filterToolsForDegrade（400 降级恢复用白名单后列表）', () => {
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
        // 清理能力过滤用例注册的工具（registry 为全局单例）
        toolRegistry.unregister('analyze_image')
        toolRegistry.unregister('mcp__server__analyze_image')
    })

    it('filterToolsForDegrade：不含能力过滤（多模态模型仍含 analyze_image）', async () => {
        vi.spyOn(modelCapability, 'supportsImageInput').mockReturnValue(true)
        vi.spyOn(toolRegistry, 'getToolDefinitions').mockResolvedValue(POOL_WITH_VISION)
        const result = await filterToolsForDegrade(undefined, 'General')
        const names = result.map(t => t.name)
        expect(names).toContain('analyze_image')
    })

    it('filterToolsForDegrade：agent 白名单仍生效（安全边界）', async () => {
        vi.spyOn(toolRegistry, 'getToolDefinitions').mockResolvedValue(POOL_WITH_VISION)
        const result = await filterToolsForDegrade(planDefinition(), 'General')
        expect(result.map(t => t.name).sort()).toEqual(['file_read', 'glob', 'grep'])
    })
})
