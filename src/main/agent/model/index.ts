/**
 * 模型适配器工厂
 *
 * 根据 provider 类型创建对应的 ModelAdapter 实例。
 * 所有 Provider 共享统一的 ModelAdapter 接口。
 */

import type {ModelAdapter, ModelConfig} from './types'
import {AnthropicAdapter} from './anthropicAdapter'
import {OpenAIAdapter} from './openaiAdapter'
import {GoogleAdapter} from './googleAdapter'
import {OllamaAdapter} from './ollamaAdapter'
import type {LLMProvider, ModelRole, ModelScheme} from '@shared/types'
import {logger} from '../logger'
import crypto from 'crypto'
import {
    getClientForCurrentScheme,
    getCurrentScheme,
    getCurrentSchemeId,
    getSchemeVersion,
    hasSchemeChanged,
    setCurrentScheme,
} from './modelSchemeManager'
import {selectModelForTaskWithRole} from './modelSelector'

// ─── 适配器缓存 ─────────────────────────────────────────

let cachedAdapter: ModelAdapter | null = null
let cachedRole: string | null = null
let cachedVersion: number = -1
let cachedSchemeId: string | null = null
let cachedConfigHash: string | null = null

/**
 * 计算配置哈希，用于检测配置变更
 */
function computeConfigHash(client: any): string {
    const key = {
        apiKey: client?.apiKey || '',
        baseURL: client?.baseURL || client?.baseUrl || '',
        model: client?.model || '',
        provider: client?.provider || '',
    }
    return crypto.createHash('sha256')
        .update(JSON.stringify(key))
        .digest('hex')
        .substring(0, 16)
}

/**
 * 使适配器缓存失效
 */
export function invalidateAdapterCache(): void {
    cachedAdapter = null
    cachedRole = null
    cachedVersion = -1
    cachedSchemeId = null
    cachedConfigHash = null
}

export type { ModelAdapter, ModelConfig, ChatParams, ChatMessage, StreamChunk, ToolDefinition, ModelInfo, ToolCallRequest } from './types'

export function createModelAdapter(config: ModelConfig): ModelAdapter {
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicAdapter(config)
    case 'openai':
      return new OpenAIAdapter(config)
    case 'google':
        logger.info('[index.ts] createModelAdapter - google:', { config })
      return new GoogleAdapter(config)
    case 'ollama':
      return new OllamaAdapter(config)
    default:
      throw new Error(`Unknown provider: ${(config as any).provider}`)
  }
}

// ─── 全局方案集成 ─────────────────────────────────────────

/**
 * 为指定角色创建适配器
 *
 * 从全局模型方案管理器获取当前方案的配置，
 * 动态创建适配器。如果方案变更，自动使用新配置。
 *
 * 改进：
 * - 严格错误处理：失败时抛出异常而非返回 null
 * - 返回配置来源追踪
 * - 返回方案版本号用于变更检测
 * - 适配器缓存：避免重复创建相同配置的适配器
 *
 * @param role 模型角色（primary/lightweight/reasoning）
 * @param fallbackConfig 当无法从全局管理器获取时的兜底配置
 * @returns 适配器实例及元数据
 * @throws 如果无法创建适配器（配置错误或无兜底）
 */
export async function createAdapterForRole(
    role: 'primary' | 'lightweight' | 'reasoning',
    fallbackConfig?: ModelConfig,
): Promise<{
    adapter: ModelAdapter
    role: 'primary' | 'lightweight' | 'reasoning'
    schemeId: string | null
    configSource: 'global-scheme' | 'scheme-param' | 'fallback'
    version: number
    modelId: string
    authType: string
    providerType: string
}> {
    let client: unknown
    let providerType: string
    let modelId: string
    let schemeId: string | null
    let configSource: 'global-scheme' | 'scheme-param' | 'fallback'
    let version: number
    let authType: string
    let apiKey = ''
    let refreshToken: string | undefined
    let tokenExpiryDate: number | undefined
    let features: import('@shared/types').ProviderFeatures | undefined

    try {
        // 尝试从全局管理器获取
        const result = await getClientForCurrentScheme(role)
        client = result.client
        providerType = result.providerType
        modelId = result.modelId
        schemeId = getCurrentSchemeId()
        configSource = result.configSource
        version = result.version
        authType = result.authType || 'api-key'
        apiKey = result.apiKey || ''
        refreshToken = result.refreshToken
        tokenExpiryDate = result.tokenExpiryDate
        features = result.features
    } catch (error: any) {
        // 全局管理器获取失败，尝试使用兜底配置
        logger.error('[createAdapterForRole] getClientForCurrentScheme 失败', { error: error.message, stack: error.stack })
        if (fallbackConfig) {
            logger.info('[index.ts] fallbackConfig', { fallbackConfig })
            authType = fallbackConfig.authType || 'api-key'
            return {
                adapter: createModelAdapter(fallbackConfig),
                role,
                schemeId: null,
                configSource: 'fallback',
                version: 0,
                modelId: fallbackConfig.model,
                authType,
                providerType: fallbackConfig.provider,
            }
        }
        // 无兜底配置，抛出异常
        const error2 = new Error(`Cannot get client for role: ${role}, no fallback config available`)
        throw error2
    }

    // 计算当前配置的哈希值
    const currentConfigHash = computeConfigHash(client)
    
    // 检查缓存：版本号、方案ID、角色均匹配且配置未变更
    const currentVersion = getSchemeVersion()?.version
    const currentSchemeId = getCurrentSchemeId()
    if (
        cachedAdapter &&
        cachedRole === role &&
        cachedVersion === currentVersion &&
        cachedSchemeId === currentSchemeId &&
        cachedConfigHash === currentConfigHash
    ) {
        return {
            adapter: cachedAdapter,
            role,
            schemeId,
            configSource,
            version,
            modelId,
            authType,
            providerType,
        }
    }

    // 配置变更时清理旧缓存
    if (cachedAdapter && cachedConfigHash && cachedConfigHash !== currentConfigHash) {
        logger.info('[ModelAdapterFactory] Config changed, clearing adapter cache', {
            oldHash: cachedConfigHash,
            newHash: currentConfigHash,
        })
        cachedAdapter = null
    }

    // 使用统一的工厂函数创建对应的适配器，并注入客户端
    const adapter = (() => {
        const config = {
            provider: providerType as any,
            model: modelId,
            apiKey: apiKey,
            baseUrl: '',
            authType: authType as any, // 注入 authType
            refreshToken,
            tokenExpiryDate,
            features,
        }

        switch (providerType) {
            case 'anthropic':
                return new AnthropicAdapter(config, client as any)
            case 'google':
                return new GoogleAdapter(config, client as any)
            case 'ollama':
                return new OllamaAdapter(config, client as any)
            case 'custom':
            default:
                return new OpenAIAdapter(config, client as any)
        }
    })()

    // 更新缓存（包括配置哈希）
    cachedAdapter = adapter
    cachedRole = role
    cachedVersion = currentVersion
    cachedSchemeId = currentSchemeId
    cachedConfigHash = currentConfigHash

    return {
        adapter,
        role,
        schemeId,
        configSource,
        version,
        modelId,
        authType,
        providerType,
    }
}

/**
 * 根据任务上下文选择角色并创建适配器
 *
 * 改进：
 * - 严格错误处理：失败时抛出异常而非返回 null
 * - 返回完整的配置信息（包括方案名称、配置来源、版本）
 * - 明确的 fallback 链日志追踪
 *
 * @param context 任务上下文（main/subAgent/background/planning）
 * @param intentAnalysis 意图分析结果（可选）
 * @param fallbackConfig 兜底配置
 * @returns 适配器实例及完整元数据
 * @throws 如果无法创建适配器
 */
export async function createAdapterForContext(
    context: 'main' | 'subAgent' | 'background' | 'planning',
    intentAnalysis?: { suggestedModel?: ModelRole },
    fallbackConfig?: ModelConfig,
): Promise<{
    adapter: ModelAdapter
    role: ModelRole
    schemeId: string | null
    schemeName: string | null
    configSource: string
    version: number
    /** 当前使用的模型 ID */
    modelId: string
    /** 当前使用的服务商类型 */
    providerType: string
}> {
    const scheme = getCurrentScheme()

    if (!scheme) {
        if (fallbackConfig) {
            return {
                adapter: createModelAdapter(fallbackConfig),
                role: 'primary' as ModelRole,
                schemeId: null,
                schemeName: null,
                configSource: 'fallback-param',
                version: 0,
                modelId: fallbackConfig.model,
                providerType: fallbackConfig.provider,
            }
        }
        const error = new Error('No active scheme and no fallback config')
        logger.error('[createAdapterForContext] 错误', { error: error.message })
        throw error
    }

    const roleResult = selectModelForTaskWithRole(scheme, context, intentAnalysis as any)
    const roleType = roleResult.role as 'primary' | 'lightweight' | 'reasoning'

    const result = await createAdapterForRole(roleType, fallbackConfig)

    return {
        ...result,
        schemeName: scheme.name,
    }
}

/**
 * 更新全局模型方案
 *
 * 在以下场景调用：
 * 1. 应用启动时同步当前方案
 * 2. 用户在 UI 切换方案
 * 3. 服务商配置变更时重新同步
 *
 * 会自动触发后续 LLM 调用使用新方案。
 *
 * @param schemeId 方案 ID
 * @param scheme 方案配置
 * @param providers 服务商列表
 */
export function updateGlobalScheme(
    schemeId: string,
    scheme: ModelScheme,
    providers: LLMProvider[],
): void {
    invalidateAdapterCache()
    setCurrentScheme(schemeId, scheme, providers)
}

/**
 * 更新全局模型方案（异步版本）
 *
 * 用于 Worker 中的方案更新，返回 Promise 确保更新完成。
 *
 * @param schemeId 方案 ID
 * @param scheme 方案配置
 * @param providers 服务商列表
 */
export async function updateGlobalSchemeAsync(
    schemeId: string,
    scheme: ModelScheme,
    providers: LLMProvider[],
): Promise<void> {
    invalidateAdapterCache()
    setCurrentScheme(schemeId, scheme, providers)
}

/**
 * 检查当前方案是否已变更
 */
export function checkSchemeChanged(schemeId: string): boolean {
    return hasSchemeChanged(schemeId)
}

/**
 * 获取当前方案信息
 */
export function getCurrentSchemeInfo(): { id: string | null; name: string | null } {
    const scheme = getCurrentScheme()
    return {
        id: getCurrentSchemeId(),
        name: scheme?.name || null,
    }
}
