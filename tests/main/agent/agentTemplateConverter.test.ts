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
