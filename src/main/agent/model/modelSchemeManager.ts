/**
 * 模型方案管理器
 *
 * 职责：
 * 1. LLM SDK 客户端工厂（Anthropic / OpenAI / Google）
 * 2. 版本追踪（检测方案变更）
 *
 * 设计原则：
 * 1. runtimeConfigManager 作为配置单一事实来源
 * 2. 此模块只负责创建客户端实例，无缓存
 * 3. scheme 和 providers 从 runtimeConfigManager 获取
 */

import {logger} from '../logger'
import type {LLMProvider, ModelRoleConfig, ModelScheme, ProviderCredentials} from '@shared/types'
import {getRoleConfig} from '@shared/modelSchemeHelpers'
import {getConfigBridge} from '../common/configBridge'
import {tokenManager} from '../../channel/TokenManager'
import Anthropic from '@anthropic-ai/sdk'
import {GoogleGenerativeAI} from '@google/generative-ai'
import OpenAI from 'openai'

// ─── 类型导出（从 shared 统一导出）──────────────────────────────────────────

export type {ProviderCredentials}

// ─── 方案版本信息 ─────────────────────────────────────

interface SchemeVersion {
    version: number
    updatedAt: number
}

// ─── 全局状态 ─────────────────────────────────

let schemeVersion: SchemeVersion = {version: 0, updatedAt: Date.now()}


/**
 * 获取服务商信息（从 runtimeConfigManager 获取）
 */
function findProvider(endpointId: string): LLMProvider | undefined {
    const providers = getConfigBridge().getProviders()
    const provider = providers.find((p) => p.id === endpointId)
    return provider
}

/**
 * 创建 OpenAI 客户端
 */
function createOpenAIClient(provider: LLMProvider): OpenAI {
    if (!provider.apiKey || provider.apiKey.trim() === '') {
        throw new Error(`API Key is required for provider: ${provider.name}`)
    }
    return new OpenAI({
        apiKey: provider.apiKey,
        baseURL: provider.baseUrl || undefined,
    })
}

/**
 * 创建 Ollama 客户端（本地服务，不需要真实 API Key）
 */
function createOllamaClient(provider: LLMProvider): OpenAI {
    // Ollama 是本地服务，使用占位符 key 或用户配置的 key
    return new OpenAI({
        apiKey: provider.apiKey || 'ollama',
        baseURL: provider.baseUrl || 'http://localhost:11434/v1',
    })
}

/**
 * 创建 Anthropic 客户端
 */
function createAnthropicClient(provider: LLMProvider): Anthropic {

    if (!provider.apiKey || provider.apiKey.trim() === '') {
        throw new Error(`API Key is required for provider: ${provider.name}`)
    }
    return new Anthropic({
        apiKey: provider.apiKey,
        baseURL: provider.baseUrl || undefined,
    })
}

/**
 * 创建 Google 客户端
 *
 * OAuth2 模式使用 TokenManager 统一管理 token 生命周期：
 * - 首次调用时注册到 TokenManager
 * - TokenManager 自动在过期前刷新 token
 * - 刷新后自动通过 persistFn 写回 SQLite
 */
async function createGoogleClient(provider: LLMProvider): Promise<GoogleGenerativeAI> {
    const GOOGLE_OAUTH_PROVIDER_ID = 'google-oauth2'

    // OAuth2 模式
    if (provider.authType === 'google-oauth2') {
        const credentials = provider.credentials
        if (!credentials?.accessToken) {
            throw new Error(`Access Token is required for Google OAuth2 provider: ${provider.name}`)
        }

        // 首次调用时注册到 TokenManager（后续调用复用）
        if (!tokenManager.isRegistered(GOOGLE_OAUTH_PROVIDER_ID)) {
            tokenManager.register({
                providerId: GOOGLE_OAUTH_PROVIDER_ID,
                refreshLeadTime: 5 * 60 * 1000,  // 提前 5 分钟刷新
                refreshFn: async () => {
                    // 从当前配置获取最新的 refreshToken
                    const {GoogleAuthService} = await import('../../auth/googleAuth')
                    const creds = findProvider(provider.id)?.credentials
                    if (!creds?.refreshToken) {
                        throw new Error('Google OAuth2 refreshToken 不存在')
                    }
                    const newTokens = await GoogleAuthService.refreshAccessToken(creds.refreshToken)
                    return {
                        accessToken: newTokens.accessToken,
                        expiryDate: newTokens.expiryDate,
                    }
                },
                persistFn: async (accessToken: string, expiryDate: number) => {
                    // 将刷新后的 token 写回 SQLite，确保重启后仍可用
                    try {
                        const currentProvider = findProvider(provider.id)
                        if (!currentProvider?.credentials) return
                        const {SqliteProviderRepository} = await import('../../repositories/sqlite/llmProviderRepository')
                        const repo = new SqliteProviderRepository()
                        repo.save({
                            ...currentProvider,
                            credentials: {
                                ...currentProvider.credentials,
                                accessToken,
                                expiryDate,
                            },
                        })
                    } catch (err) {
                        logger.warn(`[modelSchemeManager] token 持久化失败`, {error: err})
                    }
                },
                onError: (err) => {
                    logger.error(`[modelSchemeManager] Google token 刷新失败`, {error: err.message})
                },
            })

            // 首次注册后立即获取一次 token（确保首次使用前就准备好）
            try {
                await tokenManager.refreshNow(GOOGLE_OAUTH_PROVIDER_ID)
            } catch (err) {
                // 首次刷新失败不阻塞，尝试用当前已有的 token
                logger.warn(`[modelSchemeManager] Google token 首次刷新失败，使用现有 token`, {error: err})
            }
        }

        // 从 TokenManager 获取有效 token
        let currentToken: string
        try {
            currentToken = await tokenManager.getToken(GOOGLE_OAUTH_PROVIDER_ID)
        } catch {
            // TokenManager 不可用则回退到 credentials 中的 token
            currentToken = credentials.accessToken!
        }

        // 当使用 OAuth2 Token 时，不应传入 apiKey 到构造函数（否则会被拼在 URL ?key= 中导致 400）
        const genAI = new GoogleGenerativeAI('')

        // 劫持 getGenerativeModel 以便注入自定义请求头
        const originalGetModel = genAI.getGenerativeModel.bind(genAI)
        genAI.getGenerativeModel = (modelOptions: any, requestOptions: any = {}) => {
            return originalGetModel(modelOptions, {
                ...requestOptions,
                customHeaders: {
                    ...(requestOptions.customHeaders || {}),
                    'Authorization': `Bearer ${currentToken}`,
                },
            })
        }
        return genAI
    }

    // API Key 模式
    if (!provider.apiKey || provider.apiKey.trim() === '') {
        throw new Error(`API Key is required for provider: ${provider.name}`)
    }
    return new GoogleGenerativeAI(provider.apiKey)
}

/**
 * 获取角色配置的客户端
 */
async function getClientForRole(roleConfig: ModelRoleConfig): Promise<unknown> {
    const provider = findProvider(roleConfig.endpointId)
    if (!provider) {
        throw new Error(`Provider not found for role: ${roleConfig.endpointId}`)
    }
    return await createClientForProvider(provider)
}

/**
 * 为指定的 provider 创建客户端实例
 *
 * @param provider 服务商配置
 * @returns 客户端实例
 * @throws 如果 provider 类型未知或缺少 API Key
 */
async function createClientForProvider(provider: LLMProvider): Promise<unknown> {
    switch (provider.type) {
        case 'anthropic':
            return createAnthropicClient(provider)
        case 'google':
            return await createGoogleClient(provider)
        case 'ollama':
            return createOllamaClient(provider)
        case 'openai':
        case 'custom':
        default:
            return createOpenAIClient(provider)
    }
}

// ─── 核心 API ───────────────────────────────────────────

/**
 * 更新当前模型方案
 *
 * 当 runtimeConfigManager 更新方案时调用此函数。
 * 只更新版本号，用于追踪变更。
 */
export function setCurrentScheme(
    _schemeId: string,
    _scheme: ModelScheme,
    _providers: LLMProvider[],
): void {
    schemeVersion.version++
    schemeVersion.updatedAt = Date.now()
}

/**
 * 获取当前方案 ID（从 runtimeConfigManager 获取）
 */
export function getCurrentSchemeId(): string | null {
    const scheme = getConfigBridge().getScheme()
    return scheme?.id || null
}

/**
 * 获取当前方案配置（从 runtimeConfigManager 获取）
 */
export function getCurrentScheme(): ModelScheme | null {
    return getConfigBridge().getScheme()
}

/**
 * 获取当前方案版本
 */
export function getSchemeVersion(): SchemeVersion {
    return {...schemeVersion}
}

/**
 * 获取指定角色的客户端
 *
 * 核心方法：在 LLM 调用时调用此方法获取客户端。
 * 从 runtimeConfigManager 获取 scheme 和 providers。
 *
 * @param role 角色类型
 * @returns 客户端实例
 * @throws 如果无法获取客户端（provider 缺失、齮错误等）
 */
export async function getClientForCurrentScheme(
    role: 'primary' | 'lightweight' | 'reasoning',
): Promise<{
    client: unknown;
    providerType: string;
    authType?: string;
    apiKey?: string;
    modelId: string;
    configSource: 'global-scheme' | 'scheme-param' | 'fallback';
    version: number;
    /** OAuth2 refreshToken，用于 token 自动刷新 */
    refreshToken?: string;
    /** OAuth2 token 到期时间戳 */
    tokenExpiryDate?: number;
    /** 扩展特性 */
    features?: import('@shared/types').ProviderFeatures;
}> {
    const currentScheme = getConfigBridge().getScheme()

    if (!currentScheme) {
        throw new Error('No active scheme configured')
    }

    const roleConfig = getRoleConfig(currentScheme, role)
    if (!roleConfig) {
        throw new Error(`Role config not found: ${role}`)
    }

    const {endpointId, modelId, enabled} = roleConfig

    if (!enabled && role !== 'primary') {
        logger.warn(`[modelSchemeManager] Role not enabled, falling back to primary`, {role})
        return getClientForCurrentScheme('primary')
    }

    const provider = findProvider(endpointId)
    if (!provider) {
        logger.error(`[modelSchemeManager] Provider not found`, {role, endpointId})
        throw new Error(`Provider not found for ${role}: ${endpointId}`)
    }

    const client = await getClientForRole({endpointId, modelId, enabled})
    // 根据 UUID 查询实际的模型名称（provider_models.id → model_name）
    const modelObj = provider.models.find(m => m.id === modelId)
    const actualModelName = modelObj?.name || modelId
    const isOAuth2 = provider.authType === 'google-oauth2'
    const creds = provider.credentials
    return {
        client,
        providerType: provider.type,
        authType: provider.authType,
        apiKey: isOAuth2 ? creds?.accessToken || '' : provider.apiKey || '',
        modelId: actualModelName,
        configSource: 'global-scheme',
        version: schemeVersion.version,
        refreshToken: isOAuth2 ? creds?.refreshToken : undefined,
        tokenExpiryDate: isOAuth2 ? creds?.expiryDate : undefined,
        features: provider.features,
    }
}

/**
 * 检查方案是否变更
 *
 * 用于判断是否需要重新加载配置
 */
export function hasSchemeChanged(schemeId: string): boolean {
    const currentSchemeId = getConfigBridge().getScheme()?.id || null
    return currentSchemeId !== schemeId
}

/**
 * 检查方案版本是否变更
 *
 * 用于检测方案配置更新（即使是同一个 schemeId）
 */
export function hasSchemeVersionChanged(expectedVersion: number): boolean {
    return schemeVersion.version !== expectedVersion
}

