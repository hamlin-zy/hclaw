import {describe, expect, it, vi} from 'vitest'

vi.mock('@/main/config', () => ({
    getHclawDir: () => '/tmp/hclaw-test',
}))

import {buildAgentDefinitionCtMessage, shouldInjectAgentDefinitionCt} from '@/main/agent/loop/agentDefinitionCt'
import {createLoopState} from '@/main/agent/state'
import {SOURCE_KIND_COMMAND_TASK} from '@shared/types'
import type {AgentDefinition} from '@shared/agent'

const def: AgentDefinition = {
    source: 'user',
    agentType: 'aside',
    whenToUse: '旁听',
    description: 'Aside Command',
    renderedSystemPrompt: '# Aside Command\n\n你是旁听者。工作目录: {working_dir}',
    systemPromptTemplate: '# Aside Command\n\n你是旁听者。工作目录: {working_dir}',
}

describe('buildAgentDefinitionCtMessage（方案 A：agent 模板走 CT 消息）', () => {
    it('agentDefinition 存在 → 生成包裹版 CT 用户消息（与 commandContext 路径字节一致）', () => {
        const msg = buildAgentDefinitionCtMessage(def)
        expect(msg).not.toBeNull()
        expect(msg!.role).toBe('user')
        expect(msg!.metadata).toMatchObject({sourceKind: SOURCE_KIND_COMMAND_TASK})
        // 包裹版：外框 + 代理模式头部 + 原模板正文（不渲染变量）
        expect(msg!.content).toContain('<command-task>')
        expect(msg!.content).toContain('# 代理模式: aside')
        expect(msg!.content).toContain('你正在使用代理 "aside"。')
        expect(msg!.content).toContain('Aside Command')
        // {working_dir} 保持字面原文（不注入路径，与 commandContext 路径一致）
        expect(msg!.content).toContain('{working_dir}')
        expect(msg!.content).not.toContain('/x/y')
    })

    it('agentDefinition 缺失或无模板 → null（不注入）', () => {
        expect(buildAgentDefinitionCtMessage(undefined)).toBeNull()
        expect(buildAgentDefinitionCtMessage({...def, systemPromptTemplate: ''})).toBeNull()
    })

    it('内容幂等：同一模板重复构建内容一致（可去重）', () => {
        const a = buildAgentDefinitionCtMessage(def)!
        const b = buildAgentDefinitionCtMessage(def)!
        expect(a.id).not.toBe(b.id) // id 每次新建
        expect(a.content).toBe(b.content) // 内容稳定 → 幂等守卫可用内容比对
    })
})

describe('shouldInjectAgentDefinitionCt（幂等守卫）', () => {
    it('state 无相同 CT 消息 → 允许注入', () => {
        const state = createLoopState([{role: 'user', content: 'hi'}])
        const content = buildAgentDefinitionCtMessage(def)!.content
        expect(shouldInjectAgentDefinitionCt(state.messages, content)).toBe(true)
    })

    it('state 已有相同内容 CT 消息 → 拒绝重复注入（跨轮恢复 agentDefinition 不产生重复）', () => {
        const ct = buildAgentDefinitionCtMessage(def)!
        const state = createLoopState([
            {role: 'user', content: 'hi'},
            ct,
        ])
        expect(shouldInjectAgentDefinitionCt(state.messages, ct.content)).toBe(false)
    })

    it('agent 模板变化 → 内容不同 → 允许注入新 CT', () => {
        const ct = buildAgentDefinitionCtMessage(def)!
        const state = createLoopState([ct])
        const newCt = buildAgentDefinitionCtMessage({...def, systemPromptTemplate: '# Aside v2'})!
        expect(shouldInjectAgentDefinitionCt(state.messages, newCt.content)).toBe(true)
    })
})
