import {describe, expect, it} from 'vitest'
import type {ConversationMeta, LLMProvider, ModelConfig, ModelOverride} from '@shared/types'

describe('shared 模型 override / apiStyle 类型扩展', () => {
    it('ModelOverride 携带 endpointId + modelId（可选 providerName）', () => {
        const ov: ModelOverride = {endpointId: 'prov-1', modelId: 'deepseek-v3'}
        expect(ov.endpointId).toBe('prov-1')
        expect(ov.modelId).toBe('deepseek-v3')
        const ov2: ModelOverride = {endpointId: 'prov-1', modelId: 'gpt-5', providerName: 'OpenAI'}
        expect(ov2.providerName).toBe('OpenAI')
    })

    it('LLMProvider 可携带 apiStyle（缺省 chat）', () => {
        const provider: LLMProvider = {
            id: 'p1', name: 'OpenAI', type: 'openai', enabled: true, models: [],
            apiStyle: 'responses',
        }
        expect(provider.apiStyle).toBe('responses')
        const legacy: LLMProvider = {id: 'p2', name: 'DeepSeek', type: 'custom', enabled: true, models: []}
        expect(legacy.apiStyle).toBeUndefined() // 缺省走 chat
    })

    it('ModelConfig 透传 apiStyle', () => {
        const cfg: ModelConfig = {provider: 'openai', model: 'gpt-5', apiStyle: 'responses'}
        expect(cfg.apiStyle).toBe('responses')
    })

    it('ConversationMeta 可携带 modelOverride（null 表示显式 auto）', () => {
        const meta: ConversationMeta = {
            id: 'c1', title: 't', workspacePath: '', createdAt: 1, updatedAt: 1,
            preview: '', status: 'active', modelOverride: {endpointId: 'p1', modelId: 'm1'},
        }
        expect(meta.modelOverride?.modelId).toBe('m1')
        const metaAuto: ConversationMeta = {
            id: 'c2', title: 't', workspacePath: '', createdAt: 1, updatedAt: 1,
            preview: '', status: 'active', modelOverride: null,
        }
        expect(metaAuto.modelOverride).toBeNull()
    })
})
