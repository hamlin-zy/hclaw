import {beforeEach, describe, expect, it, vi} from 'vitest'
import type {LLMProvider, ModelScheme, ModelSchemeRole} from '@shared/types'

// modelSelector 依赖的 providerRepo stub（与现有 modelSelector.test.ts 同策略）
vi.mock('@/main/repositories/sqlite/llmProviderRepository', () => ({
    SqliteProviderRepository: vi.fn(function () { return {getById: vi.fn()} }),
}))
// R8（Task 5 裁决）：会话仓库统一从 repositories barrel 导入，测试 mock 拦截 barrel。
// barrel mock 需提供模块加载链上用到的工厂：createConversationRepository（setup/runtimeConfigManager）
// 与 createPermissionRepository（permissionRule 模块级构造 new PermissionRulesManager() 调用）。
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
    {role: 'lightweight', endpointId: 'p-deepseek', modelId: 'v3', enabled: false},
    {role: 'reasoning', endpointId: 'p-openai', modelId: 'gpt-5', enabled: false},
])

async function runSelect(analysis: any, sessionId?: string, modelRoleOverride?: any): Promise<TurnModelSelection> {
    const gen = selectModelForTurn(analysis, {scheme: SCHEME, providers: PROVIDERS}, sessionId, modelRoleOverride)
    const events: any[] = []
    let result: TurnModelSelection | undefined
    let step = gen.next()
    while (!step.done) {
        events.push(step.value)
        step = gen.next()
    }
    result = step.value
    return result!
}

describe('selectModelForTurn — override 优先 + auto 意图分析', () => {
    beforeEach(() => { vi.clearAllMocks() })

    it('会话 override 存在 → 直接解析该模型（绕过角色），directModel=true', async () => {
        runtimeConfigManager.setOverride('conv-1', {endpointId: 'p-deepseek', modelId: 'v3'})
        const sel = await runSelect({suggestedModel: 'reasoning', complexity: 'complex'}, 'conv-1')
        expect(sel.directModel).toBe(true)
        expect(sel.modelConfig.model).toBe('deepseek-v3')
        expect(sel.modelConfig.provider).toBe('custom')
    })

    it('override 指向已删除/禁用的 provider → 降级 auto + warning', async () => {
        runtimeConfigManager.setOverride('conv-2', {endpointId: 'p-gone', modelId: 'x'})
        const gen = selectModelForTurn({suggestedModel: 'primary', complexity: 'simple'}, {scheme: SCHEME, providers: PROVIDERS}, 'conv-2')
        const events: any[] = []
        let result: TurnModelSelection | undefined
        let step = gen.next()
        while (!step.done) { events.push(step.value); step = gen.next() }
        result = step.value
        expect(result!.directModel).toBeUndefined()
        expect(events.some(e => e.type === 'warning')).toBe(true)
        expect(result!.modelConfig.model).toBe('gpt-4o') // auto → primary
    })

    it('override 指向 enabled:false 的 provider → 降级 auto + warning（C3）', async () => {
        const disabledProvider: LLMProvider[] = [
            {id: 'p-offline', name: 'Offline', type: 'custom', enabled: false, apiKey: 'sk',
             models: [{id: 'm1', name: 'off-model', enabled: true}]},
            ...PROVIDERS,
        ]
        runtimeConfigManager.setOverride('conv-c3a', {endpointId: 'p-offline', modelId: 'm1'})
        const gen = selectModelForTurn({suggestedModel: 'primary', complexity: 'simple'}, {scheme: SCHEME, providers: disabledProvider}, 'conv-c3a')
        const events: any[] = []
        let result: TurnModelSelection | undefined
        let step = gen.next()
        while (!step.done) { events.push(step.value); step = gen.next() }
        result = step.value
        expect(result!.directModel).toBeUndefined()
        expect(events.some(e => e.type === 'warning')).toBe(true)
        expect(result!.modelConfig.model).toBe('gpt-4o') // auto → primary
    })

    it('override 指向 enabled:false 的 model → 降级 auto + warning（C3）', async () => {
        const disabledModel: LLMProvider[] = [
            {id: 'p-openai', name: 'OpenAI', type: 'openai', enabled: true, apiKey: 'sk',
             models: [{id: 'gpt-5', name: 'gpt-5', enabled: true}, {id: 'gpt-4o', name: 'gpt-4o', enabled: true}, {id: 'gpt-disabled', name: 'gpt-disabled', enabled: false}]},
        ]
        runtimeConfigManager.setOverride('conv-c3b', {endpointId: 'p-openai', modelId: 'gpt-disabled'})
        const gen = selectModelForTurn({suggestedModel: 'primary', complexity: 'simple'}, {scheme: SCHEME, providers: disabledModel}, 'conv-c3b')
        const events: any[] = []
        let result: TurnModelSelection | undefined
        let step = gen.next()
        while (!step.done) { events.push(step.value); step = gen.next() }
        result = step.value
        expect(result!.directModel).toBeUndefined()
        expect(events.some(e => e.type === 'warning')).toBe(true)
        expect(result!.modelConfig.model).toBe('gpt-4o') // auto → primary
    })

    it('无 override → auto 意图分析（simple→lightweight 未启用→fallback primary + warning）', async () => {
        const sel = await runSelect({suggestedModel: 'lightweight', complexity: 'simple'}, 'conv-3')
        expect(sel.directModel).toBeUndefined()
        expect(sel.modelConfig.model).toBe('gpt-4o') // lightweight 未启用 → primary
    })

    it('显式 modelRole 优先于 override（reasoning 启用时用推理模型）', async () => {
        const scheme2 = makeScheme([
            {role: 'primary', endpointId: 'p-openai', modelId: 'gpt-4o'},
            {role: 'reasoning', endpointId: 'p-openai', modelId: 'gpt-5', enabled: true},
        ])
        runtimeConfigManager.setOverride('conv-4', {endpointId: 'p-deepseek', modelId: 'v3'})
        const gen = selectModelForTurn({suggestedModel: 'primary', complexity: 'simple'}, {scheme: scheme2, providers: PROVIDERS}, 'conv-4', 'reasoning')
        let result: TurnModelSelection | undefined
        let step = gen.next()
        while (!step.done) { step = gen.next() }
        result = step.value
        expect(result!.modelConfig.model).toBe('gpt-5')
        expect(result!.directModel).toBeUndefined()
    })

    it('显式 modelRole 非法/未启用 → 降级 override / auto', async () => {
        const scheme2 = makeScheme([
            {role: 'primary', endpointId: 'p-openai', modelId: 'gpt-4o'},
        ])
        runtimeConfigManager.setOverride('conv-5', {endpointId: 'p-deepseek', modelId: 'v3'})
        // 'image_understanding' 非法（非 3 文本角色）→ 降级继承 override
        const gen = selectModelForTurn({suggestedModel: 'primary', complexity: 'simple'}, {scheme: scheme2, providers: PROVIDERS}, 'conv-5', 'image_understanding' as any)
        let result: TurnModelSelection | undefined
        let step = gen.next()
        while (!step.done) { step = gen.next() }
        result = step.value
        expect(result!.directModel).toBe(true)
        expect(result!.modelConfig.model).toBe('deepseek-v3')
    })
})
