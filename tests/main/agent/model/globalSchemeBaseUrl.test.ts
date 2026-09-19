/**
 * 全局方案路径 baseUrl / _providerName 透传回归测试
 *
 * 背景（缺陷 memo-4ffcb683 / ADR docs/adr/2026-09-baseurl-global-scheme-fix.md）：
 * createAdapterForRole 在全局方案路径构造 adapter config 时硬编码
 * `baseUrl: ''`，且 getClientForCurrentScheme 未回传 provider.name；
 * 导致 OpenAIAdapter 的 applyThinkingDisabled / stream_options / isOfficialOpenAIEndpoint
 * 等「按 baseUrl/providerName 判定服务商」的逻辑在全局路径全部失效。
 *
 * 修复：config.baseUrl 从注入的 client.baseURL 回退取值；_providerName 透传
 * getClientForCurrentScheme 返回的 providerName（= provider.name || provider.id）。
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'

vi.mock('../../../../src/main/agent/model/modelSchemeManager', () => ({
    getCurrentScheme: vi.fn(() => null),
    getCurrentSchemeId: vi.fn(() => 'scheme-1'),
    getSchemeVersion: vi.fn(() => ({version: 1, updatedAt: 0})),
    getClientForCurrentScheme: vi.fn(),
    hasSchemeChanged: vi.fn(() => false),
    setCurrentScheme: vi.fn(),
}))

vi.mock('../../../../src/main/agent/model/openaiAdapter', () => ({
    OpenAIAdapter: class {
        config: any
        client: any
        chat: any
        constructor(config: any, client?: any) {
            this.config = config
            this.client = client
            this.chat = vi.fn()
        }
    },
}))

import {createAdapterForContext, invalidateAdapterCache} from '../../../../src/main/agent/model/index'
import {getClientForCurrentScheme, getCurrentScheme} from '../../../../src/main/agent/model/modelSchemeManager'

const mockGetScheme = vi.mocked(getCurrentScheme)
const mockGetClient = vi.mocked(getClientForCurrentScheme)

const SCHEME = {
    id: 'scheme-1',
    name: '测试方案',
    enabled: true,
    roles: [
        {role: 'primary', enabled: true, endpointId: 'p1', modelId: 'primary-model-id'},
    ],
} as any

beforeEach(() => {
    vi.clearAllMocks()
    invalidateAdapterCache()
    mockGetScheme.mockReturnValue(SCHEME)
})

describe('全局方案路径：baseUrl 与 _providerName 透传', () => {
    it('V1：config.baseUrl 从注入 client.baseURL 回退取值（非空串）', async () => {
        mockGetClient.mockResolvedValue({
            client: {baseURL: 'https://openrouter.ai/api/v1'},
            providerType: 'custom',
            modelId: 'deepseek-v3',
            configSource: 'global-scheme',
            version: 1,
            apiStyle: 'chat',
            providerName: 'OpenRouter',
        } as any)

        const result = await createAdapterForContext('main')
        const cfg = (result.adapter as any).config

        // 修复前：硬编码 '' → applyThinkingDisabled/isOfficialOpenAIEndpoint 全部走官方分支
        expect(cfg.baseUrl).toBe('https://openrouter.ai/api/v1')
    })

    it('V1b：client.baseURL 缺失时退为空串（不抛错，保持向后兼容）', async () => {
        mockGetClient.mockResolvedValue({
            client: {},
            providerType: 'openai',
            modelId: 'gpt-5',
            configSource: 'global-scheme',
            version: 1,
            apiStyle: 'chat',
            providerName: 'OpenAI',
        } as any)

        const result = await createAdapterForContext('main')
        const cfg = (result.adapter as any).config

        // SDK 默认 api.openai.com → isOfficialOpenAIEndpoint 仍正确
        expect(cfg.baseUrl).toBe('')
    })

    it('V2：_providerName 透传 getClientForCurrentScheme 返回的 providerName', async () => {
        mockGetClient.mockResolvedValue({
            client: {baseURL: 'https://api.minimaxi.com/v1'},
            providerType: 'custom',
            modelId: 'MiniMax-Text-01',
            configSource: 'global-scheme',
            version: 1,
            apiStyle: 'chat',
            providerName: 'MiniMax',
        } as any)

        const result = await createAdapterForContext('main')
        const cfg = (result.adapter as any).config

        // 修复前：_providerName 缺失 → openaiAdapter 退化为 'openai' → MiniMax stream_options 误发
        expect(cfg._providerName).toBe('MiniMax')
    })

    it('V2b：providerName 缺失时 _providerName 为 undefined（不抛错，openaiAdapter 内回退 openai）', async () => {
        mockGetClient.mockResolvedValue({
            client: {baseURL: 'https://api.openai.com/v1'},
            providerType: 'openai',
            modelId: 'gpt-5',
            configSource: 'global-scheme',
            version: 1,
            apiStyle: 'chat',
        } as any)

        const result = await createAdapterForContext('main')
        const cfg = (result.adapter as any).config

        expect(cfg._providerName).toBeUndefined()
    })

    it('V3：baseUrl 与 _providerName 同源于同一 provider 实例（口径一致）', async () => {
        mockGetClient.mockResolvedValue({
            client: {baseURL: 'https://api.deepseek.com/v1'},
            providerType: 'custom',
            modelId: 'deepseek-chat',
            configSource: 'global-scheme',
            version: 1,
            apiStyle: 'chat',
            providerName: 'DeepSeek',
        } as any)

        const result = await createAdapterForContext('main')
        const cfg = (result.adapter as any).config

        expect(cfg.baseUrl).toBe('https://api.deepseek.com/v1')
        expect(cfg._providerName).toBe('DeepSeek')
    })
})
