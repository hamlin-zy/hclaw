import {describe, it, expect, vi, beforeEach} from 'vitest'

// ── mock 依赖：保持测试聚焦于「重建判定逻辑」，不依赖真实全局方案状态 ──
// createAdapterForContext 依赖全局模型方案/适配器工厂，测试环境无法构造真实 adapter，
// 故 mock 其实现返回一个带 chat 方法的假 adapter（简报 Step 1 的 mock 备选方案）。
vi.mock('../../../../src/main/agent/model/modelSchemeManager', () => ({
    getSchemeVersion: vi.fn(() => ({version: 1, updatedAt: 0})),
}))
vi.mock('../../../../src/main/agent/runtimeConfigManager', () => ({
    runtimeConfigManager: {
        getWorkMode: vi.fn(() => 'auto'),
        getScheme: vi.fn(() => null),
        getProviders: vi.fn(() => []),
    },
}))
vi.mock('../../../../src/main/agent/model/index', () => ({
    createAdapterForContext: vi.fn(async () => ({
        adapter: {chat: vi.fn()},
        providerType: 'mock',
        modelId: 'mock-model',
        configSource: 'global-scheme',
        schemeName: null,
    })),
    createModelAdapter: vi.fn(() => ({chat: vi.fn()})),
}))

import {LLMCaller} from '../../../../src/main/agent/loop/llmCaller'
import {createAdapterForContext} from '../../../../src/main/agent/model/index'
import {getSchemeVersion} from '../../../../src/main/agent/model/modelSchemeManager'
import {runtimeConfigManager} from '../../../../src/main/agent/runtimeConfigManager'

const mockCreate = vi.mocked(createAdapterForContext)
const mockGetVersion = vi.mocked(getSchemeVersion)
const mockGetWorkMode = vi.mocked(runtimeConfigManager.getWorkMode)

describe('LLMCaller.getAdapter (A2 adapter 管理收归 + workMode 变化重建)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockGetVersion.mockReturnValue({version: 1, updatedAt: 0})
        mockGetWorkMode.mockReturnValue('auto')
    })

    it('首次调用创建 adapter', async () => {
        const caller = new LLMCaller({maxRetries: 1, initialDelay: 1, maxDelay: 2})
        const result = await caller.getAdapter('main')
        expect(result.adapter).toBeTruthy()
        expect(mockCreate).toHaveBeenCalledTimes(1)
        expect(result.providerType).toBe('mock')
        expect(result.configSource).toBe('global-scheme')
    })

    it('连续调用（schemeVersion/workMode 不变）复用 adapter，不重建', async () => {
        const caller = new LLMCaller({maxRetries: 1, initialDelay: 1, maxDelay: 2})
        const first = await caller.getAdapter('main')
        const second = await caller.getAdapter('main')
        expect(second.adapter).toBe(first.adapter)
        expect(mockCreate).toHaveBeenCalledTimes(1)
    })

    it('schemeVersion 变化触发重建', async () => {
        const caller = new LLMCaller({maxRetries: 1, initialDelay: 1, maxDelay: 2})
        const first = await caller.getAdapter('main')
        mockGetVersion.mockReturnValue({version: 2, updatedAt: 0})
        const second = await caller.getAdapter('main')
        expect(second.adapter).not.toBe(first.adapter)
        expect(mockCreate).toHaveBeenCalledTimes(2)
    })

    it('A2: workMode 变化触发重建（auto → reasoning）', async () => {
        const caller = new LLMCaller({maxRetries: 1, initialDelay: 1, maxDelay: 2})
        const first = await caller.getAdapter('main')
        mockGetWorkMode.mockReturnValue('reasoning')
        const second = await caller.getAdapter('main')
        expect(second.adapter).not.toBe(first.adapter)
        expect(mockCreate).toHaveBeenCalledTimes(2)
    })

    it('_abortSignal 参数被接收但不透传（createAdapterForContext 无 abortSignal 支持，留作扩展）', async () => {
        const caller = new LLMCaller({maxRetries: 1, initialDelay: 1, maxDelay: 2})
        const controller = new AbortController()
        await caller.getAdapter('main', undefined, undefined, undefined, controller.signal)
        const callArgs = mockCreate.mock.calls[0]
        expect(callArgs[0]).toBe('main')
        // createAdapterForContext 仅接收三参（context, intentAnalysis?, fallbackConfig?）
        expect(callArgs.length).toBeLessThanOrEqual(3)
    })
})
