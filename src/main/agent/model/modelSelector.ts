/**
 * 模型选择器
 *
 * 根据意图分析结果、Agent 类型和当前方案配置，选择合适的模型执行任务。
 */

import {logger} from '../logger'
import type {
    IntentAnalysisResult,
    LLMProvider,
    ModelConfig,
    ModelRole,
    ModelRoleConfig,
    ModelScheme
} from '@shared/types'
import {getRoleConfig} from '@shared/modelSchemeHelpers'
import {getAgentTypeConfig} from '../agentTypes/configs'
import {SqliteProviderRepository} from '../../repositories/sqlite/llmProviderRepository'

const providerRepo = new SqliteProviderRepository()

export type TaskContext = 'main' | 'subAgent' | 'background' | 'planning'

/** 从 scheme 中获取角色配置（兼容新旧两种结构） */
function getRoleFromScheme(scheme: any, roleName: string): ModelRoleConfig | undefined {
    if (Array.isArray(scheme.roles)) {
        const roleObj = scheme.roles.find((r: any) => r.role === roleName)
        return roleObj ? {
            endpointId: roleObj.endpointId,
            modelId: roleObj.modelId,
            enabled: roleObj.enabled,
            thinkingEffort: roleObj.thinkingEffort,
        } : undefined
    }
    return scheme[roleName]
}

/** 获取优先角色配置（fallback 链式查找） */
function getPreferredRole(scheme: any, context: TaskContext, intent?: IntentAnalysisResult): ModelRoleConfig {
    const primary = getRoleFromScheme(scheme, 'primary')
    const lightweight = getRoleFromScheme(scheme, 'lightweight')
    const reasoning = getRoleFromScheme(scheme, 'reasoning')

    if (context === 'planning') return reasoning?.enabled ? reasoning : (primary ?? lightweight!)
    if (context === 'background') return lightweight?.enabled ? lightweight : (primary ?? reasoning!)

    if (intent?.suggestedModel) {
        const roleConfig = getRoleFromScheme(scheme, intent.suggestedModel)
        if (roleConfig?.enabled) return roleConfig
    }

    return primary ?? lightweight!
}

/**
 * 为任务选择模型配置
 * 支持新旧两种 scheme 结构
 */
export function selectModelForTask(
    scheme: any,
    context: TaskContext,
    intent?: IntentAnalysisResult,
): ModelRoleConfig {
    return getPreferredRole(scheme, context, intent)
}

/**
 * 复杂度到模型角色的映射
 */
export function complexityToRole(
    complexity: 'simple' | 'moderate' | 'complex',
): ModelRole {
    switch (complexity) {
        case 'simple':
            return 'lightweight'
        case 'complex':
            return 'reasoning'
        default:
            return 'primary'
    }
}

/**
 * selectModelForTask 的返回值，包含实际选择的角色信息
 */
export interface ModelSelectionResult {
    config: ModelRoleConfig
    role: ModelRole
}

/**
 * 为任务选择模型配置，并返回实际选择的角色
 *
 * 与 selectModelForTask 的区别：
 * - 返回实际选中的角色名称（而非仅配置），让调用方能检测 fallback
 */
export function selectModelForTaskWithRole(
    scheme: any,
    context: TaskContext,
    intent?: Partial<IntentAnalysisResult> & { suggestedModel?: ModelRole },
): ModelSelectionResult {
    const primary = getRoleFromScheme(scheme, 'primary')
    const lightweight = getRoleFromScheme(scheme, 'lightweight')
    const reasoning = getRoleFromScheme(scheme, 'reasoning')

    if (context === 'planning') {
        if (reasoning?.enabled && reasoning.endpointId && reasoning.modelId) return {config: reasoning, role: 'reasoning'}
        return {config: (primary ?? lightweight!), role: 'primary'}
    }

    if (context === 'background') {
        if (lightweight?.enabled) return {config: lightweight, role: 'lightweight'}
        return {config: (primary ?? reasoning!), role: 'primary'}
    }

    if (intent?.suggestedModel) {
        const roleConfig = getRoleFromScheme(scheme, intent.suggestedModel)
        // 当 suggestedModel 由用户通过工作模式显式选择时，即使角色未启用也使用该角色
        // 只有角色缺少 endpointId 或 modelId（未配置）时才 fallback
        if (roleConfig?.endpointId && roleConfig.modelId) return {config: roleConfig, role: intent.suggestedModel}
    }

    // 兜底：使用第一个已启用的角色
    const enabledFallback = [primary, lightweight, reasoning].find(r => r?.enabled)
    return {config: enabledFallback ?? primary ?? lightweight ?? reasoning!, role: 'primary'}
}

/**
 * 将 ModelRoleConfig 转换为 ModelConfig（用于 agentLoop）
 */
export function resolveModelConfig(
    roleConfig: ModelRoleConfig,
    providers: LLMProvider[],
): ModelConfig | null {
    const provider = providers.find((p) => p.id === roleConfig.endpointId)
    if (!provider) {
        return null
    }

    const model = provider.models.find((m) => m.id === roleConfig.modelId)
    if (!model) {
        return null
    }

    // OAuth2 模式下，token 存储在 credentials.accessToken 而非 apiKey
    let resolvedApiKey = provider.authType === 'google-oauth2'
        ? (provider.credentials?.accessToken || provider.apiKey)
        : provider.apiKey

    // 兜底：如果 apiKey 仍为空，直接从数据库读取完整 provider
    if (!resolvedApiKey && provider.authType === 'google-oauth2') {
        try {
            const fullProvider = providerRepo.getById(provider.id)
            if (fullProvider?.credentials?.accessToken) {
                resolvedApiKey = fullProvider.credentials.accessToken
            }
        } catch (err) {
            logger.warn(`[modelSelector] 数据库读取 provider 失败`, {error: err, name: provider.name})
        }
    }

    const resolved: ModelConfig = {
        provider: provider.type,
        model: model.name,
        apiKey: resolvedApiKey,
        baseUrl: provider.baseUrl,
        authType: provider.authType,
        projectId: provider.projectId,
        // 保存 provider 名称用于日志显示
        _providerName: provider.name || provider.id,
    }

    // 同步推理强度
    resolved.thinkingEffort = roleConfig.thinkingEffort || undefined

    return resolved
}

/**
 * 解析模型配置，失败时回退到 primary
 */
function resolveWithFallback(roleConfig: ModelRoleConfig, scheme: ModelScheme, providers: LLMProvider[]): {
    roleConfig: ModelRoleConfig;
    modelConfig: ModelConfig
} | null {
    const modelConfig = resolveModelConfig(roleConfig, providers)
    if (modelConfig) return {roleConfig, modelConfig}

    const primaryConfig = getRoleConfig(scheme, 'primary')
    if (!primaryConfig) return null
    const fallbackConfig = resolveModelConfig(primaryConfig, providers)
    return fallbackConfig ? {roleConfig: primaryConfig, modelConfig: fallbackConfig} : null
}

/**
 * 获取完整的执行模型配置
 */
export function getExecutionModelConfig(
    scheme: ModelScheme,
    context: TaskContext,
    intent: IntentAnalysisResult | undefined,
    providers: LLMProvider[],
): { roleConfig: ModelRoleConfig; modelConfig: ModelConfig } | null {
    const roleConfig = selectModelForTask(scheme, context, intent)
    return resolveWithFallback(roleConfig, scheme, providers)
}

/**
 * 判断是否需要自动进入 plan 模式
 */
export function shouldEnterPlanMode(intent: IntentAnalysisResult | undefined): boolean {
    if (!intent) return false
    return intent.needsPlanning || intent.complexity === 'complex'
}

/**
 * 根据 Agent 类型选择模型角色
 *
 * Agent 类型决定了应该使用哪个模型角色
 * inherit 角色表示继承父级模型，由调用方处理
 */
export function selectModelForAgentType(
    scheme: ModelScheme,
    agentType: string,
): ModelRoleConfig {
    const config = getAgentTypeConfig(agentType)
    const role = config.defaultModelRole

    if (role === 'inherit') {
        // inherit 表示继承父级模型，这里返回 primary 作为占位
        // 实际继承由调用方处理
        return getRoleConfig(scheme, 'primary')!
    }

    const roleConfig = getRoleConfig(scheme, role)
    const primaryConfig = getRoleConfig(scheme, 'primary')
    return roleConfig?.enabled ? roleConfig : (primaryConfig ?? roleConfig!)
}

/**
 * 根据 Agent 类型获取完整的模型配置
 */
export function getModelConfigForAgentType(
    scheme: ModelScheme,
    agentType: string,
    providers: LLMProvider[],
): { roleConfig: ModelRoleConfig; modelConfig: ModelConfig } | null {
    const roleConfig = selectModelForAgentType(scheme, agentType)
    return resolveWithFallback(roleConfig, scheme, providers)
}

// 获取模型角色的显示信息 — 委托给共享模块
export {getModelRoleInfo} from '@shared/modelSchemeHelpers'
