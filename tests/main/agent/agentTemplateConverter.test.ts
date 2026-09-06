import {describe, it, expect, beforeEach, afterEach} from 'vitest'
import {
    agentTemplateToDefinition,
    resolveAgentDefinitionFromCommandId,
} from '../../../src/main/agent/agentTemplateConverter'
import {agentRegistry} from '../../../src/main/agent/agentRegistry'
import type {AgentTemplate} from '@shared/types'

const TEST_AGENT_ID = 'test-plan'

function makeTemplate(overrides: Partial<AgentTemplate> = {}): AgentTemplate {
    return {
        id: TEST_AGENT_ID,
        name: 'Test Plan',
        description: 'test description',
        systemPrompt: '你是测试 Agent',
        allowedTools: ['glob', 'grep', 'file_read'],
        disallowedTools: ['file_edit', 'file_write'],
        enabled: true,
        createdAt: 0,
        updatedAt: 0,
        ...overrides,
    }
}

describe('agentTemplateToDefinition', () => {
    it('字段映射完整', () => {
        const def = agentTemplateToDefinition(makeTemplate({
            whenToUse: '规划',
            tags: ['planning'],
            model: 'gpt-4o',
            permissionMode: 'safe',
            maxTurns: 50,
            isolation: 'none',
            requiredMcpServers: ['test-mcp'],
        }))
        expect(def.source).toBe('user')
        expect(def.agentType).toBe('Test Plan')
        expect(def.whenToUse).toBe('规划')
        expect(def.systemPromptTemplate).toBe('你是测试 Agent')
        expect(def.tools).toEqual(['glob', 'grep', 'file_read'])
        expect(def.disallowedTools).toEqual(['file_edit', 'file_write'])
        expect(def.tags).toEqual(['planning'])
        expect(def.model).toBe('gpt-4o')
        expect(def.permissionMode).toBe('safe')
        expect(def.maxTurns).toBe(50)
        expect(def.isolation).toBe('none')
        expect(def.requiredMcpServers).toEqual(['test-mcp'])
    })

    it('whenToUse 为空时回退 description', () => {
        const def = agentTemplateToDefinition(makeTemplate({whenToUse: undefined}))
        expect(def.whenToUse).toBe('test description')
    })

    it('allowedTools 为 undefined 时 tools 保持 undefined（= 全部工具）', () => {
        const def = agentTemplateToDefinition(makeTemplate({allowedTools: undefined}))
        expect(def.tools).toBeUndefined()
    })
})

describe('resolveAgentDefinitionFromCommandId', () => {
    beforeEach(() => {
        agentRegistry.register(makeTemplate())
    })
    afterEach(() => {
        agentRegistry.unregister(TEST_AGENT_ID)
    })

    it('agent: 前缀 + 已注册启用 → 返回定义（tools 映射正确）', () => {
        const def = resolveAgentDefinitionFromCommandId('agent:test-plan')
        expect(def).toBeDefined()
        expect(def!.tools).toEqual(['glob', 'grep', 'file_read'])
    })

    it('禁用 agent → undefined', () => {
        agentRegistry.unregister(TEST_AGENT_ID)
        agentRegistry.register(makeTemplate({enabled: false}))
        expect(resolveAgentDefinitionFromCommandId('agent:test-plan')).toBeUndefined()
    })

    it('未知 agent → undefined', () => {
        expect(resolveAgentDefinitionFromCommandId('agent:unknown-agent')).toBeUndefined()
    })

    it('skill: 前缀 → undefined', () => {
        expect(resolveAgentDefinitionFromCommandId('skill:test-skill')).toBeUndefined()
    })

    it('command: 前缀 → undefined', () => {
        expect(resolveAgentDefinitionFromCommandId('command:test')).toBeUndefined()
    })

    it('undefined / 空字符串 → undefined', () => {
        expect(resolveAgentDefinitionFromCommandId(undefined)).toBeUndefined()
        expect(resolveAgentDefinitionFromCommandId('')).toBeUndefined()
    })

    it('agent: 空 id → undefined', () => {
        expect(resolveAgentDefinitionFromCommandId('agent:')).toBeUndefined()
    })

    it('按 name 模糊匹配兜底（find 分支）', () => {
        const def = resolveAgentDefinitionFromCommandId('agent:Test Plan')
        expect(def).toBeDefined()
        expect(def!.agentType).toBe('Test Plan')
    })
})

// ═══════════════════════════════════════════════════════════════════════
//  修复 1 回归测试：disallowedTools 在转换链路中完整传递
//  根因：agentTool.ts 构建 effectiveAgentDef 时遗漏了 disallowedTools 字段。
//  此测试验证 agentTemplateToDefinition（上游）正确传递 disallowedTools，
//  确保 agentTool 的输入数据完整——修复 1 在 agentTool.ts 中补全该字段后，
//  端到端链路不再断裂。
// ═══════════════════════════════════════════════════════════════════════
describe('agentTemplateToDefinition disallowedTools 传递完整性（修复 1 回归）', () => {
    it('disallowedTools 完整传递到 AgentDefinition', () => {
        const template = makeTemplate({
            disallowedTools: ['agent', 'file_edit', 'file_write', 'notebook_edit'],
        })
        const def = agentTemplateToDefinition(template)
        expect(def.disallowedTools).toEqual(['agent', 'file_edit', 'file_write', 'notebook_edit'])
    })

    it('disallowedTools 为空数组时保持空数组（不是 undefined）', () => {
        const template = makeTemplate({disallowedTools: []})
        const def = agentTemplateToDefinition(template)
        expect(def.disallowedTools).toEqual([])
    })

    it('disallowedTools 为 undefined 时保持 undefined（= 不限制）', () => {
        const template = makeTemplate({disallowedTools: undefined})
        const def = agentTemplateToDefinition(template)
        expect(def.disallowedTools).toBeUndefined()
    })

    it('tools + disallowedTools 同时存在 → 两者独立保留', () => {
        const template = makeTemplate({
            allowedTools: ['glob', 'grep', 'file_read'],
            disallowedTools: ['agent', 'file_edit', 'file_write'],
        })
        const def = agentTemplateToDefinition(template)
        // 白名单
        expect(def.tools).toEqual(['glob', 'grep', 'file_read'])
        // 黑名单（修复前 agentTool 会丢失此字段）
        expect(def.disallowedTools).toEqual(['agent', 'file_edit', 'file_write'])
    })

    /**
     * 模拟 Explore Agent 的真实配置：
     * tools: [glob, grep, file_read]
     * disallowedTools: [agent, file_edit, file_write, notebook_edit]
     * 验证转换后两个字段都完整保留——这是 agentTool.ts 应接收到的输入。
     */
    it('Explore Agent 真实配置 → tools 和 disallowedTools 均完整', () => {
        const template = makeTemplate({
            name: 'Explore Agent',
            allowedTools: ['glob', 'grep', 'file_read'],
            disallowedTools: ['agent', 'file_edit', 'file_write', 'notebook_edit'],
        })
        const def = agentTemplateToDefinition(template)
        expect(def.agentType).toBe('Explore Agent')
        expect(def.tools).toEqual(['glob', 'grep', 'file_read'])
        expect(def.disallowedTools).toEqual(['agent', 'file_edit', 'file_write', 'notebook_edit'])
    })
})
