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

async function runSelect(sessionId?: string, modelRoleOverride?: any): Promise<TurnModelSelection> {
    const gen = selectModelForTurn({scheme: SCHEME, providers: PROVIDERS}, sessionId, modelRoleOverride)
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

describe('selectModelForTurn — override 优先 + 默认 primary', () => {
    beforeEach(() => { vi.clearAllMocks() })

    it('会话 override 存在 → 直接解析该模型（绕过角色），directModel=true', async () => {
        runtimeConfigManager.setOverride('conv-1', {endpointId: 'p-deepseek', modelId: 'v3'})
        const sel = await runSelect('conv-1')
        expect(sel.directModel).toBe(true)
        expect(sel.modelConfig.model).toBe('deepseek-v3')
    })

    it('override 指向已删除/禁用的 provider → 降级默认 primary + warning', async () => {
        runtimeConfigManager.setOverride('conv-2', {endpointId: 'p-gone', modelId: 'x'})
        const sel = await runSelect('conv-2')
        expect(sel.directModel).toBeUndefined()
        expect(sel.modelConfig.model).toBe('gpt-4o') // 默认 primary
    })

    it('override 指向 enabled:false 的 provider → 降级默认 primary + warning', async () => {
        const disabledProvider = PROVIDERS.map(p => p.id === 'p-deepseek' ? {...p, enabled: false} : p)
        runtimeConfigManager.setOverride('conv-c3b', {endpointId: 'p-deepseek', modelId: 'v3'})
        const gen = selectModelForTurn({scheme: SCHEME, providers: disabledProvider}, 'conv-c3b')
        let result: TurnModelSelection | undefined
        let step = gen.next()
        while (!step.done) { step = gen.next() }
        result = step.value
        expect(result!.directModel).toBeUndefined()
        expect(result!.modelConfig.model).toBe('gpt-4o')
    })

    it('无 override → 默认 primary（不经过意图分析）', async () => {
        const sel = await runSelect('conv-3')
        expect(sel.directModel).toBeUndefined()
        expect(sel.modelConfig.model).toBe('gpt-4o')
        expect(sel.suggestedRole).toBe('primary')
    })

    it('显式 modelRole 优先于 override（reasoning 启用时用推理模型）', async () => {
        const scheme2 = makeScheme([
            {role: 'primary', endpointId: 'p-openai', modelId: 'gpt-4o'},
            {role: 'reasoning', endpointId: 'p-openai', modelId: 'gpt-5', enabled: true},
        ])
        runtimeConfigManager.setOverride('conv-4', {endpointId: 'p-deepseek', modelId: 'v3'})
        const gen = selectModelForTurn({scheme: scheme2, providers: PROVIDERS}, 'conv-4', 'reasoning')
        let result: TurnModelSelection | undefined
        let step = gen.next()
        while (!step.done) { step = gen.next() }
        result = step.value
        expect(result!.modelConfig.model).toBe('gpt-5')
        expect(result!.directModel).toBeUndefined()
    })

    it('显式 modelRole 非法/未启用 → 降级继承 override', async () => {
        const scheme2 = makeScheme([
            {role: 'primary', endpointId: 'p-openai', modelId: 'gpt-4o'},
        ])
        runtimeConfigManager.setOverride('conv-5', {endpointId: 'p-deepseek', modelId: 'v3'})
        // 'image_understanding' 非法（非 3 文本角色）→ 落入后续步骤 → 继承 override
        const gen = selectModelForTurn({scheme: scheme2, providers: PROVIDERS}, 'conv-5', 'image_understanding' as any)
        let result: TurnModelSelection | undefined
        let step = gen.next()
        while (!step.done) { step = gen.next() }
        result = step.value
        expect(result!.directModel).toBe(true) // 降级到 override
        expect(result!.modelConfig.model).toBe('deepseek-v3')
    })

    it('显式 modelRole 角色未启用 → 降级继承 override', async () => {
        const scheme2 = makeScheme([
            {role: 'primary', endpointId: 'p-openai', modelId: 'gpt-4o'},
            {role: 'reasoning', endpointId: 'p-openai', modelId: 'gpt-5', enabled: false}, // 未启用
        ])
        runtimeConfigManager.setOverride('conv-6', {endpointId: 'p-deepseek', modelId: 'v3'})
        const gen = selectModelForTurn({scheme: scheme2, providers: PROVIDERS}, 'conv-6', 'reasoning')
        let result: TurnModelSelection | undefined
        let step = gen.next()
        while (!step.done) { step = gen.next() }
        result = step.value
        expect(result!.directModel).toBe(true) // reasoning 未启用 → 降级 override
        expect(result!.modelConfig.model).toBe('deepseek-v3')
    })
})
