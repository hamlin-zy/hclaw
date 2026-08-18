/**
 * modelSelector 单元测试
 *
 * 覆盖：
 * - selectModelForTask：roles 数组结构解析、planning/background 上下文、
 *   suggestedModel 优先、fallback 链式查找
 * - selectModelForTaskWithRole：返回实际角色、reasoning 配置不完整时 fallback、
 *   suggestedModel 即使未启用也使用、兜底选择
 * - complexityToRole：三档映射
 * - resolveModelConfig：provider/model 匹配、google-oauth2 token 处理、数据库兜底
 * - getExecutionModelConfig / shouldEnterPlanMode / selectModelForAgentType
 *
 * Mock 策略：
 * - SqliteProviderRepository 用 vi.mock 替换为内存 stub（getById），
 *   避免 modelSelector 顶层 `new SqliteProviderRepository()` 触碰真实 SQLite 数据库。
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'
import type {IntentAnalysisResult, LLMProvider, ModelRoleConfig, ModelScheme, ModelSchemeRole} from '@shared/types'

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
    complexityToRole,
    getExecutionModelConfig,
    getModelConfigForAgentType,
    resolveModelConfig,
    selectModelForAgentType,
    selectModelForTask,
    selectModelForTaskWithRole,
    shouldEnterPlanMode,
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

/** 构造带 suggestedModel 的 intent */
function makeIntent(partial: Partial<IntentAnalysisResult> = {}): IntentAnalysisResult {
    return {
        summary: 'test',
        complexity: 'moderate',
        estimatedSteps: 5,
        needsPlanning: false,
        suggestedModel: 'primary',
        ...partial,
    }
}

beforeEach(() => {
    mockGetById.mockReset()
    mockGetById.mockReturnValue(null)
})

// ─── selectModelForTask ─────────────────────────────────────────

describe('selectModelForTask', () => {
    it('新结构（roles 数组）→ 兼容解析返回 primary', () => {
        const result = selectModelForTask(makeRolesScheme(), 'main')
        expect(result.endpointId).toBe('prov-primary')
        expect(result.modelId).toBe('model-primary')
    })

    it('context=planning 且 reasoning 启用 → 返回 reasoning', () => {
        const scheme = makeRolesScheme({reasoning: {enabled: true}})
        const result = selectModelForTask(scheme, 'planning')
        expect(result.endpointId).toBe('prov-reason')
        expect(result.modelId).toBe('model-reason')
    })

    it('context=background 且 lightweight 启用 → 返回 lightweight', () => {
        const scheme = makeRolesScheme({lightweight: {enabled: true}})
        const result = selectModelForTask(scheme, 'background')
        expect(result.endpointId).toBe('prov-light')
        expect(result.modelId).toBe('model-light')
    })

    it('intent.suggestedModel=reasoning 且启用 → 返回 reasoning', () => {
        const scheme = makeRolesScheme({reasoning: {enabled: true}})
        const result = selectModelForTask(scheme, 'main', makeIntent({suggestedModel: 'reasoning'}))
        expect(result.endpointId).toBe('prov-reason')
        expect(result.modelId).toBe('model-reason')
    })

    it('fallback：background 无 lightweight → 回退 primary', () => {
        const scheme = makeRolesScheme({lightweight: {enabled: false}})
        const result = selectModelForTask(scheme, 'background')
        expect(result.endpointId).toBe('prov-primary')
    })

    it('reasoning 未启用时 planning → 回退 primary', () => {
        const scheme = makeRolesScheme({reasoning: {enabled: false}})
        const result = selectModelForTask(scheme, 'planning')
        expect(result.endpointId).toBe('prov-primary')
    })
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

    it('suggestedModel 配置完整时即使角色未启用也使用该角色', () => {
        const scheme = makeRolesScheme({reasoning: {enabled: false}})
        const result = selectModelForTaskWithRole(scheme, 'main', {suggestedModel: 'reasoning'})
        expect(result.role).toBe('reasoning')
        expect(result.config.endpointId).toBe('prov-reason')
        expect(result.config.enabled).toBe(false)
    })

    it('兜底：所有角色都未启用 → 返回第一个可用角色（role 标记 primary）', () => {
        const allDisabled = makeRolesScheme({
            primary: {enabled: false},
            lightweight: {enabled: false},
            reasoning: {enabled: false},
        })
        const result = selectModelForTaskWithRole(allDisabled, 'main')
        expect(result.role).toBe('primary')
        expect(result.config.endpointId).toBe('prov-primary')
    })

    it('兜底：存在启用角色时选择第一个启用的角色', () => {
        const scheme = makeRolesScheme({
            primary: {enabled: false},
            lightweight: {enabled: true},
        })
        const result = selectModelForTaskWithRole(scheme, 'main')
        expect(result.role).toBe('primary')
        expect(result.config.endpointId).toBe('prov-light')
        expect(result.config.modelId).toBe('model-light')
    })
})

// ─── complexityToRole ────────────────────────────────────────────

describe('complexityToRole', () => {
    it('simple → lightweight', () => {
        expect(complexityToRole('simple')).toBe('lightweight')
    })

    it('complex → reasoning', () => {
        expect(complexityToRole('complex')).toBe('reasoning')
    })

    it('moderate → primary', () => {
        expect(complexityToRole('moderate')).toBe('primary')
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
})

// ─── getExecutionModelConfig / shouldEnterPlanMode / selectModelForAgentType ──

describe('getExecutionModelConfig', () => {
    it('成功路径：解析 primary 配置', () => {
        const providers = [makeProvider({
            id: 'prov-primary',
            name: 'Primary Provider',
            type: 'anthropic',
            models: [{id: 'model-primary', name: 'claude-model', enabled: true}],
        })]
        const result = getExecutionModelConfig(makeRolesScheme(), 'main', undefined, providers)
        expect(result).not.toBeNull()
        expect(result!.roleConfig.endpointId).toBe('prov-primary')
        expect(result!.roleConfig.modelId).toBe('model-primary')
        expect(result!.modelConfig.apiKey).toBe('sk-abc')
    })

    it('provider 缺失 → 返回 null', () => {
        expect(getExecutionModelConfig(makeRolesScheme(), 'main', undefined, [])).toBeNull()
    })
})

describe('shouldEnterPlanMode', () => {
    it('needsPlanning=true → true', () => {
        expect(shouldEnterPlanMode(makeIntent({needsPlanning: true}))).toBe(true)
    })

    it('complexity=complex → true', () => {
        expect(shouldEnterPlanMode(makeIntent({complexity: 'complex'}))).toBe(true)
    })

    it('无 intent → false', () => {
        expect(shouldEnterPlanMode(undefined)).toBe(false)
    })

    it('普通 intent → false', () => {
        expect(shouldEnterPlanMode(makeIntent())).toBe(false)
    })
})

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
