import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

vi.mock('@/main/config', () => ({
    getHclawDir: () => '/tmp/hclaw-test',
}))
vi.mock('@/main/hclawPaths', async () => await import('@/main/config'))  // 路径能力已下沉到叶子 hclawPaths：让叶子跟随本文件对 config 的桩，避免绕过 mock 落到真实 ~/.hclaw
// entityCommandResolver → skills loader → config / sqlite 为纯副作用依赖（与 entityCommandResolver.test.ts 同策略）
vi.mock('@/main/repositories/sqlite', () => ({getDatabase: () => ({})}))
vi.mock('@/main/repositories/sqlite/systemSettingsRepository', () => ({systemSettingsRepo: {}}))

import {buildAgentDefinitionCtMessage, shouldInjectCommandTaskCt} from '@/main/agent/loop/agentDefinitionCt'
import {createLoopState} from '@/main/agent/state'
import {agentTemplateToDefinition} from '@/main/agent/agentTemplateConverter'
import {resolveEntityCommand} from '@/main/agent/entityCommandResolver'
import {agentRegistry} from '@/main/agent/agentRegistry'
import {buildCommandTaskContent} from '@/main/agent/utils/userContentBuilder'
import {SOURCE_KIND_COMMAND_TASK} from '@shared/types'
import type {AgentTemplate} from '@shared/types'
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

describe('shouldInjectCommandTaskCt（幂等守卫：两条 CT 注入路径共用）', () => {
    it('state 无相同 CT 消息 → 允许注入', () => {
        const state = createLoopState([{role: 'user', content: 'hi'}])
        const content = buildAgentDefinitionCtMessage(def)!.content
        expect(shouldInjectCommandTaskCt(state.messages, content)).toBe(true)
    })

    it('state 已有相同内容 CT 消息 → 拒绝重复注入（跨轮恢复 agentDefinition 不产生重复）', () => {
        const ct = buildAgentDefinitionCtMessage(def)!
        const state = createLoopState([
            {role: 'user', content: 'hi'},
            ct,
        ])
        expect(shouldInjectCommandTaskCt(state.messages, ct.content)).toBe(false)
    })

    it('agent 模板变化 → 内容不同 → 允许注入新 CT', () => {
        const ct = buildAgentDefinitionCtMessage(def)!
        const state = createLoopState([ct])
        const newCt = buildAgentDefinitionCtMessage({...def, systemPromptTemplate: '# Aside v2'})!
        expect(shouldInjectCommandTaskCt(state.messages, newCt.content)).toBe(true)
    })

    it('口径不变：sourceKind 非 command-task 的消息（内容相同）不参与去重 → 允许注入', () => {
        const ct = buildAgentDefinitionCtMessage(def)!
        const state = createLoopState([
            {role: 'user', content: ct.content, metadata: {sourceKind: 'catalog'}},
        ])
        expect(shouldInjectCommandTaskCt(state.messages, ct.content)).toBe(true)
    })
})

describe('S9：whenToUse 为空、description 非空 → 两条 CT 注入路径字节一致', () => {
    beforeEach(() => {
        agentRegistry.clear()
    })
    afterEach(() => {
        agentRegistry.clear()
    })

    it('agentDefinition 路径与 commandContext 路径产出逐字节相同的 CT 正文（内容去重成立）', () => {
        // 注册表模板：whenToUse 缺省（空）、description 非空
        const template: AgentTemplate = {
            id: 's9-fallback',
            name: 'S9 Fallback Agent',
            description: 'S9 回落描述',
            systemPrompt: '# S9 Fallback\n\n正文',
            enabled: true,
            tags: [],
            createdAt: 0,
            updatedAt: 0,
        }
        agentRegistry.register(template)

        // 路径一：commandContext（直接使用注册表模板）
        const resolved = resolveEntityCommand('S9 Fallback Agent')
        expect(resolved).not.toBeNull()
        const fromCommandContext = buildCommandTaskContent(resolved!.template)

        // 路径二：agentDefinition（入参经 agentTemplateToDefinition 回落 whenToUse）
        const defined = buildAgentDefinitionCtMessage(agentTemplateToDefinition(template))
        expect(defined).not.toBeNull()

        // 两条路径对同一 agent 必须逐字节相等，否则 shouldInjectCommandTaskCt 内容去重失效
        expect(defined!.content).toBe(fromCommandContext)
        // 归一化后的「适用场景」行两路都在（whenToUse 空 → 回落 description）
        expect(defined!.content).toContain('适用场景: S9 回落描述')
        expect(fromCommandContext).toContain('适用场景: S9 回落描述')
    })
})

describe('安全决策：权限模式不下发模型（CT 两路均不得输出「权限模式」行）', () => {
    beforeEach(() => {
        agentRegistry.clear()
    })
    afterEach(() => {
        agentRegistry.clear()
    })

    it('显式 permissionMode 的 agent 模板：两路 CT 均不含「权限模式」，且仍逐字节相等', () => {
        const template: AgentTemplate = {
            id: 'perm-ct',
            name: 'Perm Ct Agent',
            description: 'CT 权限行探测',
            systemPrompt: '# Perm Ct\n\n正文',
            enabled: true,
            tags: [],
            permissionMode: 'auto',
            createdAt: 0,
            updatedAt: 0,
        }
        agentRegistry.register(template)

        // 路径一：commandContext（直接使用注册表模板，模板自带 permissionMode）
        const resolved = resolveEntityCommand('Perm Ct Agent')
        expect(resolved).not.toBeNull()
        expect(resolved!.template).not.toContain('权限模式')

        // 路径二：agentDefinition（经 agentTemplateToDefinition 传递 permissionMode）
        const defined = buildAgentDefinitionCtMessage(agentTemplateToDefinition(template))
        expect(defined).not.toBeNull()
        expect(defined!.content).not.toContain('权限模式')

        // S9 断言不得回归：两路仍逐字节相等
        expect(defined!.content).toBe(buildCommandTaskContent(resolved!.template))
    })
})
