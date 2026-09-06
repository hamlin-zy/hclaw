import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest'
import {filterTools, filterToolsForDegrade} from '../../../../src/main/agent/loop/setup'
import {toolRegistry} from '../../../../src/main/agent/tools/registry'
import {makeTool, makeToolDefinition} from '../tools/testHelpers'
import * as modelCapability from '../../../../src/main/agent/modelCapability'
import type {AgentDefinition} from '@shared/agent'

const POOL = ['file_read', 'file_write', 'file_edit', 'bash', 'glob', 'grep']
    .map(makeToolDefinition)

// 扩展池：含 agent / notebook_edit / browser_tool，用于验证类型级黑名单
const POOL_EXTENDED = [
    ...POOL,
    makeToolDefinition('notebook_edit'),
    makeToolDefinition('agent'),
    makeToolDefinition('browser_tool'),
]

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

/**
 * 仅黑名单、无白名单的 Agent 定义（模拟只声明 disallowedTools 的场景）。
 * 修复前：disallowedTools 在 agentTool 派发路径丢失 → 黑名单完全失效 → 全量工具可用。
 */
function blacklistOnlyDefinition(): AgentDefinition {
    return {
        source: 'user',
        agentType: 'BlacklistOnly Agent',
        whenToUse: '测试',
        description: 'blacklist-only',
        systemPromptTemplate: '',
        renderedSystemPrompt: '',
        disallowedTools: ['file_edit', 'file_write', 'bash'],
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
        for (const def of POOL_EXTENDED) {
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

    // ══════════════════════════════════════════════════════════════
    //  修复 2 测试：agent 级 + 类型级双层过滤（AND 而非 OR）
    // ══════════════════════════════════════════════════════════════

    /**
     * 核心回归：agentDefinition 存在 + agentType=Explore → 类型级黑名单也生效。
     * 修复前：filterToolsForDegrade 在 agentDefinition 存在时跳过 filterToolsByAgentType，
     *         导致 Explore 类型的 Edit/Write/Bash 禁令完全失效。
     * 修复后：先 agent 级过滤，再叠加类型级过滤（AND）。
     */
    it('修复2-核心：agentDefinition 存在 + Explore 类型 → 类型级黑名单叠加生效（file_edit 被移除）', async () => {
        for (const def of POOL_EXTENDED) {
            if (!toolRegistry.has(def.name)) toolRegistry.register(makeTool(def.name))
        }
        vi.spyOn(toolRegistry, 'getToolDefinitions').mockResolvedValue(POOL_EXTENDED)

        // Agent 无白名单、无黑名单 → agent 级过滤不生效
        // 但 Explore 类型级黑名单应移除 file_edit/file_write/bash/notebook_edit/agent
        const def: AgentDefinition = {
            source: 'user',
            agentType: 'Explore Agent',
            whenToUse: '探索',
            description: 'explore',
            systemPromptTemplate: '',
            renderedSystemPrompt: '',
        } as AgentDefinition
        const result = await filterToolsForDegrade(def, 'Explore')
        const names = result.map(t => t.name).sort()
        // Explore 类型级黑名单禁 Edit/Write/Bash/NotebookEdit/TaskWrite/Agent
        // 保留 file_read, glob, grep, browser_tool（browser_tool 不在黑名单中）
        expect(names).toEqual(['browser_tool', 'file_read', 'glob', 'grep'])
    })

    it('修复2-核心：agentDefinition 存在 + Plan 类型 → 类型级黑名单叠加生效', async () => {
        for (const def of POOL_EXTENDED) {
            if (!toolRegistry.has(def.name)) toolRegistry.register(makeTool(def.name))
        }
        vi.spyOn(toolRegistry, 'getToolDefinitions').mockResolvedValue(POOL_EXTENDED)

        const def: AgentDefinition = {
            source: 'user',
            agentType: 'Plan Agent',
            whenToUse: '规划',
            description: 'plan',
            systemPromptTemplate: '',
            renderedSystemPrompt: '',
        } as AgentDefinition
        const result = await filterToolsForDegrade(def, 'Plan')
        const names = result.map(t => t.name).sort()
        // Plan 类型级黑名单禁 Edit/Write/Bash/NotebookEdit/TaskWrite/Agent
        // 保留 file_read, glob, grep, browser_tool
        expect(names).toEqual(['browser_tool', 'file_read', 'glob', 'grep'])
    })

    /**
     * Agent 级黑名单 + 类型级黑名单叠加：两者取并集。
     * Agent 黑名单移除 file_edit，类型级黑名单（Explore）也移除 bash。
     * 最终结果应同时不含两者。
     */
    it('修复2-叠加：agent 级黑名单 + 类型级黑名单取并集', async () => {
        for (const def of POOL_EXTENDED) {
            if (!toolRegistry.has(def.name)) toolRegistry.register(makeTool(def.name))
        }
        vi.spyOn(toolRegistry, 'getToolDefinitions').mockResolvedValue(POOL_EXTENDED)

        // Agent 级黑名单只禁 file_edit（不含 bash）
        // Explore 类型级黑名单禁 Edit/Write/Bash/NotebookEdit/TaskWrite/Agent
        // 叠加后 bash 也应被移除
        const def: AgentDefinition = {
            source: 'user',
            agentType: 'Explore Agent',
            whenToUse: '探索',
            description: 'explore',
            systemPromptTemplate: '',
            renderedSystemPrompt: '',
            disallowedTools: ['file_edit'],
        } as AgentDefinition
        const result = await filterToolsForDegrade(def, 'Explore')
        const names = result.map(t => t.name)
        expect(names).not.toContain('file_edit')
        expect(names).not.toContain('bash')
        expect(names).not.toContain('file_write')
        expect(names).toContain('file_read')
        expect(names).toContain('glob')
        expect(names).toContain('grep')
        // browser_tool 不在 Agent 级或 Explore 类型级黑名单中，应保留
        expect(names).toContain('browser_tool')
    })

    /**
     * Agent 级白名单更严格时，类型级过滤不放宽（AND 语义）。
     * 白名单只留 file_read，类型级 Explore 不会加回 glob/grep（虽然类型级允许）。
     */
    it('修复2-不放宽：agent 白名单更严格时类型级不回退', async () => {
        for (const def of POOL_EXTENDED) {
            if (!toolRegistry.has(def.name)) toolRegistry.register(makeTool(def.name))
        }
        vi.spyOn(toolRegistry, 'getToolDefinitions').mockResolvedValue(POOL_EXTENDED)

        const def: AgentDefinition = {
            source: 'user',
            agentType: 'Explore Agent',
            whenToUse: '探索',
            description: 'explore',
            systemPromptTemplate: '',
            renderedSystemPrompt: '',
            tools: ['file_read'], // 只白名单 file_read
        } as AgentDefinition
        const result = await filterToolsForDegrade(def, 'Explore')
        expect(result.map(t => t.name)).toEqual(['file_read'])
    })

    /**
     * 仅黑名单、无白名单的 Agent + Explore 类型 → 黑名单 + 类型级黑名单均生效。
     * 模拟修复 1（disallowedTools 传递）+ 修复 2（双层过滤）共同作用的场景。
     */
    it('修复1+2联动：仅黑名单 Agent + Explore 类型 → 双层黑名单均生效', async () => {
        for (const def of POOL_EXTENDED) {
            if (!toolRegistry.has(def.name)) toolRegistry.register(makeTool(def.name))
        }
        vi.spyOn(toolRegistry, 'getToolDefinitions').mockResolvedValue(POOL_EXTENDED)

        const result = await filterToolsForDegrade(blacklistOnlyDefinition(), 'Explore')
        const names = result.map(t => t.name).sort()
        // Agent 级黑名单禁 file_edit/file_write/bash
        // Explore 类型级黑名单也禁 file_edit/file_write/bash/notebook_edit/agent
        // 叠加后：移除 file_edit, file_write, bash, notebook_edit, agent
        // 保留 file_read, glob, grep, browser_tool
        expect(names).toEqual(['browser_tool', 'file_read', 'glob', 'grep'])
    })

    /**
     * General 类型不收紧过滤（无类型级黑名单），agent 级过滤结果不被改变。
     */
    it('修复2-不误伤：General 类型 + agent 白名单 → 结果与修复前一致', async () => {
        for (const def of POOL_EXTENDED) {
            if (!toolRegistry.has(def.name)) toolRegistry.register(makeTool(def.name))
        }
        vi.spyOn(toolRegistry, 'getToolDefinitions').mockResolvedValue(POOL_EXTENDED)

        const result = await filterToolsForDegrade(planDefinition(), 'General')
        const names = result.map(t => t.name).sort()
        // Plan 白名单只有 glob/grep/file_read，General 类型无额外限制
        expect(names).toEqual(['file_read', 'glob', 'grep'])
    })
})
