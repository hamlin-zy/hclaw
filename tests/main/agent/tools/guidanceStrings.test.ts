import {describe, it, expect} from 'vitest'
import {agentTool} from '@/main/agent/tools/builtin/agentTool'
import {skillTool} from '@/main/agent/tools/builtin/skillTool'

describe('R3 guidance strings', () => {
    it('agentTool 引导 list_agents', () => {
        expect(agentTool.description).toMatch(/list_agents/)
    })
    it('skillTool 引导 describe_skills', () => {
        expect(skillTool.description).toMatch(/describe_skills/)
    })
})
