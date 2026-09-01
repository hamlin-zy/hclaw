// @vitest-environment jsdom
/**
 * ThinkingEffortSelector — 会话级思考强度选择器单元测试
 *
 * 覆盖：
 * ① 无 override 时只读展示生效值（方案角色继承所得）
 * ② 选档触发 setModelOverride，携带 endpointId/modelId/thinkingEffort
 * ③ 协议档位列表：anthropic 的 auto hint 含「等效 high」字样
 */
import {describe, expect, it, vi} from 'vitest'
import {render, screen, fireEvent} from '@testing-library/react'
import ThinkingEffortSelector from '../../../src/renderer/components/ThinkingEffortSelector'
import {useAgentStore} from '../../../src/renderer/stores/agentStore'

// 活动方案：primary 角色 p1/m1 未显式配置 thinkingEffort（→ 展示 auto）；
// light 角色配 high 以覆盖角色继承路径。
const activeScheme = {
    id: 'scheme-1',
    name: 'test-scheme',
    enabled: true,
    roles: [
        {role: 'primary', enabled: true, endpointId: 'p1', modelId: 'm1'},
        {role: 'lightweight', enabled: true, endpointId: 'p2', modelId: 'm3', thinkingEffort: 'high'},
        {role: 'reasoning', enabled: false, endpointId: '', modelId: ''},
    ],
}

const mockSchemeState = () => ({schemes: [activeScheme], activeSchemeId: 'scheme-1'})

vi.mock('../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: vi.fn((selector?: any) => {
        const state = {
            modelOverride: null as any,
            setModelOverride: vi.fn(),
        }
        return selector ? selector(state) : state
    }),
}))
vi.mock('../../../src/renderer/stores/llmStore', () => ({
    useLLMStore: (selector: any) => {
        const state = {
            providers: [
                {id: 'p1', name: 'AnthropicA', type: 'anthropic', enabled: true, models: [{id: 'm1', name: 'claude-1', enabled: true}]},
                {id: 'p2', name: 'B', type: 'openai', enabled: true, models: [{id: 'm3', name: 'gpt-x', enabled: true}]},
            ],
        }
        return selector ? selector(state) : state
    },
}))
vi.mock('../../../src/renderer/stores/modelSchemeStore', () => ({
    useModelSchemeStore: Object.assign(
        vi.fn((selector: any) => (selector ? selector(mockSchemeState()) : null)),
        {
            getState: vi.fn(() => ({...mockSchemeState(), getActiveScheme: () => activeScheme})),
        },
    ),
}))

describe('ThinkingEffortSelector', () => {
    it('无 override 时只读展示生效值（primary 无显式 effort → auto）', () => {
        render(<ThinkingEffortSelector conversationId="conv-1"/>)
        expect(screen.getByText(/思维:\s*自动/)).toBeTruthy()
    })

    it('选档触发 setModelOverride 携带 endpointId/modelId/thinkingEffort', () => {
        const setModelOverride = vi.fn()
        vi.mocked(useAgentStore).mockImplementation((sel: any) => {
            const state = {modelOverride: null, setModelOverride}
            return sel ? sel(state) : state
        })
        render(<ThinkingEffortSelector conversationId="conv-1"/>)
        fireEvent.click(screen.getByTitle('思考强度'))
        fireEvent.click(screen.getByRole('button', {name: /^medium$/}))
        expect(setModelOverride).toHaveBeenCalledWith(
            'conv-1',
            expect.objectContaining({endpointId: 'p1', modelId: 'm1', thinkingEffort: 'medium'}),
        )
    })

    it('anthropic 协议档位列表：auto 的 hint 含「等效 high」', () => {
        render(<ThinkingEffortSelector conversationId="conv-1"/>)
        fireEvent.click(screen.getByTitle('思考强度'))
        const autoBtn = screen.getByTitle(/等效 high/)
        expect(autoBtn.textContent).toBe('自动')
    })

    it('选项列表前置「禁用」档位', () => {
        render(<ThinkingEffortSelector conversationId="conv-1"/>)
        fireEvent.click(screen.getByTitle('思考强度'))
        const disabledBtn = screen.getByRole('button', {name: /^禁用$/})
        expect(disabledBtn).toBeTruthy()
    })

    it('选「禁用」触发 setModelOverride 携带 thinkingEffort:disabled', () => {
        const setModelOverride = vi.fn()
        vi.mocked(useAgentStore).mockImplementation((sel: any) => {
            const state = {modelOverride: null, setModelOverride}
            return sel ? sel(state) : state
        })
        render(<ThinkingEffortSelector conversationId="conv-1"/>)
        fireEvent.click(screen.getByTitle('思考强度'))
        fireEvent.click(screen.getByRole('button', {name: /^禁用$/}))
        expect(setModelOverride).toHaveBeenCalledWith(
            'conv-1',
            expect.objectContaining({endpointId: 'p1', modelId: 'm1', thinkingEffort: 'disabled'}),
        )
    })

    it('override 为 disabled 时展示「禁用」文案', () => {
        vi.mocked(useAgentStore).mockImplementation((sel: any) => {
            const state = {
                modelOverride: {endpointId: 'p1', modelId: 'm1', thinkingEffort: 'disabled'},
                setModelOverride: vi.fn(),
            }
            return sel ? sel(state) : state
        })
        render(<ThinkingEffortSelector conversationId="conv-1"/>)
        expect(screen.getByText(/思维:\s*禁用/)).toBeTruthy()
    })
})
