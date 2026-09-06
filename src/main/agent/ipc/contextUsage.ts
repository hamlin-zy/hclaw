/**
 * 发送前上下文占用查询 IPC
 *
 * 渲染端 InputArea 发送前调用，判断是否弹出交接引导弹窗。
 * 占比口径 = (cachedSystemPrompt + 已落库历史) / 模型窗口（发送前快照，不含待发送消息）。
 */

import {ipcMain} from 'electron'
import {resolveContextUsageTokens} from '../context'
import {resolveModelParams} from '@shared/modelParams'
import {runtimeConfigManager} from '../runtimeConfigManager'
import {modelMetaRegistry} from '../../modelMetaRegistry'
import type {ChatMessage} from '../model/types'
import type {LLMProvider, ModelScheme, ModelConfig} from '@shared/types'
import {createConversationRepository} from '../../repositories'

/** 模型级运行时参数覆盖（spec §6.3） */
type ModelParams = NonNullable<ModelConfig['modelParams']>

export interface ContextUsageResult {
    /** 上下文占用比例（0-1） */
    ratio: number
    /** 模型窗口 token 数 */
    windowTokens: number
    /** 估算的已用 token 数（systemPrompt + history） */
    estimatedTokens: number
}

/**
 * 纯函数：计算上下文占用占比。
 * - cachedSystemPromptJson：DB 缓存的系统提示词 JSON（{core, commandTemplate, buildDate}）。
 *   无缓存、解析失败或无 core 字符串时无法估算真实 prompt → 跳过发送前引导（ratio 0），
 *   loop 级溢出门仍兜底。有缓存 core 时按 (core + history) / 窗口 计算占比。
 * - windowTokens：modelMetaContextLength（or-models.json 权威窗口，> 0 才生效）优先，否则 resolveMaxContextTokens 默认 1M。
 * - modelMetaContextLength：调用方（handler）从 modelMetaRegistry 按 primary role 模型查询，
 *   保持本函数纯函数可测。
 */
export function computeContextUsage(params: {
    history: Array<{role: string; content?: unknown; toolResult?: unknown; toolCalls?: unknown; llmStats?: ChatMessage['llmStats']}>
    cachedSystemPromptJson?: string | null
    modelMetaContextLength?: number
    /** primary 模型 per-model 参数覆盖（spec §6.3，与 execute.ts handoff gate 同口径） */
    modelParams?: ModelParams
    settings?: {model?: {defaultTemperature?: number; defaultMaxTokens?: number}}
}): ContextUsageResult {
    const {history, cachedSystemPromptJson, modelMetaContextLength, modelParams, settings} = params

    // 分母与 execute.ts handoff gate 同口径（spec §6.3）：
    // per-model 自定义 → OpenRouter（or-models.json）→ 系统设置无关此参数 → 兜底 1M
    const windowTokens = resolveModelParams(modelParams, settings, modelMetaContextLength ?? 0)
        .maxContextTokens.value

    let systemPrompt: string | undefined
    if (cachedSystemPromptJson) {
        try {
            const parsed = JSON.parse(cachedSystemPromptJson) as {core?: unknown}
            if (typeof parsed.core === 'string') systemPrompt = parsed.core
        } catch {
            // 解析失败 → 保持 undefined，走跳过引导分支
        }
    }

    // 新会话（无缓存 prompt）或缓存解析失败/无 core 字符串 → 无法估算真实 prompt，
    // 直接返回 ratio 0（不触发发送前弹窗，符合 spec 3.2"新会话不弹窗"）。
    if (!systemPrompt) {
        return {ratio: 0, windowTokens, estimatedTokens: 0}
    }

    // 分子：优先历史中最近一次请求的真实 usage（与 UI 徽章同口径），
    // 无 llmStats 时回退 chars/4 字符估算（对中文严重失真，仅兜底）。
    const estimatedTokens = resolveContextUsageTokens(history as ChatMessage[], systemPrompt)
    const ratio = estimatedTokens / windowTokens
    return {ratio, windowTokens, estimatedTokens}
}

/**
 * 纯函数：primary role → 模型名。
 * modelId 是 provider_models 的 UUID，直接传给 modelMetaRegistry 查不到（会跌落 1M 兜底），
 * 必须先解析为模型名（与渲染端 useWindowUsage 同口径）。未命中返回空串。
 */
export function resolvePrimaryModelName(
    scheme: Pick<ModelScheme, 'roles'> | null | undefined,
    providers: LLMProvider[],
): string {
    const role = scheme?.roles.find((r) => r.role === 'primary')
    if (!role) return ''
    const provider = providers.find((p) => p.id === role.endpointId)
    return provider?.models.find((m) => m.id === role.modelId)?.name || ''
}

/**
 * 纯函数：解析 primary 模型的 per-model 参数覆盖（spec §6.3）。
 * 仅当 primary 模型存在于【已启用】provider 列表且至少一项数值参数非 null 时返回；
 * 否则返回 undefined → resolveModelParams 走 OpenRouter/兜底层（与 execute.ts 回退一致）。
 */
export function resolvePrimaryModelParams(
    scheme: Pick<ModelScheme, 'roles'> | null | undefined,
    providers: LLMProvider[],
): ModelParams | undefined {
    const role = scheme?.roles.find((r) => r.role === 'primary')
    if (!role) return undefined
    const provider = providers.find((p) => p.id === role.endpointId && p.enabled)
    const model = provider?.models.find((m) => m.id === role.modelId)
    if (!model) return undefined
    if (model.maxContextTokens == null && model.temperature == null && model.maxOutputTokens == null) {
        return undefined
    }
    return {
        maxContextTokens: model.maxContextTokens,
        temperature: model.temperature,
        maxOutputTokens: model.maxOutputTokens,
    }
}

export function registerHandlers(): void {
    ipcMain.handle('context:get-usage', async (_event, conversationId: string): Promise<ContextUsageResult> => {
        const conversationRepo = createConversationRepository()
        const history = conversationRepo.readMessages(conversationId) || []
        const cachedSystemPromptJson = conversationRepo.getSystemPrompt(conversationId)
        const modelScheme = runtimeConfigManager.getScheme()
        const providers = runtimeConfigManager.getProviders()
        // primary role 的 UUID modelId → 解析为模型名 → or-models.json 权威窗口；
        // 未命中返回 0 → 纯函数内回退默认 1M。
        // per-model 自定义参数与 execute.ts handoff gate 同口径（spec §6.3）
        const primaryModelName = resolvePrimaryModelName(modelScheme, providers)
        const modelMetaContextLength = primaryModelName
            ? modelMetaRegistry.getContextLength(primaryModelName)
            : 0
        return computeContextUsage({
            history,
            cachedSystemPromptJson,
            modelMetaContextLength,
            modelParams: resolvePrimaryModelParams(modelScheme, providers),
            settings: runtimeConfigManager.getSettings() ?? undefined,
        })
    })
}
