/**
 * createAdapterForContext 角色透传 回归测试
 *
 * 背景：子 Agent（agentTool）经 modelRole 指定 lightweight/reasoning 时，
 * selectModelForTurn 已正确解析角色模型，但 createAdapterForContext 内部
 * 按 context='main' 重新解析角色 → 恒选 primary → 子会话实际运行 primary
 * （与 agent_start 显示 / llm_usage 落库的 lightweight 不一致）。
 *
 * 修复：createAdapterForContext 接收 preferredRole（selectModelForTurn 的
 * suggestedRole 产物），角色有效时以其解析客户端，不再被 context 覆盖。
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'

// ── mock 依赖：隔离 scheme 客户端与 adapter 构造，聚焦角色透传 ──
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
        chat: any
        constructor(config: any) {
            this.config = config
            this.chat = vi.fn()
        }
    },
}))

import {createAdapterForContext, invalidateAdapterCache} from '../../../../src/main/agent/model/index'
import {getClientForCurrentScheme, getCurrentScheme} from '../../../../src/main/agent/model/modelSchemeManager'

const mockGetScheme = vi.mocked(getCurrentScheme)
const mockGetClient = vi.mocked(getClientForCurrentScheme)

/** primary + lightweight 均启用配置的方案 */
const SCHEME = {
    id: 'scheme-1',
    name: '测试方案',
    enabled: true,
    roles: [
        {role: 'primary', enabled: true, endpointId: 'p1', modelId: 'primary-model-id'},
        {role: 'lightweight', enabled: true, endpointId: 'p2', modelId: 'light-model-id'},
        {role: 'reasoning', enabled: false, endpointId: '', modelId: ''},
    ],
} as any

const LIGHTWEIGHT_CONFIG = {
    provider: 'custom',
    model: 'light-model',
    apiKey: 'sk-light',
    _providerName: '轻量服务商',
} as any

beforeEach(() => {
    vi.clearAllMocks()
    invalidateAdapterCache()
    mockGetScheme.mockReturnValue(SCHEME)
    // 按 role 返回不同 modelId：断言 createAdapterForContext 是否透传了正确角色
    mockGetClient.mockImplementation(async (role: string) => ({
        client: {provider: role},
        providerType: 'custom',
        modelId: role === 'lightweight' ? 'light-model' : 'primary-model',
        configSource: 'global-scheme',
        version: 1,
        apiStyle: 'chat',
    }))
})

describe('createAdapterForContext — preferredRole 透传（子 Agent modelRole 生效）', () => {
    it('preferredRole=lightweight 时以 lightweight 角色解析客户端（而非 context 覆盖为 primary）', async () => {
        const result = await createAdapterForContext('main', LIGHTWEIGHT_CONFIG, 'lightweight')

        // 修复前：selectModelForTaskWithRole(scheme, 'main') → 恒 primary → 断言失败
        expect(mockGetClient).toHaveBeenCalledWith('lightweight')
        expect(result.modelId).toBe('light-model')
        expect(result.role).toBe('lightweight')
    })

    it('preferredRole=primary 时以 primary 角色解析（默认行为保持）', async () => {
        const result = await createAdapterForContext('main', undefined, 'primary')

        expect(mockGetClient).toHaveBeenCalledWith('primary')
        expect(result.modelId).toBe('primary-model')
        expect(result.role).toBe('primary')
    })

    it('preferredRole 未启用/未配置 → 降级按 context 路由（primary）', async () => {
        const result = await createAdapterForContext('main', undefined, 'reasoning')

        // reasoning 未启用 → 走 selectModelForTaskWithRole(scheme, 'main') → primary
        expect(mockGetClient).toHaveBeenCalledWith('primary')
        expect(result.role).toBe('primary')
    })

    it('无 preferredRole → 保持按 context 路由（main → primary）', async () => {
        const result = await createAdapterForContext('main')

        expect(mockGetClient).toHaveBeenCalledWith('primary')
        expect(result.role).toBe('primary')
    })
})
