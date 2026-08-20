/**
 * selectModelForTurn — modelRole 显式角色决策测试
 *
 * 补足 setup.selectModelForTurn.override.test.ts 未覆盖的 modelRole 分支
 * （agentTool 子会话专用参数）：
 * - modelRole=lightweight/reasoning（启用配置）→ 解析对应角色模型
 * - modelRole 角色未启用/未配置 → 降级（override → primary）
 * - 与 resolveChildConvOverride 的决策一致性由
 *   agentTool.executeModelRole.test.ts（固化 override 参数锚定同一 SCHEME 角色配置）保障
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'
import type {LLMProvider, ModelScheme, ModelSchemeRole} from '@shared/types'

// 与 setup.selectModelForTurn.override.test.ts 同策略的 mock 集（已验证可跑）
vi.mock('@/main/repositories/sqlite/llmProviderRepository', () => ({
    SqliteProviderRepository: vi.fn(function () { return {getById: vi.fn()} }),
}))
vi.mock('../../../../src/main/repositories', () => ({
    createConversationRepository: () => ({readMeta: vi.fn(() => null), updateMeta: vi.fn()}),
    createPermissionRepository: () => ({}),
}))
vi.mock('../../../../src/main/repositories/sqlite/systemSettingsRepository', () => ({
    systemSettingsRepo: {get: vi.fn(() => null), getJson: vi.fn(() => null), set: vi.fn(), setJson: vi.fn()},
}))

import {runtimeConfigManager} from '@/main/agent/runtimeConfigManager'
import {selectModelForTurn} from '@/main/agent/loop/setup'
import type {TurnModelSelection} from '@/main/agent/loop/types'

const PROVIDERS: LLMProvider[] = [
    {id: 'p-openai', name: 'OpenAI', type: 'openai', enabled: true, apiKey: 'sk', models: [{id: 'gpt-5', name: 'gpt-5', enabled: true}, {id: 'gpt-4o', name: 'gpt-4o', enabled: true}]},
    {id: 'p-deepseek', name: 'DeepSeek', type: 'custom', enabled: true, apiKey: 'sk', models: [{id: 'v3', name: 'deepseek-v3', enabled: true}]},
]

function makeScheme(roles: Array<Partial<ModelSchemeRole> & {role: string}>): ModelScheme {
    return {
        id: 'scheme-1', name: 'test', enabled: true,
        roles: roles.map(r => ({id: `id-${r.role}`, modelType: 'text' as const, enabled: true, endpointId: '', modelId: '', ...r})),
    }
}

const SCHEME = makeScheme([
    {role: 'primary', endpointId: 'p-openai', modelId: 'gpt-4o'},
    {role: 'lightweight', endpointId: 'p-deepseek', modelId: 'v3'},
    {role: 'reasoning', endpointId: 'p-openai', modelId: 'gpt-5', enabled: false},
])

async function runSelect(sessionId?: string, modelRoleOverride?: any): Promise<TurnModelSelection> {
    const gen = selectModelForTurn({scheme: SCHEME, providers: PROVIDERS}, sessionId, modelRoleOverride)
    let result: TurnModelSelection | undefined
    let step = gen.next()
    while (!step.done) step = gen.next()
    result = step.value
    return result!
}

describe('selectModelForTurn — 显式 modelRole（agentTool 子会话）', () => {
    beforeEach(() => { vi.clearAllMocks() })

    it('modelRole=lightweight（已启用配置）→ 解析 lightweight 角色模型', async () => {
        const sel = await runSelect(undefined, 'lightweight')
        expect(sel.suggestedRole).toBe('lightweight')
        expect(sel.modelConfig.model).toBe('deepseek-v3')
        expect(sel.providerName).toBe('DeepSeek')
        expect(sel.directModel).toBeUndefined()
    })

    it('modelRole=primary → 解析 primary 角色模型', async () => {
        const sel = await runSelect(undefined, 'primary')
        expect(sel.suggestedRole).toBe('primary')
        expect(sel.modelConfig.model).toBe('gpt-4o')
    })

    it('modelRole 角色未启用（reasoning disabled）→ 降级默认 primary', async () => {
        const sel = await runSelect(undefined, 'reasoning')
        expect(sel.suggestedRole).toBe('primary')
        expect(sel.modelConfig.model).toBe('gpt-4o')
    })

    it('modelRole 优先于会话 override（显式角色是子会话权威决策源）', async () => {
        // 父链存在 override，但显式 modelRole 优先（第 0 步先于 override 第 1 步）
        runtimeConfigManager.setOverride('conv-x', {endpointId: 'p-openai', modelId: 'gpt-5'})
        const sel = await runSelect('conv-x', 'lightweight')
        expect(sel.suggestedRole).toBe('lightweight')
        expect(sel.modelConfig.model).toBe('deepseek-v3')
        expect(sel.directModel).toBeUndefined()
    })
})
