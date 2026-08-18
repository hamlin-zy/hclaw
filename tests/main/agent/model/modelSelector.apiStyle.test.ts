import {describe, expect, it, vi} from 'vitest'

// modelSelector 顶层 new SqliteProviderRepository() → 内存 stub（与现有 modelSelector.test.ts 同策略）
vi.mock('@/main/repositories/sqlite/llmProviderRepository', () => ({
    SqliteProviderRepository: vi.fn(function () {
        return {getById: vi.fn()}
    }),
}))

import {resolveModelConfig} from '@/main/agent/model/modelSelector'
import type {LLMProvider, ModelRoleConfig} from '@shared/types'

describe('resolveModelConfig apiStyle 透传', () => {
    it('provider.apiStyle=responses → ModelConfig.apiStyle=responses', () => {
        const providers: LLMProvider[] = [{
            id: 'p1', name: 'OpenAI', type: 'openai', enabled: true, apiKey: 'sk-test', apiStyle: 'responses',
            models: [{id: 'gpt-5', name: 'gpt-5', enabled: true}],
        }]
        const roleConfig: ModelRoleConfig = {endpointId: 'p1', modelId: 'gpt-5', enabled: true}
        const config = resolveModelConfig(roleConfig, providers)
        expect(config).not.toBeNull()
        expect(config!.apiStyle).toBe('responses')
    })

    it('provider 无 apiStyle → ModelConfig.apiStyle 缺省（chat）', () => {
        const providers: LLMProvider[] = [{
            id: 'p2', name: 'DeepSeek', type: 'custom', enabled: true, apiKey: 'sk-test',
            models: [{id: 'v3', name: 'deepseek-v3', enabled: true}],
        }]
        const roleConfig: ModelRoleConfig = {endpointId: 'p2', modelId: 'v3', enabled: true}
        const config = resolveModelConfig(roleConfig, providers)
        expect(config).not.toBeNull()
        expect(config!.apiStyle).toBe('chat')
    })
})
