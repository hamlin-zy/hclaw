import {describe, expect, it, vi} from 'vitest'

// 隔离保证：setup.ts → config → repositories 存在循环依赖，mock 掉 config 切断链路
vi.mock('../../../src/main/config', () => ({
    getHclawDir: () => '/tmp/hclaw-test',
}))

import {buildSystemPrompt} from '../../../src/main/agent/loop/setup'
import type {CommandExecutionContext} from '@shared/types'

/** 去除含"当前日期"的行，避免时间戳影响字节比较 */
function stripDateLines(s: string): string {
    return s.split('\n').filter(l => !l.includes('当前日期')).join('\n')
}

function makeCommandContext(commandId: string, template: string): CommandExecutionContext {
    return {
        commandId,
        commandName: commandId.split(':')[1] ?? commandId,
        commandTemplate: template,
    }
}

const baseParams = {
    agentDefinition: undefined,
    workingDir: '/x',
    availableToolDefinitions: [],
    currentPermissionMode: 'auto' as const,
    customInstructions: undefined,
    agentType: 'General',
    agentTemplates: undefined,
    cachedSystemPrompt: null,
}

describe('buildSystemPrompt 命令类型无关缓存稳定', () => {
    it('agent 命令与技能命令/无命令的 system 输出（去日期行）byte-equal', async () => {
        const agentCtx = makeCommandContext('agent:code-simplifier', '# 代理模式: code-simplifier\n\n请简化代码。')
        const skillCtx = makeCommandContext('skill:git-release-workflow', '# 技能: git-release-workflow\n\n按流程执行。')

        const agentPrompt = await buildSystemPrompt({...baseParams, commandContext: agentCtx})
        const skillPrompt = await buildSystemPrompt({...baseParams, commandContext: skillCtx})
        const noCmdPrompt = await buildSystemPrompt({...baseParams, commandContext: null})

        const a = stripDateLines(agentPrompt)
        const s = stripDateLines(skillPrompt)
        const n = stripDateLines(noCmdPrompt)

        expect(a).toBe(s)
        expect(a).toBe(n)

        // 命令模板不得提升进 system（由 CT 用户消息注入）
        expect(a).not.toContain('code-simplifier')
    })

    it('customInstructions 在 agent 命令分支同样生效', async () => {
        const agentCtx = makeCommandContext('agent:code-simplifier', '# 代理模式: code-simplifier')
        const p = await buildSystemPrompt({...baseParams, commandContext: agentCtx, customInstructions: '总是用中文回复'})
        expect(p).toContain('总是用中文回复')
    })
})

describe('buildSystemPrompt 方案 A：agentDefinition 分支稳定 base', () => {
    const asideDef = {
        source: 'user' as const,
        agentType: 'aside',
        whenToUse: '',
        description: '',
        renderedSystemPrompt: '',
        systemPromptTemplate: '# Aside Command\n\n你是旁听者。',
    }

    it('agentDefinition 分支与无命令 base 的 system（去日期行）byte-equal，且不含 agent 模板文本', async () => {
        const noCmd = stripDateLines(await buildSystemPrompt({...baseParams, commandContext: null}))
        const withDef = stripDateLines(await buildSystemPrompt({...baseParams, commandContext: null, agentDefinition: asideDef}))
        expect(withDef).toBe(noCmd)
        expect(withDef).not.toContain('Aside Command')
    })

    it('agentDefinition 分支与 commandContext 分支 byte-equal', async () => {
        const ctx = stripDateLines(await buildSystemPrompt({
            ...baseParams,
            commandContext: makeCommandContext('agent:aside', asideDef.systemPromptTemplate),
        }))
        const def = stripDateLines(await buildSystemPrompt({
            ...baseParams,
            commandContext: null,
            agentDefinition: asideDef,
        }))
        expect(def).toBe(ctx)
    })

    it('切换 agentDefinition → system 无变化（缓存可复用）', async () => {
        const a = stripDateLines(await buildSystemPrompt({
            ...baseParams, commandContext: null, agentDefinition: asideDef,
        }))
        const b = stripDateLines(await buildSystemPrompt({
            ...baseParams, commandContext: null,
            agentDefinition: {source: 'user' as const, agentType: 'plan', whenToUse: '', description: '', renderedSystemPrompt: '', systemPromptTemplate: '# Plan Command\n\n只读规划。'},
        }))
        expect(a).toBe(b)
    })

    it('customInstructions 在 agentDefinition 分支同样生效', async () => {
        const p = await buildSystemPrompt({
            ...baseParams, commandContext: null, agentDefinition: asideDef, customInstructions: '总是用中文回复',
        })
        expect(p).toContain('总是用中文回复')
    })
})
