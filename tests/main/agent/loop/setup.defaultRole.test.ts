/**
 * selectModelForTurn — 子会话默认角色（lightweight）决策测试
 *
 * 规则：
 * - defaultRole='lightweight'（agentTool 子会话，未显式 modelRole）→ 默认轻量链 L→P→R
 * - 未传 defaultRole（向后兼容）→ 默认 primary 链 P→L→R
 * - 显式 modelRole 仍优先于 defaultRole
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'
import type {LLMProvider, ModelScheme, ModelSchemeRole} from '@shared/types'

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

async function runSelect(sessionId?: string, modelRoleOverride?: any, defaultRole?: any): Promise<TurnModelSelection> {
    const gen = selectModelForTurn({scheme: SCHEME, providers: PROVIDERS}, sessionId, modelRoleOverride, defaultRole)
    let step = gen.next()
    while (!step.done) step = gen.next()
    return step.value as TurnModelSelection
}

describe('selectModelForTurn — defaultRole（子会话默认轻量模型）', () => {
    beforeEach(() => { vi.clearAllMocks() })

    it('defaultRole=lightweight → 默认选 lightweight（无需显式 modelRole）', async () => {
        const sel = await runSelect(undefined, undefined, 'lightweight')
        expect(sel.suggestedRole).toBe('lightweight')
        expect(sel.modelConfig.model).toBe('deepseek-v3')
    })

    it('defaultRole=lightweight 但 lightweight 未启用 → 升级 primary（L→P）', async () => {
        const schemeNoLight = makeScheme([
            {role: 'primary', endpointId: 'p-openai', modelId: 'gpt-4o'},
            {role: 'lightweight', endpointId: 'p-deepseek', modelId: 'v3', enabled: false},
            {role: 'reasoning', endpointId: 'p-openai', modelId: 'gpt-5', enabled: false},
        ])
        const gen = selectModelForTurn({scheme: schemeNoLight, providers: PROVIDERS}, undefined, undefined, 'lightweight')
        let step = gen.next()
        while (!step.done) step = gen.next()
        const sel = step.value as TurnModelSelection
        expect(sel.suggestedRole).toBe('primary')
        expect(sel.modelConfig.model).toBe('gpt-4o')
    })

    it('未传 defaultRole（向后兼容）→ 默认 primary', async () => {
        const sel = await runSelect(undefined, undefined)
        expect(sel.suggestedRole).toBe('primary')
        expect(sel.modelConfig.model).toBe('gpt-4o')
    })

    it('显式 modelRole 优先于 defaultRole', async () => {
        const sel = await runSelect(undefined, 'primary', 'lightweight')
        expect(sel.suggestedRole).toBe('primary')
        expect(sel.modelConfig.model).toBe('gpt-4o')
    })
})
