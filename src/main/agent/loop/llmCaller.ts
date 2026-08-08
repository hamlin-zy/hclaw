/**
 * LLM 调用器
 *
 * 职责：
 * - 创建和管理 adapter
 * - 处理重试逻辑
 * - 统一的错误分类
 */

import type {ModelConfig} from '../model/types'
import {createAdapterForContext, type ModelAdapter} from '../model/index'
import {logger} from '../logger'
import {getSchemeVersion} from '../model/modelSchemeManager'
import {runtimeConfigManager} from '../runtimeConfigManager'

export interface LLMCallerConfig {
    maxRetries: number
    initialDelay: number
    maxDelay: number
}

export interface AdapterResult {
    adapter: ModelAdapter
    providerType: string
    modelId: string
    configSource: 'global-scheme' | 'scheme-param' | 'fallback'
    schemeName?: string | null
}

export interface LLMCallResult {
    content: string
    toolCalls: Array<{id: string; name: string; arguments: Record<string, unknown>}>
    inputTokens: number
    outputTokens: number
    plannedCommands?: string[]
}

export class LLMCaller {
    private adapter: ModelAdapter | null = null
    private lastVersion: number = -1
    /** A2: 上次创建 adapter 时的工作模式，用于检测 auto/其他模式切换触发重建 */
    private lastWorkMode: string = ''
    private currentProvider: string = ''
    private currentModel: string = ''
    private currentConfigSource: 'global-scheme' | 'scheme-param' | 'fallback' = 'fallback'
    private currentSchemeName: string | null = null

    constructor(private config: LLMCallerConfig) {}

    /**
     * 获取或创建适配器
     * 支持运行时切换模型方案
     */
    async getAdapter(
        context: 'main' | 'subAgent' | 'background' | 'planning',
        suggestedModel?: string,
        fallbackConfig?: ModelConfig,
        schemeUpdatePromise?: () => Promise<void>,
        // 注：createAdapterForContext 签名（model/index.ts:252）为 (context, intentAnalysis?, fallbackConfig?)
        // 三参，无 abortSignal 支持。_abortSignal 暂仅接收不透传，留作未来扩展。
        _abortSignal?: AbortSignal
    ): Promise<AdapterResult> {
        const needsRecreate = this.needsAdapterRecreate()

        if (needsRecreate) {
            // 等待方案更新完成（如果有）
            if (schemeUpdatePromise) {
                await schemeUpdatePromise()
            }

            // 创建新的 adapter
            try {
                const globalAdapterResult = await createAdapterForContext(
                    context,
                    {suggestedModel: suggestedModel as any},
                    fallbackConfig
                )
                logger.debug('[LLMCaller]', {
                    action: 'using-global-adapter-result',
                    provider: this.currentProvider,
                    model: this.currentModel,
                    globalAdapterResult
                })
                this.adapter = globalAdapterResult.adapter
                this.currentProvider = globalAdapterResult.providerType
                this.currentModel = globalAdapterResult.modelId
                this.currentConfigSource = globalAdapterResult.configSource as 'global-scheme' | 'scheme-param' | 'fallback'
                this.currentSchemeName = globalAdapterResult.schemeName || null

                // 记录当前版本与工作模式
                this.lastVersion = getSchemeVersion().version
                this.lastWorkMode = runtimeConfigManager.getWorkMode()

                return {
                    adapter: this.adapter,
                    providerType: this.currentProvider,
                    modelId: this.currentModel,
                    configSource: this.currentConfigSource,
                    schemeName: this.currentSchemeName,
                }
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
                this.adapter = createModelAdapter(fallbackConfig)
                this.currentConfigSource = 'fallback'
                this.currentProvider = fallbackConfig.provider
                this.currentModel = fallbackConfig.model

                return {
                    adapter: this.adapter,
                    providerType: this.currentProvider,
                    modelId: this.currentModel,
                    configSource: this.currentConfigSource,
                    schemeName: this.currentSchemeName,
                }
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
     * - A2: 工作模式（auto/其他）变更——影响模型选择角色
     *
     * 注：本类不再提供 withRetry —— execute.ts 自带完整重试逻辑
     * （shouldRetryAttempt + 指数退避），避免双路径重试。
     */
    private needsAdapterRecreate(): boolean {
        if (!this.adapter) {
            return true
        }
        // 检查方案版本是否变更
        const newVersion = getSchemeVersion().version
        if (newVersion !== this.lastVersion) return true
        // A2: 工作模式变更（auto/其他）也会影响模型选择角色，需重建
        const currentWorkMode = runtimeConfigManager.getWorkMode()
        return this.lastWorkMode !== '' && currentWorkMode !== this.lastWorkMode
    }

    /**
     * 重置适配器状态（用于测试或显式切换）
     */
    reset(): void {
        this.adapter = null
        this.lastVersion = -1
        this.lastWorkMode = ''
    }

    getAdapterInfo() {
        return {
            provider: this.currentProvider,
            model: this.currentModel,
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
