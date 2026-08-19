/**
 * LLM 调用器
 *
 * 职责：
 * - 创建和管理 adapter
 * - 重建判定（schemeVersion / suggestedModel 角色变化触发重建）
 *
 * 注：重试逻辑已迁至 execute.ts（shouldRetryAttempt + 指数退避），本类不再处理。
 */

import type {ModelConfig} from '../model/types'
import type {ModelRole} from '@shared/types'
import {createAdapterForContext, type ModelAdapter} from '../model/index'
import {logger} from '../logger'
import {getSchemeVersion} from '../model/modelSchemeManager'

export interface AdapterResult {
    adapter: ModelAdapter
    providerType: string
    modelId: string
    configSource: 'global-scheme' | 'scheme-param' | 'fallback' | 'direct'
    schemeName?: string | null
}

/**
 * 规范化 ModelConfig 的 baseUrl 指纹。
 * 兼容 baseURL / baseUrl 两种字段名（参照 openaiAdapter computeConfigHash
 * 对 `client?.baseURL || client?.baseUrl` 的处理），缺省为空串参与指纹比较。
 */
function baseUrlOf(cfg: ModelConfig): string {
    return ((cfg as any).baseURL || (cfg as any).baseUrl || '') as string
}

export class LLMCaller {
    private adapter: ModelAdapter | null = null
    private lastVersion: number = -1
    /** F1: 上次创建 adapter 时传入的 suggestedModel（角色）。auto 模式下逐 turn 由意图分析决定（simple→lightweight、complex→reasoning），变化需重建 */
    private lastSuggestedModel: string = ''
    /** D1/F3: 上次 direct 模型的完整指纹（provider:model:apiStyle:baseURL）；''=非 direct（角色路由）。
     *  重建判定含 apiStyle/baseURL —— direct→direct 切换端点（同 provider:model）必须触发重建，
     *  否则带指纹的 cache key 根本不被查询（早退复用旧端点 adapter）。 */
    private lastDirectKey: string = ''
    /** D1/D2: direct 模型适配器缓存（版本:provider:model:apiStyle:baseURL → adapter）。
     *  direct↔auto 来回切换时复用原 direct adapter，避免「auto 一轮 → 回 direct」
     *  重建新实例导致会话历史转换缓存整体失效。
     *  D2: key 纳入 schemeVersion/apiStyle/baseURL 指纹——版本变化（用户改 API key/baseUrl）
     *  或同一 provider:model 切换 apiStyle/baseUrl 时 key 变化 → 新建，避免复用错凭据/端点。 */
    private directAdapterCache = new Map<string, ModelAdapter>()
    private currentProvider: string = ''
    private currentModel: string = ''
    private currentConfigSource: 'global-scheme' | 'scheme-param' | 'fallback' | 'direct' = 'fallback'
    private currentSchemeName: string | null = null

    /**
     * 记录新建的 adapter 并同步重建判定所需的版本/建议角色/direct 指纹，
     * 返回统一的 AdapterResult。全局路径、direct 路径与 fallback 路径共用，
     * 避免任一路径漏同步导致后续重建判定失准。
     */
    private recordAdapter(
        adapter: ModelAdapter,
        provider: string,
        model: string,
        configSource: AdapterResult['configSource'],
        schemeName: string | null,
        suggestedModel?: ModelRole,
        directKey?: string,
    ): AdapterResult {
        this.adapter = adapter
        this.currentProvider = provider
        this.currentModel = model
        this.currentConfigSource = configSource
        this.currentSchemeName = schemeName
        this.lastVersion = getSchemeVersion().version
        this.lastSuggestedModel = suggestedModel ?? ''
        this.lastDirectKey = directKey ?? ''
        return {
            adapter: this.adapter,
            providerType: this.currentProvider,
            modelId: this.currentModel,
            configSource: this.currentConfigSource,
            schemeName: this.currentSchemeName,
        }
    }

    /**
     * 获取或创建适配器
     * 支持运行时切换模型方案
     */
    async getAdapter(
        context: 'main' | 'subAgent' | 'background' | 'planning',
        suggestedModel?: ModelRole,
        fallbackConfig?: ModelConfig,
        schemeUpdatePromise?: () => Promise<void>,
        // 注：createAdapterForContext 签名（model/index.ts:252）为 (context, intentAnalysis?, fallbackConfig?)
        // 三参，无 abortSignal 支持。_abortSignal 暂仅接收不透传，留作未来扩展。
        _abortSignal?: AbortSignal,
        directModel?: boolean,
    ): Promise<AdapterResult> {
        // D1/F3: 会话 override 直通模型完整指纹（provider:model:apiStyle:baseURL）。
        // baseURL/baseUrl 两种字段名均兼容；非 direct 传 undefined（'' 参与比较）
        const directKey = directModel && fallbackConfig
            ? `${fallbackConfig.provider}:${fallbackConfig.model}:${fallbackConfig.apiStyle || 'chat'}:${baseUrlOf(fallbackConfig)}`
            : undefined
        const needsRecreate = this.needsAdapterRecreate(suggestedModel, directKey)
        // D2: direct 适配器缓存指纹（版本:provider:model:apiStyle:baseURL）。
        // 与 lastDirectKey（provider:model:apiStyle:baseURL 重建判定）解耦，仅 version 维度和 cache 查询：
        //   - schemeVersion 变化（用户改 API key/baseUrl）→ key 变化 → 新建，避免复用旧凭据
        //   - 同一 provider:model 切换 apiStyle/baseUrl（同类型 provider 端点碰撞）→ key 变化 → 新建
        //   - direct↔auto→direct 同配置 → key 不变 → 复用（缓存语义保持）
        const directCacheKey = directModel && fallbackConfig
            ? `${getSchemeVersion().version}:${fallbackConfig.provider}:${fallbackConfig.model}:${fallbackConfig.apiStyle || 'chat'}:${baseUrlOf(fallbackConfig)}`
            : undefined

        if (needsRecreate) {
            // 等待方案更新完成（如果有）
            if (schemeUpdatePromise) {
                await schemeUpdatePromise()
            }

            // 创建新的 adapter
            try {
                if (directModel && fallbackConfig) {
                    // D1: override 直通模型——不经全局方案角色路由，直接 createModelAdapter。
                    // ★ 必须在 needsRecreate 分支内：同模型轮次直接复用现有 adapter，
                    //   AdapterConvertCache 增量追加，避免每轮全量重建历史（缓存灾难）。
                    // ★ direct 适配器按版本:provider:model:apiStyle:baseURL 缓存：direct↔auto 来回切换时复用原实例，
                    //   避免 auto 一轮后回到同模型被迫重建（历史转换缓存失效）；版本/apiStyle/baseURL 变化 → key 变化 → 新建。
                    const {createModelAdapter} = await import('../model/index')
                    let adapter = this.directAdapterCache.get(directCacheKey!)
                    if (!adapter) {
                        adapter = createModelAdapter(fallbackConfig)
                        this.directAdapterCache.set(directCacheKey!, adapter)
                    }
                    return this.recordAdapter(adapter, fallbackConfig.provider, fallbackConfig.model, 'direct' as const, null, suggestedModel, directKey)
                }
                const globalAdapterResult = await createAdapterForContext(
                    context,
                    {suggestedModel},
                    fallbackConfig
                )
                logger.debug('[LLMCaller]', {
                    action: 'using-global-adapter-result',
                    provider: this.currentProvider,
                    model: this.currentModel,
                    globalAdapterResult
                })
                return this.recordAdapter(
                    globalAdapterResult.adapter,
                    globalAdapterResult.providerType,
                    globalAdapterResult.modelId,
                    globalAdapterResult.configSource as AdapterResult['configSource'],
                    globalAdapterResult.schemeName || null,
                    suggestedModel,
                )
            } catch (error) {
                // createAdapterForContext 会抛出异常如果没有可用配置
                const err = error as Error
                logger.error('[LLMCaller]', {action: 'create-adapter-failed', error: err?.message})

                // 检查 fallbackConfig 是否有效
                if (!fallbackConfig || !fallbackConfig.provider || !fallbackConfig.model) {
                    const error2 = new Error(`Cannot create adapter: no valid config. fallbackConfig=${JSON.stringify(fallbackConfig)}`)
                    logger.error('[LLMCaller]', {action: 'fallback-adapter-failed', error: error2.message})
                    throw error2
                }

                const {createModelAdapter} = await import('../model/index')
                // F2: fallback 路径同样同步版本/工作模式/建议角色，
                // 避免后续全局路径恢复时被静默钉死在 fallback 配置上
                return this.recordAdapter(
                    createModelAdapter(fallbackConfig),
                    fallbackConfig.provider,
                    fallbackConfig.model,
                    'fallback',
                    null,
                    suggestedModel,
                )
            }
        }

        return {
            adapter: this.adapter!,
            providerType: this.currentProvider,
            modelId: this.currentModel,
            configSource: this.currentConfigSource,
            schemeName: this.currentSchemeName,
        }
    }

    /**
     * 检查是否需要重新创建适配器
     *
     * 触发条件：
     * - 尚无 adapter
     * - 方案版本（schemeVersion）变更
     * - D1/F3: direct 完整指纹（provider:model:apiStyle:baseURL）变化
     *   （override 切换端点/模型 / direct↔auto 切换）→ 重建
     * - F1: 逐 turn 的 suggestedModel（角色）变更——auto 模式下
     *   workModeRole 由意图分析按复杂度决定（simple→lightweight、complex→reasoning），
     *   必须单独检测角色变化才能路由到正确模型
     *
     * 注：重试逻辑由 execute.ts 统一负责（executeLlmCallWithRetry：
     * shouldRetryAttempt + 指数退避），本类不处理重试，避免双路径重试。
     */
    private needsAdapterRecreate(suggestedModel?: ModelRole, directKey?: string): boolean {
        if (!this.adapter) {
            return true
        }
        // 检查方案版本是否变更
        const newVersion = getSchemeVersion().version
        if (newVersion !== this.lastVersion) return true
        // D1/F3: direct 完整指纹变化（override 切换端点/模型 / direct↔auto 切换）→ 重建
        //    direct('x')→direct('x') 相等不复用；direct↔auto 因 '' 参与比较必然不等 → 重建
        if ((directKey ?? '') !== this.lastDirectKey) return true
        // F1: 逐 turn 角色（suggestedModel）变化需重建。
        // 首次调用（lastSuggestedModel 为空）沿用 '' 守卫模式：
        // 此时 adapter 尚为 null，已在首个分支返回 true，无需在此特殊处理。
        const currentSuggestedModel = suggestedModel ?? ''
        return this.lastSuggestedModel !== '' && currentSuggestedModel !== this.lastSuggestedModel
    }

    /**
     * 重置适配器状态（用于测试或显式切换）
     */
    reset(): void {
        this.adapter = null
        this.lastVersion = -1
        this.lastSuggestedModel = ''
        this.lastDirectKey = ''
        this.directAdapterCache.clear()
    }

    getAdapterInfo(): AdapterResult {
        return {
            adapter: this.adapter!,
            providerType: this.currentProvider,
            modelId: this.currentModel,
            configSource: this.currentConfigSource,
            schemeName: this.currentSchemeName,
        }
    }
}

/**
 * 从 LLM 响应文本中解析 plannedCommands 数组
 */
export function parsePlannedCommands(text: string): string[] | null {
    if (!text) return null

    // 尝试匹配 JSON 格式
    const jsonMatch = text.match(/\{[^}]*"plannedCommands"\s*:\s*(\[[^\]]*\])/s)
    if (jsonMatch) {
        try {
            const arr = JSON.parse(jsonMatch[1])
            if (Array.isArray(arr) && arr.every(item => typeof item === 'string')) {
                return arr
            }
        } catch {
            // 解析失败，继续尝试下一种格式
        }
    }

    // 尝试匹配单行数组格式
    const lines = text.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim()
        if (line.startsWith('[') && line.endsWith(']')) {
            try {
                const arr = JSON.parse(line)
                if (Array.isArray(arr) && arr.every(item => typeof item === 'string')) {
                    return arr
                }
            } catch {
                // 继续尝试
            }
        }
    }

    return null
}

/**
 * 判断是否为上下文长度错误
 */
export function isContextLengthError(error: any): boolean {
    if (!error) return false
    const status = error.status || error.statusCode || (error.response && error.response.status)
    const message = (error.message || '').toLowerCase()

    if (status === 400 && (
        message.includes('context length') ||
        message.includes('maximum context') ||
        message.includes('token') ||
        message.includes('reduce') ||
        message.includes('prompt is too long')
    )) {
        return true
    }

    return false
}
