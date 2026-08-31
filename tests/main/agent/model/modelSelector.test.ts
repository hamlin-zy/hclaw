/**
 * modelSelector 单元测试
 *
 * 覆盖：
 * - selectModelForTaskWithRole：planning/background 上下文、suggestedModel 校验、
 *   fallback 链（endpointId/modelId 校验）+ throw
 * - resolveModelConfig：provider/model 匹配、google-oauth2 token 处理、数据库兜底
 * - selectModelForAgentType / getModelConfigForAgentType
 *
 * Mock 策略：
 * - SqliteProviderRepository 用 vi.mock 替换为内存 stub（getById），
 *   避免 modelSelector 顶层 `new SqliteProviderRepository()` 触碰真实 SQLite 数据库。
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'
import type {LLMProvider, ModelRoleConfig, ModelScheme, ModelSchemeRole} from '@shared/types'

// ─── hoisted mock 状态（必须在 vi.mock 之前提升）────────────────

const {mockGetById} = vi.hoisted(() => ({
    mockGetById: vi.fn(),
}))

// modelSelector 顶层 `const providerRepo = new SqliteProviderRepository()`，
// 替换为内存 stub，避免真实连库。
// 注意：mock 必须用 function 而非箭头函数，否则无法被 `new`。
vi.mock('@/main/repositories/sqlite/llmProviderRepository', () => ({
    SqliteProviderRepository: vi.fn(function () {
        return {getById: mockGetById}
    }),
}))

// ─── 被测模块 ─────────────────────────────────────────────────

import {
    getModelConfigForAgentType,
    resolveModelConfig,
    selectModelForAgentType,
    selectModelForTaskWithRole,
} from '@/main/agent/model/modelSelector'

// ─── 测试数据工具 ───────────────────────────────────────────────

type RoleKey = 'primary' | 'lightweight' | 'reasoning'
type RoleOverrides = Partial<Record<RoleKey, Partial<ModelRoleConfig>>>

const DEFAULT_ROLES: Record<RoleKey, ModelRoleConfig> = {
    primary: {endpointId: 'prov-primary', modelId: 'model-primary', enabled: true},
    lightweight: {endpointId: 'prov-light', modelId: 'model-light', enabled: false},
    reasoning: {endpointId: 'prov-reason', modelId: 'model-reason', enabled: false},
}

/** 构造 roles 数组结构 scheme */
function makeRolesScheme(overrides: RoleOverrides = {}): ModelScheme {
    const roles = (['primary', 'lightweight', 'reasoning'] as RoleKey[]).map((role): ModelSchemeRole => ({
        id: `id-${role}`,
        role,
        modelType: 'text',
        ...DEFAULT_ROLES[role],
        ...(overrides[role] ?? {}),
    }))
    return {id: 'scheme-1', name: 'test-scheme', enabled: true, roles}
}

/** 构造 LLMProvider */
function makeProvider(overrides: Partial<LLMProvider> = {}): LLMProvider {
    return {
        id: 'prov-a',
        name: 'Provider A',
        type: 'anthropic',
        authType: 'api-key',
        apiKey: 'sk-abc',
        baseUrl: 'https://api.example.com',
        enabled: true,
        models: [{id: 'model-a', name: 'claude-model', enabled: true}],
        ...overrides,
    }
}

beforeEach(() => {
    mockGetById.mockReset()
    mockGetById.mockReturnValue(null)
})

// ─── selectModelForTaskWithRole ──────────────────────────────────

describe('selectModelForTaskWithRole', () => {
    it('planning + reasoning 配置完整 → {config: reasoning, role: reasoning}', () => {
        const scheme = makeRolesScheme({reasoning: {enabled: true}})
        const result = selectModelForTaskWithRole(scheme, 'planning')
        expect(result.role).toBe('reasoning')
        expect(result.config.endpointId).toBe('prov-reason')
        expect(result.config.modelId).toBe('model-reason')
    })

    it('reasoning 缺 endpointId → fallback primary（role: primary）', () => {
        const scheme = makeRolesScheme({reasoning: {enabled: true, endpointId: ''}})
        const result = selectModelForTaskWithRole(scheme, 'planning')
        expect(result.role).toBe('primary')
        expect(result.config.endpointId).toBe('prov-primary')
        expect(result.config.modelId).toBe('model-primary')
    })

    it('suggestedModel 角色未启用 → 不再使用，fallback primary', () => {
        const scheme = makeRolesScheme({reasoning: {enabled: false}})
        const result = selectModelForTaskWithRole(scheme, 'main', {suggestedModel: 'reasoning'})
        expect(result.role).toBe('primary')
        expect(result.config.endpointId).toBe('prov-primary')
    })

    // ── 按起始角色的降级链：L→P→R / P→L→R / R→P→L ──

    it('suggestedModel=lightweight 未启用 → 升级 primary（L→P）', () => {
        const scheme = makeRolesScheme({lightweight: {enabled: true, endpointId: ''}})
        const result = selectModelForTaskWithRole(scheme, 'main', {suggestedModel: 'lightweight'})
        expect(result.role).toBe('primary')
        expect(result.config.endpointId).toBe('prov-primary')
    })

    it('suggestedModel=lightweight + primary 均无效 → 升级 reasoning（L→P→R）', () => {
        const scheme = makeRolesScheme({
            lightweight: {enabled: true, endpointId: ''},
            primary: {enabled: true, endpointId: ''},
            reasoning: {enabled: true},
        })
        const result = selectModelForTaskWithRole(scheme, 'main', {suggestedModel: 'lightweight'})
        expect(result.role).toBe('reasoning')
        expect(result.config.endpointId).toBe('prov-reason')
    })

    it('suggestedModel=reasoning 未启用 → 降级 primary（R→P）', () => {
        const scheme = makeRolesScheme({reasoning: {enabled: true, endpointId: ''}})
        const result = selectModelForTaskWithRole(scheme, 'main', {suggestedModel: 'reasoning'})
        expect(result.role).toBe('primary')
        expect(result.config.endpointId).toBe('prov-primary')
    })

    it('suggestedModel=reasoning + primary 均无效 → 降级 lightweight（R→P→L）', () => {
        const scheme = makeRolesScheme({
            reasoning: {enabled: true, endpointId: ''},
            primary: {enabled: true, endpointId: ''},
            lightweight: {enabled: true},
        })
        const result = selectModelForTaskWithRole(scheme, 'main', {suggestedModel: 'reasoning'})
        expect(result.role).toBe('lightweight')
        expect(result.config.endpointId).toBe('prov-light')
    })

    it('suggestedModel=primary 未启用 → 降级 lightweight（P→L）', () => {
        const scheme = makeRolesScheme({primary: {enabled: true, endpointId: ''}, lightweight: {enabled: true}})
        const result = selectModelForTaskWithRole(scheme, 'main', {suggestedModel: 'primary'})
        expect(result.role).toBe('lightweight')
        expect(result.config.endpointId).toBe('prov-light')
    })

    it('suggestedModel=primary + lightweight 均无效 → 升级 reasoning（P→L→R）', () => {
        const scheme = makeRolesScheme({
            primary: {enabled: true, endpointId: ''},
            lightweight: {enabled: true, endpointId: ''},
            reasoning: {enabled: true},
        })
        const result = selectModelForTaskWithRole(scheme, 'main', {suggestedModel: 'primary'})
        expect(result.role).toBe('reasoning')
        expect(result.config.endpointId).toBe('prov-reason')
    })

    it('兜底：所有角色都未启用 → throw No valid model role configured', () => {
        const allDisabled = makeRolesScheme({
            primary: {enabled: false},
            lightweight: {enabled: false},
            reasoning: {enabled: false},
        })
        expect(() => selectModelForTaskWithRole(allDisabled, 'main')).toThrow('No valid model role configured')
    })

    // role 标注实际选中的角色（原实现恒标 primary，修复后按实际角色标注）
    it('兜底：primary 未配置但 lightweight 有效 → 选 lightweight（role 标注 lightweight）', () => {
        const scheme = makeRolesScheme({
            primary: {enabled: true, endpointId: ''},  // 未配置
            lightweight: {enabled: true},
        })
        const result = selectModelForTaskWithRole(scheme, 'main')
        expect(result.role).toBe('lightweight')
        expect(result.config.endpointId).toBe('prov-light')
        expect(result.config.modelId).toBe('model-light')
    })

    it('兜底：primary→lightweight→reasoning 顺序 + 全部无效时 throw', () => {
        const scheme = makeRolesScheme({
            primary: {enabled: true, endpointId: ''},
            lightweight: {enabled: true, endpointId: ''},
            reasoning: {enabled: true, endpointId: ''},
        })
        expect(() => selectModelForTaskWithRole(scheme, 'main')).toThrow('No valid model role configured')
    })
})

// ─── resolveModelConfig ──────────────────────────────────────────

describe('resolveModelConfig', () => {
    const roleConfig: ModelRoleConfig = {endpointId: 'prov-a', modelId: 'model-a', enabled: true}

    it('provider 与 model 都存在 → 返回完整 ModelConfig', () => {
        const result = resolveModelConfig(roleConfig, [makeProvider()])
        expect(result).toMatchObject({
            provider: 'anthropic',
            model: 'claude-model',
            apiKey: 'sk-abc',
            authType: 'api-key',
            baseUrl: 'https://api.example.com',
            _providerName: 'Provider A',
        })
        expect(result!.thinkingEffort).toBeUndefined()
    })

    it('provider 不存在 → null', () => {
        expect(resolveModelConfig(roleConfig, [])).toBeNull()
    })

    it('model 不存在 → null', () => {
        const providers = [makeProvider({models: [{id: 'other', name: 'other', enabled: true}]})]
        expect(resolveModelConfig(roleConfig, providers)).toBeNull()
    })

    it('google-oauth2 + credentials.accessToken → 使用 accessToken', () => {
        const providers = [makeProvider({
            id: 'prov-g',
            type: 'google',
            authType: 'google-oauth2',
            apiKey: undefined,
            credentials: {accessToken: 'oauth-access'},
            models: [{id: 'model-g', name: 'gemini', enabled: true}],
        })]
        const result = resolveModelConfig({endpointId: 'prov-g', modelId: 'model-g', enabled: true}, providers)
        expect(result!.apiKey).toBe('oauth-access')
        expect(mockGetById).not.toHaveBeenCalled()
    })

    it('google-oauth2 无 accessToken → 从数据库兜底读取', () => {
        const providers = [makeProvider({
            id: 'prov-g2',
            type: 'google',
            authType: 'google-oauth2',
            apiKey: undefined,
            credentials: {},
            models: [{id: 'model-g', name: 'gemini', enabled: true}],
        })]
        mockGetById.mockReturnValue({credentials: {accessToken: 'db-token'}})
        const result = resolveModelConfig({endpointId: 'prov-g2', modelId: 'model-g', enabled: true}, providers)
        expect(result!.apiKey).toBe('db-token')
        expect(mockGetById).toHaveBeenCalledWith('prov-g2')
    })

    it('普通 provider（api-key）→ 使用 apiKey', () => {
        const result = resolveModelConfig(roleConfig, [makeProvider()])
        expect(result!.apiKey).toBe('sk-abc')
        expect(mockGetById).not.toHaveBeenCalled()
    })

    it('透传 features.supportsExplicitCaching 到 ModelConfig', () => {
        const providers = [makeProvider({
            id: 'prov-openrouter',
            name: 'OpenRouter',
            type: 'openai',
            features: {supportsExplicitCaching: true},
            models: [{id: 'model-or', name: 'openrouter-model', enabled: true}],
        })]
        const result = resolveModelConfig({endpointId: 'prov-openrouter', modelId: 'model-or', enabled: true}, providers)
        expect(result).not.toBeNull()
        expect(result!.features).toEqual({supportsExplicitCaching: true})
    })

    it('features 为 undefined 时 ModelConfig.features 为 undefined', () => {
        const providers = [makeProvider({
            id: 'prov-no-features',
            name: 'No Features',
            type: 'openai',
            features: undefined,
            models: [{id: 'model-nf', name: 'no-features-model', enabled: true}],
        })]
        const result = resolveModelConfig({endpointId: 'prov-no-features', modelId: 'model-nf', enabled: true}, providers)
        expect(result).not.toBeNull()
        expect(result!.features).toBeUndefined()
    })

    it('features 为空对象时 ModelConfig.features 为空对象', () => {
        const providers = [makeProvider({
            id: 'prov-empty-features',
            name: 'Empty Features',
            type: 'openai',
            features: {},
            models: [{id: 'model-ef', name: 'empty-features-model', enabled: true}],
        })]
        const result = resolveModelConfig({endpointId: 'prov-empty-features', modelId: 'model-ef', enabled: true}, providers)
        expect(result).not.toBeNull()
        expect(result!.features).toEqual({})
    })
})

// ─── selectModelForAgentType / getModelConfigForAgentType ────────

describe('selectModelForAgentType / getModelConfigForAgentType', () => {
    it('Explore（lightweight 启用）→ 返回 lightweight', () => {
        const scheme = makeRolesScheme({lightweight: {enabled: true}})
        const result = selectModelForAgentType(scheme, 'Explore')
        expect(result.endpointId).toBe('prov-light')
        expect(result.modelId).toBe('model-light')
    })

    it('Verification（inherit）→ 返回 primary', () => {
        const result = selectModelForAgentType(makeRolesScheme(), 'Verification')
        expect(result.endpointId).toBe('prov-primary')
        expect(result.modelId).toBe('model-primary')
    })

    it('Explore lightweight 未启用 → fallback primary', () => {
        const result = selectModelForAgentType(makeRolesScheme(), 'Explore')
        expect(result.endpointId).toBe('prov-primary')
        expect(result.modelId).toBe('model-primary')
    })

    it('getModelConfigForAgentType 成功路径', () => {
        const scheme = makeRolesScheme({lightweight: {enabled: true}})
        const providers = [makeProvider({
            id: 'prov-light',
            name: 'Light Provider',
            type: 'openai',
            models: [{id: 'model-light', name: 'gpt-4o', enabled: true}],
        })]
        const result = getModelConfigForAgentType(scheme, 'Explore', providers)
        expect(result).not.toBeNull()
        expect(result!.roleConfig.endpointId).toBe('prov-light')
        expect(result!.modelConfig.model).toBe('gpt-4o')
    })
})
