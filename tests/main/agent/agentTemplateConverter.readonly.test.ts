import {describe, expect, it} from 'vitest'
import {agentTemplateToDefinition} from '@/main/agent/agentTemplateConverter'
import type {AgentTemplate} from '@shared/types'

function tpl(over: Partial<AgentTemplate> = {}): AgentTemplate {
    return {
        id: 'local-explore', name: 'Explore Agent', description: '', systemPrompt: '',
        enabled: true, createdAt: 0, updatedAt: 0, ...over,
    }
}

describe('agentTemplateToDefinition readOnly 透传', () => {
    it('readOnly=true 透传到 AgentDefinition', () => {
        expect(agentTemplateToDefinition(tpl({readOnly: true})).readOnly).toBe(true)
    })
    it('缺省时不写该字段（保持现状）', () => {
        expect('readOnly' in agentTemplateToDefinition(tpl())).toBe(false)
    })
})
