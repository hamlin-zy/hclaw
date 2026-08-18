// @vitest-environment jsdom
/**
 * ModelSelector — 会话级模型选择器单元测试
 *
 * 覆盖需求（Task 10）：
 * - override 存在时显示「服务商/模型」生效状态（只认 modelOverride，不回退 lastSelected）
 * - override 为空时显示「自动」（auto 默认态）
 *
 * mock 说明：
 * - useAgentStore 组件内以「无 selector」调用（const {modelOverride, ...} = useAgentStore()），
 *   故 mock 需在 selector 缺省时返回完整 state 对象。
 * - useLLMStore 组件内以 selector 调用（s => s.providers），mock 需应用 selector。
 */
import {describe, expect, it, vi} from 'vitest'
import {render, screen} from '@testing-library/react'
import ModelSelector from '../../../src/renderer/components/ModelSelector'
import {useAgentStore} from '../../../src/renderer/stores/agentStore'

vi.mock('../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: vi.fn((selector: any) => {
        const state = {
            modelOverride: {endpointId: 'p1', modelId: 'm1'},
            lastSelected: {endpointId: 'p1', modelId: 'm1'},
            setModelOverride: vi.fn(),
        }
        return selector ? selector(state) : state
    }),
}))
vi.mock('../../../src/renderer/stores/llmStore', () => ({
    useLLMStore: (selector: any) => {
        const state = {
            providers: [
                {id: 'p1', name: 'OpenAI', type: 'openai', enabled: true, models: [{id: 'm1', name: 'gpt-5', enabled: true}, {id: 'm2', name: 'gpt-4o', enabled: true}]},
                {id: 'p2', name: 'DeepSeek', type: 'custom', enabled: true, models: [{id: 'm3', name: 'deepseek-v3', enabled: true}]},
            ],
        }
        return selector ? selector(state) : state
    },
}))
vi.mock('../../../src/renderer/stores/modelSchemeStore', () => ({
    useModelSchemeStore: () => null,
}))

describe('ModelSelector', () => {
    it('override 存在时显示「服务商/模型」生效状态', () => {
        render(<ModelSelector conversationId="conv-1"/>)
        expect(screen.getByText(/OpenAI\/gpt-5/)).toBeTruthy()
    })

    it('override 为空时显示 auto', () => {
        vi.mocked(useAgentStore).mockImplementation((sel: any) => {
            const state = {
                modelOverride: null,
                lastSelected: null,
                setModelOverride: vi.fn(),
            }
            return sel ? sel(state) : state
        })
        render(<ModelSelector conversationId="conv-1"/>)
        expect(screen.getByText(/自动/)).toBeTruthy()
    })
})
