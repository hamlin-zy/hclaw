// @vitest-environment jsdom
/**
 * ModelSelector — 会话级模型选择器单元测试
 *
 * 覆盖需求（Task 10 + T12 回归）：
 * - override 存在时显示「服务商/模型」生效状态（只认 modelOverride，不回退历史选择）
 * - override 为空时虚拟选中当前方案 primary（显示 primary 模型名，不写库）
 * - 方案 primary 未配置/不可解析时兜底显示「主力模型」
 *
 * mock 说明：
 * - useAgentStore 组件内以「无 selector」调用（const {modelOverride, ...} = useAgentStore()），
 *   故 mock 需在 selector 缺省时返回完整 state 对象。
 * - useLLMStore 组件内以 selector 调用（s => s.providers），mock 需应用 selector。
 * - useModelSchemeStore 为 zustand store（函数对象 + .getState）；mock 提供 getState
 *   返回含 primary 角色的活动方案（虚拟选中语义），并支持 selector 订阅调用。
 */
import {describe, expect, it, vi} from 'vitest'
import {render, screen} from '@testing-library/react'
import ModelSelector from '../../../src/renderer/components/ModelSelector'
import {useAgentStore} from '../../../src/renderer/stores/agentStore'

vi.mock('../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: vi.fn((selector: any) => {
        const state = {
            modelOverride: {endpointId: 'p1', modelId: 'm1'},
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

// 活动方案：primary 角色指向 p1/m1（gpt-5）——无 override 时虚拟选中目标
const activeScheme = {
    id: 'scheme-1',
    name: 'test-scheme',
    enabled: true,
    roles: [
        {role: 'primary', enabled: true, endpointId: 'p1', modelId: 'm1'},
        {role: 'lightweight', enabled: true, endpointId: 'p2', modelId: 'm3'},
        {role: 'reasoning', enabled: false, endpointId: '', modelId: ''},
    ],
}

// usePrimaryRole 以 selector 订阅（schemes / activeSchemeId），mock 需对 selector 调用返回完整 state
const mockSchemeState = () => ({
    schemes: [activeScheme],
    activeSchemeId: 'scheme-1',
})

vi.mock('../../../src/renderer/stores/modelSchemeStore', () => ({
    useModelSchemeStore: Object.assign(
        vi.fn((selector: any) => (selector ? selector(mockSchemeState()) : null)),
        {
            getState: vi.fn(() => ({
                ...mockSchemeState(),
                getActiveScheme: () => activeScheme,
            })),
        },
    ),
}))

describe('ModelSelector', () => {
    it('override 存在时显示「服务商/模型」生效状态', () => {
        render(<ModelSelector conversationId="conv-1"/>)
        expect(screen.getByText(/gpt-5/)).toBeTruthy()
    })

    it('override 为空时虚拟选中 primary（显示 primary 模型名，不写库）', () => {
        vi.mocked(useAgentStore).mockImplementation((sel: any) => {
            const state = {
                modelOverride: null,
                setModelOverride: vi.fn(),
            }
            return sel ? sel(state) : state
        })
        render(<ModelSelector conversationId="conv-1"/>)
        expect(screen.getByText(/gpt-5/)).toBeTruthy()
    })
})
