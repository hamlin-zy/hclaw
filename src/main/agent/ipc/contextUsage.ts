/**
 * 发送前上下文占用查询 IPC
 *
 * 渲染端 InputArea 发送前调用，判断是否弹出交接引导弹窗。
 * 占比口径 = (cachedSystemPrompt + 已落库历史) / 模型窗口（发送前快照，不含待发送消息）。
 */

import {ipcMain} from 'electron'
import {estimateTotalContextTokens} from '../context'
import {resolveMaxContextTokens} from '../loop/modelMaxContext'
import {runtimeConfigManager} from '../runtimeConfigManager'
import {modelMetaRegistry} from '../../modelMetaRegistry'
import type {ChatMessage} from '../model/types'
import {createConversationRepository} from '../../repositories'

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
 * - windowTokens：scheme.maxContextTokens 优先，其次 modelMetaContextLength（or-models.json
 *   权威窗口，> 0 才生效），否则 resolveMaxContextTokens 默认 128K。
 * - modelMetaContextLength：调用方（handler）从 modelMetaRegistry 按 primary role 模型查询，
 *   保持本函数纯函数可测。
 */
export function computeContextUsage(params: {
    history: Array<{role: string; content?: unknown; toolResult?: unknown; toolCalls?: unknown}>
    cachedSystemPromptJson?: string | null
    scheme?: {maxContextTokens?: number} | null
    modelMetaContextLength?: number
}): ContextUsageResult {
    const {history, cachedSystemPromptJson, scheme, modelMetaContextLength} = params

    const windowTokens = resolveMaxContextTokens({
        provider: 'unknown',
        model: 'unknown',
        modelScheme: scheme,
        modelMetaContextLength,
        adapterInfo: null,
    })

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

    const estimatedTokens = estimateTotalContextTokens(history as ChatMessage[], systemPrompt)
    const ratio = windowTokens > 0 ? estimatedTokens / windowTokens : 0
    return {ratio, windowTokens, estimatedTokens}
}

export function registerHandlers(): void {
    ipcMain.handle('context:get-usage', async (_event, conversationId: string): Promise<ContextUsageResult> => {
        const conversationRepo = createConversationRepository()
        const history = conversationRepo.readMessages(conversationId) || []
        const cachedSystemPromptJson = conversationRepo.getSystemPrompt(conversationId)
        const modelScheme = runtimeConfigManager.getScheme()
        // ModelScheme 类型未声明 maxContextTokens（方案 JSON 可能携带额外字段），
        // 结构断言让 resolveMaxContextTokens 的 scheme 优先级生效；其余字段无关。
        const scheme = modelScheme as {maxContextTokens?: number} | null
        // 取 primary role 的模型 → or-models.json 权威窗口；未命中返回 0 → 纯函数内回退
        const primaryModelId = modelScheme?.roles.find((r) => r.role === 'primary')?.modelId
        const modelMetaContextLength = primaryModelId
            ? modelMetaRegistry.getContextLength(primaryModelId)
            : 0
        return computeContextUsage({history, cachedSystemPromptJson, scheme, modelMetaContextLength})
    })
}
