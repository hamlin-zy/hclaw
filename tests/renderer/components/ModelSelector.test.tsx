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
import {fireEvent, render, screen, act} from '@testing-library/react'
import ModelSelector from '../../../src/renderer/components/ModelSelector'
import {useAgentStore} from '../../../src/renderer/stores/agentStore'
import {useModelSchemeStore} from '../../../src/renderer/stores/modelSchemeStore'
import {resolveOverrideEffortToWrite} from '../../../src/shared/thinkingEffort'

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

    // 装配层用例：handleApply 写入 override 时必须带上 resolveOverrideEffortToWrite 决策的档位，
    // 且 endpointId/modelId/providerName 与用户点选的目标一致（否则读取侧徽章/运行层会脱钩）
    it('handleApply 写入 override：thinkingEffort 与 resolveOverrideEffortToWrite 对相同输入一致', () => {
        vi.useFakeTimers()
        try {
            const setOverrideSpy = vi.fn()
            // 方案副本：仅给 lightweight 角色配档位 low —— 选 p2/m3（命中 lightweight 角色）时
            // 级 2 应写入 'low'；若装配漏写该字段，断言 undefined !== 'low' 会失败（证判别力）
            const schemeWithEffort = {
                ...activeScheme,
                roles: activeScheme.roles.map(r =>
                    r.role === 'lightweight' ? {...r, thinkingEffort: 'low'} : r,
                ),
            }
            const originalGetState = (useModelSchemeStore as any).getState
            vi.mocked(useAgentStore).mockImplementation((sel: any) => {
                const state = {modelOverride: null, setModelOverride: setOverrideSpy}
                return sel ? sel(state) : state
            })
            vi.mocked(useModelSchemeStore).mockImplementation((sel: any) =>
                sel ? sel({schemes: [schemeWithEffort], activeSchemeId: 'scheme-1'}) : null)
            ;(useModelSchemeStore as any).getState = vi.fn(() => ({
                schemes: [schemeWithEffort],
                activeSchemeId: 'scheme-1',
                getActiveScheme: () => schemeWithEffort,
            }))

            render(<ModelSelector conversationId="conv-1"/>)
            // 打开 popover → 点服务商 DeepSeek → 子菜单延迟 HOVER_DELAY 展开 → 点模型 deepseek-v3
            fireEvent.click(screen.getByTitle('选择模型'))
            fireEvent.click(screen.getByText('DeepSeek'))
            act(() => { vi.advanceTimersByTime(120) })
            fireEvent.click(screen.getByText('deepseek-v3'))

            expect(setOverrideSpy).toHaveBeenCalledTimes(1)
            const [convId, ov] = setOverrideSpy.mock.calls[0]
            // 与写入决策纯函数对相同输入的结果逐一比对
            const expected = resolveOverrideEffortToWrite({
                endpointId: 'p2',
                modelId: 'm3',
                scheme: schemeWithEffort as any,
                // 会话默认角色 = primary（本用例未配档位，防御脏值后不参与决策）
                defaultRole: {thinkingEffort: undefined},
                currentEffort: undefined,
            })
            expect(convId).toBe('conv-1')
            expect(ov.endpointId).toBe('p2')
            expect(ov.modelId).toBe('m3')
            expect(ov.providerName).toBe('DeepSeek')
            expect(ov.thinkingEffort).toBe(expected)
            // 显式钉死 'low'：防止 expected 意外为 undefined 时双向假绿
            expect(expected).toBe('low')

            // 恢复 mock factory 默认实现（本用例为 describe 最后一个，防御性收尾）
            vi.mocked(useAgentStore).mockReset()
            vi.mocked(useModelSchemeStore).mockReset()
            ;(useModelSchemeStore as any).getState = originalGetState
        } finally {
            vi.useRealTimers()
        }
    })
})
