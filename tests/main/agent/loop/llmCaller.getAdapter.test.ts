import {describe, it, expect, vi, beforeEach} from 'vitest'

// ── mock 依赖：保持测试聚焦于「重建判定逻辑」，不依赖真实全局方案状态 ──
// createAdapterForContext 依赖全局模型方案/适配器工厂，测试环境无法构造真实 adapter，
// 故 mock 其实现返回一个带 chat 方法的假 adapter（简报 Step 1 的 mock 备选方案）。
vi.mock('../../../../src/main/agent/model/modelSchemeManager', () => ({
    getSchemeVersion: vi.fn(() => ({version: 1, updatedAt: 0})),
}))
vi.mock('../../../../src/main/agent/runtimeConfigManager', () => ({
    runtimeConfigManager: {
        getOverride: vi.fn(() => null),
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

const mockCreate = vi.mocked(createAdapterForContext)
const mockGetVersion = vi.mocked(getSchemeVersion)

describe('LLMCaller.getAdapter (adapter 管理收归 + schemeVersion/角色/direct 变化重建)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockGetVersion.mockReturnValue({version: 1, updatedAt: 0})
    })

    it('首次调用创建 adapter', async () => {
        const caller = new LLMCaller()
        const result = await caller.getAdapter('main')
        expect(result.adapter).toBeTruthy()
        expect(mockCreate).toHaveBeenCalledTimes(1)
        expect(result.providerType).toBe('mock')
        expect(result.configSource).toBe('global-scheme')
    })

    it('连续调用（schemeVersion 不变）复用 adapter，不重建', async () => {
        const caller = new LLMCaller()
        const first = await caller.getAdapter('main')
        const second = await caller.getAdapter('main')
        expect(second.adapter).toBe(first.adapter)
        expect(mockCreate).toHaveBeenCalledTimes(1)
    })

    it('schemeVersion 变化触发重建', async () => {
        const caller = new LLMCaller()
        const first = await caller.getAdapter('main')
        mockGetVersion.mockReturnValue({version: 2, updatedAt: 0})
        const second = await caller.getAdapter('main')
        expect(second.adapter).not.toBe(first.adapter)
        expect(mockCreate).toHaveBeenCalledTimes(2)
    })

    it('_abortSignal 参数被接收但不透传（createAdapterForContext 无 abortSignal 支持，留作扩展）', async () => {
        const caller = new LLMCaller()
        const controller = new AbortController()
        await caller.getAdapter('main', undefined, undefined, undefined, controller.signal)
        const callArgs = mockCreate.mock.calls[0]
        expect(callArgs[0]).toBe('main')
        // createAdapterForContext only accepts 3 args (context, intentAnalysis?, fallbackConfig?)
        expect(callArgs.length).toBeLessThanOrEqual(3)
    })

    it('F1: suggestedModel (role) changes triggers recreate', async () => {
        const caller = new LLMCaller()
        const first = await caller.getAdapter('main', 'lightweight')
        // role is decided per-turn by intent analysis: simple -> lightweight, complex -> reasoning
        const second = await caller.getAdapter('main', 'reasoning')
        expect(second.adapter).not.toBe(first.adapter)
        expect(mockCreate).toHaveBeenCalledTimes(2)
        // second create must carry the new role
        const secondArgs = mockCreate.mock.calls[1]
        expect(secondArgs[1]).toEqual({suggestedModel: 'reasoning'})
        // role reverting also triggers recreate
        const third = await caller.getAdapter('main', 'lightweight')
        expect(third.adapter).not.toBe(second.adapter)
        expect(mockCreate).toHaveBeenCalledTimes(3)
    })

    it('F2: after global path fails to fallback, next call retries global path (state synced)', async () => {
        const caller = new LLMCaller()
        const fallbackConfig = {provider: 'custom' as const, model: 'fb-model'}

        // first: global path succeeds with role lightweight
        const first = await caller.getAdapter('main', 'lightweight')
        expect(first.configSource).toBe('global-scheme')

        // second: role changes -> recreate -> global path fails -> fallback
        // (old bug: catch path kept lastSuggestedModel/lastVersion at stale values)
        mockCreate.mockRejectedValueOnce(new Error('global scheme unavailable'))
        const {createModelAdapter} = await import('../../../../src/main/agent/model/index')
        const second = await caller.getAdapter('main', 'reasoning', fallbackConfig)
        expect(second.configSource).toBe('fallback')
        expect(createModelAdapter).toHaveBeenCalledTimes(1)

        // third: role reverts to lightweight -> with F2 sync the recreate is not
        // suppressed by stale state, so the (now recovered) global path is retried
        const third = await caller.getAdapter('main', 'lightweight', fallbackConfig)
        expect(third.adapter).not.toBe(second.adapter)
        expect(third.configSource).toBe('global-scheme')
        expect(mockCreate).toHaveBeenCalledTimes(3) // success + failed + retried
    })

    it('D1: directModel 同模型连续调用复用 adapter，不重建（缓存增量）', async () => {
        const caller = new LLMCaller()
        const directCfg = {provider: 'custom', model: 'deepseek-v3'} as any
        const first = await caller.getAdapter('main', undefined, directCfg, undefined, undefined, true)
        const second = await caller.getAdapter('main', undefined, directCfg, undefined, undefined, true)
        expect(second.adapter).toBe(first.adapter)
        expect(mockCreate).not.toHaveBeenCalled() // direct 路径不经过 createAdapterForContext
    })

    it('D1: directModel 切换模型（v3→gpt-5）触发重建', async () => {
        const caller = new LLMCaller()
        const first = await caller.getAdapter('main', undefined, {provider: 'custom', model: 'deepseek-v3'} as any, undefined, undefined, true)
        const second = await caller.getAdapter('main', undefined, {provider: 'custom', model: 'gpt-5'} as any, undefined, undefined, true)
        expect(second.adapter).not.toBe(first.adapter)
    })

    it('D1: direct ↔ auto 切换触发重建', async () => {
        const caller = new LLMCaller()
        const directCfg = {provider: 'custom', model: 'deepseek-v3'} as any
        const first = await caller.getAdapter('main', undefined, directCfg, undefined, undefined, true)
        const second = await caller.getAdapter('main', 'primary', {provider: 'custom', model: 'gpt-4o'} as any)
        expect(second.adapter).not.toBe(first.adapter)
        // 回到 direct 同模型 → 复用
        const third = await caller.getAdapter('main', undefined, directCfg, undefined, undefined, true)
        expect(third.adapter).toBe(first.adapter)
    })

    it('D2: schemeVersion 变化 → direct 同模型不复用（cache key 含版本指纹，避免复用旧凭据）', async () => {
        const caller = new LLMCaller()
        const directCfg = {provider: 'custom', model: 'deepseek-v3'} as any
        const first = await caller.getAdapter('main', undefined, directCfg, undefined, undefined, true)
        // 用户修改 provider API key/baseUrl → scheme 版本递增
        mockGetVersion.mockReturnValue({version: 2, updatedAt: 0})
        const second = await caller.getAdapter('main', undefined, directCfg, undefined, undefined, true)
        expect(second.adapter).not.toBe(first.adapter)
        const {createModelAdapter} = await import('../../../../src/main/agent/model/index')
        expect(createModelAdapter).toHaveBeenCalledTimes(2)
        expect(mockCreate).not.toHaveBeenCalled() // 仍是 direct 路径，不经 createAdapterForContext
    })

    it('D2: 同 provider:model 切换 apiStyle（chat→responses）不复用（cache key 含 apiStyle 指纹）', async () => {
        const caller = new LLMCaller()
        const cfgChat = {provider: 'custom', model: 'gpt-5', apiStyle: 'chat', baseUrl: 'https://api.x/v1'} as any
        const first = await caller.getAdapter('main', undefined, cfgChat, undefined, undefined, true)
        // auto 一轮（lastDirectKey 清空）→ 回 direct 同 provider:model 但 apiStyle 不同 → 必须新建
        await caller.getAdapter('main', 'primary', {provider: 'custom', model: 'gpt-4o'} as any)
        const cfgResponses = {provider: 'custom', model: 'gpt-5', apiStyle: 'responses', baseUrl: 'https://api.x/v1'} as any
        const second = await caller.getAdapter('main', undefined, cfgResponses, undefined, undefined, true)
        expect(second.adapter).not.toBe(first.adapter)
        const {createModelAdapter} = await import('../../../../src/main/agent/model/index')
        expect(createModelAdapter).toHaveBeenCalledTimes(2)
    })

    it('D2: 同 provider:model 切换 baseUrl（同类型 provider 端点碰撞）不复用（cache key 含 baseURL 指纹）', async () => {
        const caller = new LLMCaller()
        // 两个同为 custom 类型的 provider 暴露同模型 id（如 DeepSeek 与中转站都叫 deepseek-v3）
        const cfgDeepSeek = {provider: 'custom', model: 'deepseek-v3', baseUrl: 'https://api.deepseek.com/v1'} as any
        const first = await caller.getAdapter('main', undefined, cfgDeepSeek, undefined, undefined, true)
        await caller.getAdapter('main', 'primary', {provider: 'custom', model: 'gpt-4o'} as any)
        const cfgRelay = {provider: 'custom', model: 'deepseek-v3', baseUrl: 'https://relay.example.com/v1'} as any
        const second = await caller.getAdapter('main', undefined, cfgRelay, undefined, undefined, true)
        expect(second.adapter).not.toBe(first.adapter)
        const {createModelAdapter} = await import('../../../../src/main/agent/model/index')
        expect(createModelAdapter).toHaveBeenCalledTimes(2)
    })

    it('D2: direct→direct 切换 baseUrl(同 provider:model,无中间 auto 轮)触发重建', async () => {
        const caller = new LLMCaller()
        // finding 主场景：两个同类型 custom 端点同模型 id，用户 direct→direct 切 override 端点。
        // 旧实现 lastDirectKey 仅为 provider:model → needsRecreate=false → 早退复用旧端点 adapter，
        // 带指纹的 cache key 根本不被查询（当前实现 FAIL，修复后 PASS）。
        // 注意 baseURL（大写 U）字段名，须与 baseUrl 一并兼容。
        const cfgA = {provider: 'custom', model: 'deepseek-v3', baseURL: 'https://a.example.com'} as any
        const cfgB = {provider: 'custom', model: 'deepseek-v3', baseURL: 'https://b.example.com'} as any
        const first = await caller.getAdapter('main', undefined, cfgA, undefined, undefined, true)
        const second = await caller.getAdapter('main', undefined, cfgB, undefined, undefined, true)
        expect(second.adapter).not.toBe(first.adapter)
        const {createModelAdapter} = await import('../../../../src/main/agent/model/index')
        expect(createModelAdapter).toHaveBeenCalledTimes(2)
    })

    it('D2: direct→direct 同 baseUrl 复用（确认不误伤）', async () => {
        const caller = new LLMCaller()
        const cfgA = {provider: 'custom', model: 'deepseek-v3', baseURL: 'https://a.example.com'} as any
        const first = await caller.getAdapter('main', undefined, cfgA, undefined, undefined, true)
        const second = await caller.getAdapter('main', undefined, cfgA, undefined, undefined, true)
        expect(second.adapter).toBe(first.adapter)
        const {createModelAdapter} = await import('../../../../src/main/agent/model/index')
        expect(createModelAdapter).toHaveBeenCalledTimes(1)
    })
})
