/**
 * 模型选择器
 *
 * 根据意图分析结果、Agent 类型和当前方案配置，选择合适的模型执行任务。
 */

import {logger} from '../logger'
import type {
    LLMProvider,
    ModelConfig,
    ModelOverride,
    ModelRole,
    ModelRoleConfig,
    ModelScheme
} from '@shared/types'
import {getRoleConfig} from '@shared/modelSchemeHelpers'
import {getAgentTypeConfig} from '../agentTypes/configs'
import {resolveOverrideThinkingEffort} from '@shared/thinkingEffort'
import type {ThinkingEffort} from '@shared/thinkingEffort'
import {SqliteProviderRepository} from '../../repositories/sqlite/llmProviderRepository'

const providerRepo = new SqliteProviderRepository()

export type TaskContext = 'main' | 'subAgent' | 'background' | 'planning'

/**
 * selectModelForTaskWithRole 的返回值，包含实际选择的角色信息
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
 * - fallback 链：primary → lightweight → reasoning（明确顺序，且要求 enabled && endpointId && modelId 均有效）
 */
export function selectModelForTaskWithRole(
    scheme: ModelScheme,
    context: TaskContext,
    intent?: { suggestedModel?: ModelRole },
): ModelSelectionResult {
    const primary = getRoleConfig(scheme, 'primary')
    const lightweight = getRoleConfig(scheme, 'lightweight')
    const reasoning = getRoleConfig(scheme, 'reasoning')
    const isValid = (r?: ModelRoleConfig) => !!(r?.enabled && r.endpointId && r.modelId)

    if (context === 'planning') {
        if (isValid(reasoning)) return {config: reasoning!, role: 'reasoning'}
        if (isValid(primary)) return {config: primary!, role: 'primary'}
        if (isValid(lightweight)) return {config: lightweight!, role: 'lightweight'}
        throw new Error('No valid model role configured')
    }

    if (context === 'background') {
        if (isValid(lightweight)) return {config: lightweight!, role: 'lightweight'}
        if (isValid(primary)) return {config: primary!, role: 'primary'}
        if (isValid(reasoning)) return {config: reasoning!, role: 'reasoning'}
        throw new Error('No valid model role configured')
    }

    if (intent?.suggestedModel) {
        const roleConfig = getRoleConfig(scheme, intent.suggestedModel)
        // 仅当角色已启用且已配置时才使用；否则落入 fallback 链（不再"未启用也使用"）
        if (isValid(roleConfig)) return {config: roleConfig!, role: intent.suggestedModel}
    }

    // 兜底：按 primary → lightweight → reasoning 顺序选第一个有效角色
    const enabledFallback = [primary, lightweight, reasoning].find(isValid)
    if (enabledFallback) return {config: enabledFallback!, role: 'primary'}
    throw new Error('No valid model role configured')
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
        // 稳定服务商维度（providers.id），用于 llm_usage 精确价格归因
        _providerId: provider.id,
        // 透传服务商 API 协议形态（chat / responses），适配器按此分派
        apiStyle: provider.apiStyle || 'chat',
        // 透传服务商扩展特性（如显式缓存支持）
        features: provider.features,
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

/**
 * 直接解析 provider+model 为 ModelConfig（绕过角色，会话 override 专用）
 * - provider 不存在/禁用 / model 不存在/禁用 → null（调用方降级 auto + warning）
 * - 复用 resolveModelConfig 的 OAuth2 token 解析与 apiStyle 透传
 * - thinkingEffort：override 携带的会话级思考强度，经 resolveOverrideThinkingEffort
 *   （角色匹配继承 → auto 兜底）解析后传入，写入 ModelConfig 供 agentLoop 执行层使用
 */
export function resolveDirectModelConfig(
    endpointId: string,
    modelId: string,
    providers: LLMProvider[],
    thinkingEffort?: ThinkingEffort,
): ModelConfig | null {
    const provider = providers.find((p) => p.id === endpointId)
    if (!provider || !provider.enabled) return null
    const model = provider.models.find((m) => m.id === modelId)
    if (!model || !model.enabled) return null
    return resolveModelConfig({endpointId, modelId, enabled: true, thinkingEffort}, providers)
}

/**
 * 渠道会话初始 modelConfig：会话 override → 直接解析；无 override → undefined（auto）
 * 思考强度按 resolveOverrideThinkingEffort 规则解析（显式 → 方案角色匹配继承 → auto）
 * 提取为纯函数便于单测（messageHandler 依赖面大，不直接测）
 */
export function resolveChannelModelConfig(
    convOverride: ModelOverride | null,
    providers: LLMProvider[],
    scheme?: ModelScheme | null,
): ModelConfig | undefined {
    if (!convOverride || providers.length === 0) return undefined
    const effort = resolveOverrideThinkingEffort(convOverride, scheme)
    return resolveDirectModelConfig(convOverride.endpointId, convOverride.modelId, providers, effort) || undefined
}

// 获取模型角色的显示信息 — 委托给共享模块
export {getModelRoleInfo} from '@shared/modelSchemeHelpers'
