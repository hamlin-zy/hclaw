import {describe, expect, it, vi} from 'vitest'

vi.mock('@/main/repositories/sqlite/llmProviderRepository', () => ({
    SqliteProviderRepository: vi.fn(function () { return {getById: vi.fn()} }),
}))

import {resolveChannelModelConfig} from '@/main/agent/model/modelSelector'
import type {LLMProvider} from '@shared/types'

const PROVIDERS: LLMProvider[] = [
    {id: 'p1', name: 'DeepSeek', type: 'custom', enabled: true, apiKey: 'sk',
     models: [{id: 'v3', name: 'deepseek-v3', enabled: true}]},
]

describe('resolveChannelModelConfig（渠道会话初始 modelConfig）', () => {
    it('override 有效 → 解析出对应模型', () => {
        const cfg = resolveChannelModelConfig({endpointId: 'p1', modelId: 'v3'}, PROVIDERS)
        expect(cfg).toBeDefined()
        expect(cfg!.model).toBe('deepseek-v3')
    })
    it('override 为 null（auto）→ undefined，不预置 modelConfig', () => {
        expect(resolveChannelModelConfig(null, PROVIDERS)).toBeUndefined()
    })
    it('override 指向失效 provider → undefined（降级 auto）', () => {
        expect(resolveChannelModelConfig({endpointId: 'p-gone', modelId: 'x'}, PROVIDERS)).toBeUndefined()
    })
    it('override 指向已禁用 provider → undefined（C3：enabled=false 判定为失效）', () => {
        const disabledProvider: LLMProvider[] = [
            {id: 'p2', name: 'Offline', type: 'custom', enabled: false, apiKey: 'sk',
             models: [{id: 'm1', name: 'off-model', enabled: true}]},
        ]
        expect(resolveChannelModelConfig({endpointId: 'p2', modelId: 'm1'}, disabledProvider)).toBeUndefined()
    })
    it('override 指向已禁用 model → undefined（C3：model.enabled=false 判定为失效）', () => {
        const disabledModel: LLMProvider[] = [
            {id: 'p3', name: 'DeepSeek', type: 'custom', enabled: true, apiKey: 'sk',
             models: [{id: 'v3-disabled', name: 'deepseek-v3', enabled: false}]},
        ]
        expect(resolveChannelModelConfig({endpointId: 'p3', modelId: 'v3-disabled'}, disabledModel)).toBeUndefined()
    })
    it('providers 为空 → undefined', () => {
        expect(resolveChannelModelConfig({endpointId: 'p1', modelId: 'v3'}, [])).toBeUndefined()
    })
})
