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
    // 全局路径返回的 provider:model 反映 fallbackConfig（模拟角色路由到不同模型时指纹变化）
    createAdapterForContext: vi.fn(async (_context: string, fallbackConfig?: any) => ({
        adapter: {chat: vi.fn()},
        providerType: fallbackConfig?.provider ?? 'mock',
        modelId: fallbackConfig?.model ?? 'mock-model',
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

describe('LLMCaller.getAdapter (adapter 管理收归 + schemeVersion/provider:model/direct 变化重建)', () => {
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
        await caller.getAdapter('main', undefined, undefined, controller.signal)
        const callArgs = mockCreate.mock.calls[0]
        expect(callArgs[0]).toBe('main')
        // createAdapterForContext only accepts 2 args (context, fallbackConfig?)
        expect(callArgs.length).toBeLessThanOrEqual(2)
    })

    it('F1替代: provider:model 变化触发重建', async () => {
        const caller = new LLMCaller()
        const first = await caller.getAdapter('main')
        expect(first.adapter).toBeDefined()
        // 模拟角色路由到不同模型：通过 fallbackConfig 切换 provider:model
        const second = await caller.getAdapter('main', {provider: 'openai', model: 'gpt-5', apiKey: 'sk'} as any)
        expect(second.adapter).toBeDefined()
        expect(second.adapter).not.toBe(first.adapter) // 重建
    })

    it('F2: after global path fails to fallback, next call retrieves global path (state synced)', async () => {
        const caller = new LLMCaller()
        const globalConfig = {provider: 'openai', model: 'gpt-4o', apiKey: 'sk'} as any
        // 与上一次不同的 provider:model —— 必须强制重建才能进入 global 路径并消费 mockRejectedValueOnce；
        // 若复用相同 config，needsAdapterRecreate 判定 false → 直接复用旧 adapter → fallback 路径永不触发，
        // mockRejectedValueOnce 泄漏到后续用例（D1 direct↔auto 的 auto 调用会吞掉并打印 global scheme unavailable）。
        const switchConfig = {provider: 'openai', model: 'gpt-5', apiKey: 'sk'} as any
        // ① 首次 global 路径成功
        const first = await caller.getAdapter('main', globalConfig)
        expect(first.configSource).toBe('global-scheme')
        expect(first.modelId).toBe('gpt-4o')
        expect(mockCreate).toHaveBeenCalledTimes(1)
        // ② 模型切换 → 重建进入 global 路径，但 global 失败 → fallback（指纹同步为 switch 配置）
        mockCreate.mockRejectedValueOnce(new Error('global scheme unavailable'))
        const second = await caller.getAdapter('main', switchConfig)
        expect(second.configSource).toBe('fallback')
        expect(second.modelId).toBe('gpt-5')
        const {createModelAdapter} = await import('../../../../src/main/agent/model/index')
        expect(createModelAdapter).toHaveBeenCalledTimes(1)
        // ③ 切回原模型 → 重建 → global 路径恢复（不被 fallback 钉死；状态同步生效）
        const third = await caller.getAdapter('main', globalConfig)
        expect(third.configSource).toBe('global-scheme')
        expect(third.modelId).toBe('gpt-4o')
        expect(mockCreate).toHaveBeenCalledTimes(3)
        expect(createModelAdapter).toHaveBeenCalledTimes(1) // 第三次不再走 fallback
    })

    it('D1: directModel 同模型连续调用复用 adapter，不重建（缓存增量）', async () => {
        const caller = new LLMCaller()
        const directCfg = {provider: 'custom', model: 'deepseek-v3'} as any
        const first = await caller.getAdapter('main', directCfg, undefined, undefined, true)
        const second = await caller.getAdapter('main', directCfg, undefined, undefined, true)
        expect(second.adapter).toBe(first.adapter)
        expect(mockCreate).not.toHaveBeenCalled() // direct 路径不经过 createAdapterForContext
    })

    it('D1: directModel 切换模型（v3→gpt-5）触发重建', async () => {
        const caller = new LLMCaller()
        const first = await caller.getAdapter('main', {provider: 'custom', model: 'deepseek-v3'} as any, undefined, undefined, true)
        const second = await caller.getAdapter('main', {provider: 'custom', model: 'gpt-5'} as any, undefined, undefined, true)
        expect(second.adapter).not.toBe(first.adapter)
    })

    it('D1: direct ↔ auto 切换触发重建', async () => {
        const caller = new LLMCaller()
        const directCfg = {provider: 'custom', model: 'deepseek-v3'} as any
        const first = await caller.getAdapter('main', directCfg, undefined, undefined, true)
        const second = await caller.getAdapter('main', {provider: 'custom', model: 'gpt-4o'} as any)
        expect(second.adapter).not.toBe(first.adapter)
        // 回到 direct 同模型 → 复用
        const third = await caller.getAdapter('main', directCfg, undefined, undefined, true)
        expect(third.adapter).toBe(first.adapter)
    })

    it('D2: schemeVersion 变化 → direct 同模型不复用（cache key 含版本指纹，避免复用旧凭据）', async () => {
        const caller = new LLMCaller()
        const directCfg = {provider: 'custom', model: 'deepseek-v3'} as any
        const first = await caller.getAdapter('main', directCfg, undefined, undefined, true)
        // 用户修改 provider API key/baseUrl → scheme 版本递增
        mockGetVersion.mockReturnValue({version: 2, updatedAt: 0})
        const second = await caller.getAdapter('main', directCfg, undefined, undefined, true)
        expect(second.adapter).not.toBe(first.adapter)
        const {createModelAdapter} = await import('../../../../src/main/agent/model/index')
        expect(createModelAdapter).toHaveBeenCalledTimes(2)
        expect(mockCreate).not.toHaveBeenCalled() // 仍是 direct 路径，不经 createAdapterForContext
    })

    it('D2: 同 provider:model 切换 apiStyle（chat→responses）不复用（cache key 含 apiStyle 指纹）', async () => {
        const caller = new LLMCaller()
        const cfgChat = {provider: 'custom', model: 'gpt-5', apiStyle: 'chat', baseUrl: 'https://api.x/v1'} as any
        const first = await caller.getAdapter('main', cfgChat, undefined, undefined, true)
        // auto 一轮（lastDirectKey 清空）→ 回 direct 同 provider:model 但 apiStyle 不同 → 必须新建
        await caller.getAdapter('main', {provider: 'custom', model: 'gpt-4o'} as any)
        const cfgResponses = {provider: 'custom', model: 'gpt-5', apiStyle: 'responses', baseUrl: 'https://api.x/v1'} as any
        const second = await caller.getAdapter('main', cfgResponses, undefined, undefined, true)
        expect(second.adapter).not.toBe(first.adapter)
        const {createModelAdapter} = await import('../../../../src/main/agent/model/index')
        expect(createModelAdapter).toHaveBeenCalledTimes(2)
    })

    it('D2: 同 provider:model 切换 baseUrl（同类型 provider 端点碰撞）不复用（cache key 含 baseURL 指纹）', async () => {
        const caller = new LLMCaller()
        // 两个同为 custom 类型的 provider 暴露同模型 id（如 DeepSeek 与中转站都叫 deepseek-v3）
        const cfgDeepSeek = {provider: 'custom', model: 'deepseek-v3', baseUrl: 'https://api.deepseek.com/v1'} as any
        const first = await caller.getAdapter('main', cfgDeepSeek, undefined, undefined, true)
        await caller.getAdapter('main', {provider: 'custom', model: 'gpt-4o'} as any)
        const cfgRelay = {provider: 'custom', model: 'deepseek-v3', baseUrl: 'https://relay.example.com/v1'} as any
        const second = await caller.getAdapter('main', cfgRelay, undefined, undefined, true)
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
        const first = await caller.getAdapter('main', cfgA, undefined, undefined, true)
        const second = await caller.getAdapter('main', cfgB, undefined, undefined, true)
        expect(second.adapter).not.toBe(first.adapter)
        const {createModelAdapter} = await import('../../../../src/main/agent/model/index')
        expect(createModelAdapter).toHaveBeenCalledTimes(2)
    })

    it('D2: direct→direct 同 baseUrl 复用（确认不误伤）', async () => {
        const caller = new LLMCaller()
        const cfgA = {provider: 'custom', model: 'deepseek-v3', baseURL: 'https://a.example.com'} as any
        const first = await caller.getAdapter('main', cfgA, undefined, undefined, true)
        const second = await caller.getAdapter('main', cfgA, undefined, undefined, true)
        expect(second.adapter).toBe(first.adapter)
        const {createModelAdapter} = await import('../../../../src/main/agent/model/index')
        expect(createModelAdapter).toHaveBeenCalledTimes(1)
    })
})
