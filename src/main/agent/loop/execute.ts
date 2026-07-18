/**
 * Agent 循环 — LLM 调用执行与工具执行
 *
 * 包含：
 * - LLM 调用（含重试、适配器管理、ContextRetrieval、plannedCommands 权限、指数退避）
 * - 工具执行（串行/并行、结果处理、媒体提取）
 */

import type {AgentStreamEvent} from '../stream'
import type {ChatMessage} from '../model/types'
import type {ModelConfig} from '../model/types'
import type {ToolContext, ToolDefinitionForLLM} from '../tools/types'
import type {LoopState as AgentLoopState} from '../state'
import type {ModelRole, WorkMode} from '@shared/types'
import type {RunParams, LlmStreamResult, ToolExecutionResult} from './types'

import {LLMCaller, isContextLengthError as checkContextLengthError, parsePlannedCommands} from './llmCaller'
import {ToolExecutor} from './toolExecutor'
import {addMessage, createAssistantMessage, normalizeToolCallMessages} from '../state'
import {logger} from '../logger'
import {extractTextContent} from '../utils/contentUtils'
import {permissionEngine} from '../tools/permission'
import {runtimeConfigManager} from '../runtimeConfigManager'
import {getCurrentSchemeInfo} from '../model/index'
import {resolveModelConfig, selectModelForTaskWithRole} from '../model/modelSelector'
import {getSchemeVersion} from '../model/modelSchemeManager'
import {isThirdPartyAnthropicAPI} from '../model/utils'
import {classifyErrorEnhanced} from '../common/errorClassifier'
import {LLM_TIMEOUT_MS, sleep, TimeoutError, withTimeout} from '../../utils/retry'
import {hookExecutor, type HookResult} from '../../plugin/hooks'
import {attachMediaBlocksToMessage, extractMediaBlocksFromToolResults} from '../mediaExtractor'
import {isVisionModel, sanitizeMessagesForModel, sanitizeThinkingForModel} from './helpers'
import {truncateForLlmCall} from './truncateBeforeLlm'
import {container, DI_TOKENS} from '../common/container'
import type {ToolRegistry} from '../tools/registry'
import {checkAdapterNeedsRecreate, recreateAdapter} from './setup'

const toolRegistry: ToolRegistry = container.get<ToolRegistry>(DI_TOKENS.ToolRegistry)

// ═══════════════════════════════════════════════════════════
//  LLM 调用（含重试）
// ═══════════════════════════════════════════════════════════

/** 安全读取 adapter 的 maxContextTokens（adapter 未初始化或接口未暴露时返回 undefined） */
function safeGetAdapterMaxCtx(adapter: any): number | undefined {
    try {
        const info = adapter?.getModelInfo?.()
        return typeof info?.maxContextTokens === 'number' ? info.maxContextTokens : undefined
    } catch {
        return undefined
    }
}

export interface ExecuteLlmCallParams {
    llmCaller: LLMCaller
    state: AgentLoopState
    systemPrompt: string
    /** skill/agent 命令模板，作为 system 独立块传递（Anthropic 多块缓存用） */
    commandTemplate?: string
    availableToolDefinitions: ToolDefinitionForLLM[]
    modelConfig: ModelConfig
    workModeRole: ModelRole
    schemeName: string | null
    getSettings: () => import('@shared/types').SystemSettings | undefined
    params: RunParams
    isCompactCommand: boolean
    turns: number
}

/**
 * 执行 LLM 调用，包含完整的重试逻辑
 *
 * 职责：
 * - 适配器创建/重建
 * - ContextRetrieval Hook
 * - 流式响应处理
 * - plannedCommands 解析与权限检查
 * - 错误重试（指数退避）
 *
 * @returns LlmStreamResult — 调用成功时返回结果；失败时 yield error 并返回 null
 */
export async function* executeLlmCallWithRetry(
    ctx: ExecuteLlmCallParams,
): AsyncGenerator<AgentStreamEvent, LlmStreamResult | null> {
    const {llmCaller, state, systemPrompt, commandTemplate, availableToolDefinitions, modelConfig,
        workModeRole, schemeName, getSettings, params, isCompactCommand, turns} = ctx
    const {abortSignal, requestConfirmation, sessionId} = params

    const retryCount = getSettings()?.agent.retryCount ?? 10
    const maxDelay = getSettings()?.agent.maxRetryDelay ?? 120_000
    let currentDelay = getSettings()?.agent.initialRetryDelay ?? 5000

    const llmStartTime = Date.now()
    let adapter = (llmCaller as any)['adapter']
    let lastSchemeVersion: number | null = null
    let lastWorkMode: WorkMode = runtimeConfigManager.getWorkMode()
    let currentProvider: string = modelConfig.provider
    let currentModel: string = modelConfig.model
    let currentConfigSource: string = 'fallback'
    let currentSchemeName = schemeName
    let lastError: any

    for (let attempt = 1; attempt <= retryCount; attempt++) {
        if (abortSignal?.aborted) return null

        const contentParts: string[] = []
        const thinkingParts: string[] = []
        const reasoningParts: string[] = []
        const collectedToolCalls: Array<{id: string; name: string; arguments: Record<string, unknown>}> = []

        try {
            // ── 重建适配器（如需） ──
            const needsRecreate = checkAdapterNeedsRecreate(adapter, lastSchemeVersion, lastWorkMode)
            if (needsRecreate) {
                const recreateResult = yield* recreateAdapter(
                    params, modelConfig, workModeRole,
                )
                adapter = recreateResult.adapter
                currentProvider = recreateResult.providerType
                currentModel = recreateResult.modelId
                currentConfigSource = recreateResult.configSource
                currentSchemeName = recreateResult.schemeName ?? currentSchemeName
                lastSchemeVersion = getSchemeVersion().version
                lastWorkMode = runtimeConfigManager.getWorkMode()
            }

            // ── 归一化消息历史 ──
            const normalizedMessages = normalizeToolCallMessages(state.messages || [])
            let messagesToSend: ChatMessage[] = normalizedMessages

            // ── ContextRetrieval ──
            if (!isCompactCommand) {
                // 触发 UserPromptSubmit Hook
                const lastMsg = messagesToSend.length > 0 ? messagesToSend[messagesToSend.length - 1] : null
                if (lastMsg?.role === 'user') {
                    hookExecutor.execute('UserPromptSubmit', {
                        sessionId, prompt: String(lastMsg.content ?? ''),
                    }).catch(() => {})
                }

                const retrievalMessages = yield* executeContextRetrieval(messagesToSend, sessionId)
                if (retrievalMessages) {
                    messagesToSend = retrievalMessages
                }
            }

            // ── PreCompact Hook ──
            hookExecutor.execute('PreCompact', {sessionId}).catch(() => {})

            // ── 结构感知截断（每次调用前，保证不超模型 context window） ──
            // 顺序：必须在 ContextRetrieval 之后（否则截断会丢掉新增的 retrieval 消息）；
            //        可在 image 过滤之前（让图片占位 token 也算入 budget 估算）
            const truncateResult = truncateForLlmCall({
                messages: messagesToSend,
                systemPrompt,
                modelConfig: {provider: modelConfig.provider, model: modelConfig.model, maxContextTokens: safeGetAdapterMaxCtx(adapter)},
                settings: getSettings(),
                modelScheme: params.schemeConfig?.scheme as {maxContextTokens?: number} | undefined,
            })
            if (truncateResult.action === 'structured_truncate') {
                logger.info(
                    `[AgentLoop] 结构感知截断触发：${messagesToSend.length} → ${truncateResult.messages.length} 条消息，` +
                    `估算 tokens=${truncateResult.tokenEstimate.messagesTokens} budget=${truncateResult.tokenEstimate.budget}`,
                )
            }
            messagesToSend = truncateResult.messages

            // ── PostCompact Hook ──
            hookExecutor.execute('PostCompact', {sessionId}).catch(() => {})

            // ── 触发 ThinkStart Hook ──
            hookExecutor.execute('ThinkStart', {sessionId}).catch(() => {})

            // ── 执行 LLM 调用 ──
            if (!adapter) throw new Error('Adapter not initialized')

            const thinkingEffort = workModeRole === 'reasoning'
                ? (modelConfig.thinkingEffort || 'auto')
                : undefined

            const compactTools = isCompactCommand ? [] : availableToolDefinitions

            // ── 非视觉模型：过滤历史消息中的 image_url ──
            if (!isVisionModel(currentModel)) {
                const hasImageContent = messagesToSend.some(msg =>
                    Array.isArray(msg.content) && msg.content.some(p => p.type === 'image_url')
                )
                if (hasImageContent) {
                    logger.info(`[AgentLoop] 当前模型 ${currentModel} 不支持视觉，过滤历史消息中的 image_url`)
                    messagesToSend = sanitizeMessagesForModel(messagesToSend)
                }
            }

            // ── 推理模式启用前：检查历史消息中 thinking 块的完整性 ──
            // Anthropic API 要求在 thinking mode 中，所有之前产生的 assistant thinking 块
            // 都必须完整回传（含 signature）。如果存在不完整的 thinking 块（有内容但无签名，
            // 常见于跨供应商消息或中断恢复），需要降级为非推理模式，避免 API 400 错误。
            //
            // DeepSeek/MiMo 等第三方 Anthropic 兼容 API 不要求 signature，跳过此检查。
            const isThirdPartyAPI = isThirdPartyAnthropicAPI(currentModel, modelConfig.baseUrl || '')
            let effectiveThinkingEffort = thinkingEffort
            if (thinkingEffort && !isThirdPartyAPI) {
                const hasIncompleteThinking = messagesToSend.some(msg =>
                    msg.role === 'assistant' && !!msg.thinking && !msg.thinkingSignature
                )
                if (hasIncompleteThinking) {
                    // 列出不完整消息的 ID，便于排查
                    const incompleteIds = messagesToSend
                        .filter(msg => msg.role === 'assistant' && !!msg.thinking && !msg.thinkingSignature)
                        .map(msg => msg.id?.slice(0, 8) || '(no-id)')
                        .join(', ')
                    logger.info(
                        `[AgentLoop] 推理模式启用，但检测到 ${incompleteIds} 消息的 thinking 块缺失 signature，` +
                        `降级为非推理模式并清理 thinking 残留`,
                        { incompleteMsgIds: incompleteIds },
                    )
                    effectiveThinkingEffort = undefined
                }
            }

            // ── 非推理模式 / 降级后的消息清理 ──
            // 清理所有 assistant 消息中的 thinking/thinkingSignature 残留，
            // 确保发送给 API 的消息与当前 thinking 模式状态一致。
            if (!effectiveThinkingEffort) {
                const hasThinkingContent = messagesToSend.some(msg =>
                    msg.role === 'assistant' && (msg.thinking || msg.thinkingSignature)
                )
                if (hasThinkingContent) {
                    const reason = effectiveThinkingEffort === undefined && thinkingEffort
                        ? '（推理模式降级）'
                        : ''
                    logger.info(`[AgentLoop] 当前模型不启用推理模式${reason}，过滤历史消息中的 thinking 内容`)
                    messagesToSend = sanitizeThinkingForModel(messagesToSend)
                }
            }

            // ── 非 Anthropic 模型：将 commandTemplate 拼接回 systemPrompt ──
            const isAnthropic = modelConfig.provider === 'anthropic'
            const effectiveSystemPrompt = (!isAnthropic && commandTemplate)
                ? `${systemPrompt}\n\n## 当前命令任务\n\n${commandTemplate}`
                : systemPrompt

            const rawStream = adapter.chat({
                systemPrompt: effectiveSystemPrompt,
                ...(isAnthropic && commandTemplate ? {commandTemplate} : {}),
                messages: messagesToSend,
                tools: compactTools,
                maxTokens: getSettings()?.model.defaultMaxTokens ?? 8000,
                temperature: getSettings()?.model.defaultTemperature ?? 0,
                ...(effectiveThinkingEffort ? {thinkingEffort: effectiveThinkingEffort} : {}),
                ...(params.hookAdditionalContext && {additionalContext: params.hookAdditionalContext}),
            })

            const stream = withTimeout(
                rawStream,
                getSettings()?.agent.llmTimeout ?? LLM_TIMEOUT_MS,
                abortSignal,
            )

            // ── 处理流式 chunk ──
            let inputTokens = 0
            let outputTokens = 0
            let cacheReadTokens = 0
            let cacheWriteTokens = 0
            let reasoningTokens = 0
            let assistantThinkingSignature = ''

            for await (const chunk of stream) {
                if (abortSignal?.aborted) break

                if (chunk.type === 'error') {
                    throw (chunk as any).error || new Error('LLM Stream Error')
                }

                if (chunk.type === 'text') {
                    contentParts.push(chunk.content)
                    yield {type: 'text', content: chunk.content}
                } else if (chunk.type === 'thinking') {
                    thinkingParts.push(chunk.content)
                    yield {type: 'thinking', content: chunk.content}
                } else if (chunk.type === 'reasoning') {
                    reasoningParts.push(chunk.content)
                    yield {type: 'thinking', content: chunk.content}
                } else if (chunk.type === 'tool_use') {
                    collectedToolCalls.push({id: chunk.id, name: chunk.name, arguments: chunk.input})
                    yield {
                        type: 'tool_use',
                        toolCall: {
                            id: chunk.id,
                            name: chunk.name,
                            arguments: chunk.input,
                            reason: chunk.reason,
                        },
                    }
                } else if (chunk.type === 'usage') {
                    inputTokens = chunk.inputTokens
                    outputTokens = chunk.outputTokens
                    cacheReadTokens = chunk.cacheReadTokens || 0
                    cacheWriteTokens = chunk.cacheWriteTokens || 0
                    reasoningTokens = chunk.reasoningTokens || 0
                } else if (chunk.type === 'thinking_signature') {
                    assistantThinkingSignature = chunk.signature
                }
            }

            // ── 流式汇编 ──
            const assistantContent = contentParts.join('')
            const assistantThinking = thinkingParts.join('')
            const assistantReasoningContent = reasoningParts.join('')

            // ── 触发 ThinkEnd Hook ──
            hookExecutor.execute('ThinkEnd', {sessionId}).catch(() => {})

            // ── 解析 plannedCommands ──
            let plannedCommands: string[] | undefined
            try {
                const parsed = parsePlannedCommands(assistantContent)
                if (parsed && parsed.length > 0) {
                    plannedCommands = parsed
                }
            } catch {
                // 解析失败不影响流程
            }

            // ── 检查 plannedCommands 权限 ──
            if (plannedCommands && plannedCommands.length > 0 && requestConfirmation) {
                const permissionPassed = yield* checkPlannedCommandsPermission(
                    plannedCommands, requestConfirmation,
                )
                if (!permissionPassed) return null
            }

            const llmDuration = Date.now() - llmStartTime

            return {
                assistantContent,
                assistantThinking,
                assistantThinkingSignature,
                assistantReasoningContent,
                collectedToolCalls,
                plannedCommands,
                inputTokens,
                outputTokens,
                cacheReadTokens,
                cacheWriteTokens,
                reasoningTokens,
                llmDuration,
                adapter,
                currentProvider,
                currentModel,
                currentConfigSource,
                currentSchemeName,
            }
        } catch (error: any) {
            lastError = error
            const hasContextLengthErr = checkContextLengthError(error)
            const isRetryable = classifyErrorEnhanced(error).retryable || hasContextLengthErr

            if (isRetryable) {
                logger.warn(`[AgentLoop] turn ${turns} attempt ${attempt} failed: ${error.message} retryable`)
            } else {
                logger.error(`[AgentLoop] attempt ${attempt} failed: ${error.message} non-retryable`)
            }

            if (hasContextLengthErr) {
                logger.warn(`[AgentLoop] context length error on turn ${turns} attempt ${attempt} — will retry with truncation already applied`)
            }
            if (!isRetryable || attempt >= retryCount) break

            yield* retryBackoff(attempt, retryCount, error, currentDelay, abortSignal)
            currentDelay = Math.min(currentDelay * 2, maxDelay)
        }
    }

    // ── 所有重试都失败 ──
    if (!abortSignal?.aborted) {
        const errorMessage = `LLM call failed after ${retryCount} retries: ${lastError?.message || 'Unknown error'}`
        logger.info(`[AgentLoop] llm_call_failed after ${retryCount} retries: ${errorMessage}`)
        yield {type: 'error', error: errorMessage}
    }
    return null
}

// ─── ContextRetrieval Hook ──────────────────────────────────

/**
 * 执行 ContextRetrieval Hook
 */
export async function* executeContextRetrieval(
    messages: ChatMessage[],
    sessionId: string | undefined,
): AsyncGenerator<AgentStreamEvent, ChatMessage[] | null> {
    const lastMsg = messages[messages.length - 1]
    if (lastMsg?.role !== 'user') return null

    const retrievalResult = await hookExecutor
        .execute('ContextRetrieval', {sessionId, prompt: String(lastMsg.content ?? '')})
        .catch((): HookResult => ({decision: 'allow', allowed: true}))

    if (retrievalResult?.output) {
        return [
            ...messages.slice(0, -1),
            {role: 'user', content: `📚 相关知识:\n${retrievalResult.output}`},
            lastMsg,
        ] as ChatMessage[]
    }
    return null
}

// ─── plannedCommands 权限检查 ───────────────────────────────

/**
 * 检查 plannedCommands 权限
 * @returns true — 权限通过；false — 权限被拒绝（已 yield done 事件）
 */
export async function* checkPlannedCommandsPermission(
    plannedCommands: string[],
    requestConfirmation: (message: string) => Promise<'allow' | 'always' | 'deny'>,
): AsyncGenerator<AgentStreamEvent, boolean> {
    const checkResult = permissionEngine.checkPlannedCommands(plannedCommands)

    if (checkResult.needsConfirmation && checkResult.confirmationMessage) {
        const confirmed = await requestConfirmation(checkResult.confirmationMessage)

        if (confirmed === 'deny') {
            logger.info(`[AgentLoop] loop done reason:permission_denied`)
            yield {type: 'done', reason: 'aborted'}
            return false
        }
        if (confirmed === 'always') {
            for (const cmd of checkResult.commandsToConfirm) {
                const cmdPrefix = cmd.trim().split(/\s+/)[0] || ''
                await permissionEngine.addRule({tool: `bash:${cmdPrefix}*`, action: 'allow'})
            }
        }
    }
    return true
}

// ─── 重试等待：指数退避 ────────────────────────────────────

/**
 * 重试等待：指数退避 + 倒计时显示
 */
export async function* retryBackoff(
    attempt: number,
    retryCount: number,
    error: any,
    currentDelay: number,
    abortSignal: AbortSignal | undefined,
): AsyncGenerator<AgentStreamEvent, void> {
    const errorMsg = error instanceof TimeoutError ? 'timeout' : (error.message || 'network_error')
    const delaySeconds = Math.ceil(currentDelay / 1000)

    logger.warn(`[AgentLoop] retry ${attempt}/${retryCount}: ${errorMsg}, waiting ${delaySeconds}s`)

    yield {type: 'warning', message: `retry ${attempt}/${retryCount}：${errorMsg}`}

    for (let s = delaySeconds; s > 0; s--) {
        if (abortSignal?.aborted) break
        await sleep(1000)
    }
}

// ═══════════════════════════════════════════════════════════
//  工具执行
// ═══════════════════════════════════════════════════════════

export interface ExecuteToolCallsParams {
    toolExecutor: ToolExecutor
    collectedToolCalls: Array<{id: string; name: string; arguments: Record<string, unknown>}>
    state: AgentLoopState
    workingDir: string
    abortSignal: AbortSignal | undefined
    requestConfirmation: ((message: string) => Promise<'allow' | 'always' | 'deny'>) | undefined
    askUserQuestion: ((question: string, options?: string[], multiSelect?: boolean) => Promise<string>) | undefined
    channelSend: ((channelId: string, toUser: string, text: string, contextToken?: string, fileType?: string) => Promise<{ success: boolean; error?: string }>) | undefined
    onEvent: ((event: any) => void) | undefined
}

/**
 * 执行 LLM 请求的工具调用
 * - 判断串行/并行执行
 * - 处理执行结果
 * - 发射相关事件
 */
export async function* executeToolCalls(
    ctx: ExecuteToolCallsParams,
): AsyncGenerator<AgentStreamEvent, ToolExecutionResult> {
    const {toolExecutor, collectedToolCalls, state, workingDir, abortSignal,
        requestConfirmation, askUserQuestion, channelSend, onEvent} = ctx

    // 通知 UI 工具执行即将开始（停止 thinking 动画 + 显示执行状态）
    yield {type: 'tools_start', toolCount: collectedToolCalls.length}

    const toolContext: ToolContext = {
        workingDir,
        abortSignal: abortSignal || new AbortController().signal,
        requestConfirmation,
        askUserQuestion,
        channelSend,
        onEvent,
        sendMessage: (msg: any) => {
            if (!onEvent) return
            switch (msg.type) {
                case 'subagent_progress':
                    onEvent({
                        type: 'subagent_progress',
                        taskId: msg.taskId,
                        toolCallId: msg.toolCallId,
                        subAgentEvent: msg.subAgentEvent,
                        progress: msg.progress,
                        subAgentStreamEvent: msg.subAgentStreamEvent,
                    })
                    break
                case 'subagent_start':
                    onEvent({
                        type: 'subagent_start',
                        taskId: msg.taskId,
                        description: msg.description || '',
                        toolCallId: msg.toolCallId,
                    })
                    break
                case 'subagent_done':
                    onEvent({
                        type: 'subagent_done',
                        taskId: msg.taskId,
                        success: msg.success ?? true,
                        output: msg.output || '',
                        error: msg.error,
                        toolCallId: msg.toolCallId,
                    })
                    break
                case 'skill_start':
                    onEvent({type: 'skill_start', skillName: msg.skillName})
                    break
                case 'skill_end':
                    onEvent({type: 'skill_end', skillName: msg.skillName, success: msg.success})
                    break
            }
        },
    }

    const needsSerial =
        toolExecutor.hasConfirmationRequired(collectedToolCalls, toolRegistry) ||
        collectedToolCalls.some(tc => tc.name === 'file_edit' || tc.name === 'ask_user')

    const results = needsSerial
        ? await executeSerially(toolExecutor, collectedToolCalls, toolContext, abortSignal)
        : await executeInParallel(toolExecutor, collectedToolCalls, toolContext)

    const events: AgentStreamEvent[] = []
    let newState = state
    // 收集工具结果的 injectMessage，延迟到所有 tool 消息之后注入
    // 避免 system/user 消息插入 tool 消息之间，破坏 Anthropic API 的 tool_use/tool_result 配对要求
    const deferredMessages: ChatMessage[] = []

    for (let i = 0; i < collectedToolCalls.length; i++) {
        if (abortSignal?.aborted) break
        const {result: execResult, events: execEvents} = results[i]
        for (const event of execEvents) events.push(event)
        const result = toolExecutor.processResult(execResult, collectedToolCalls[i] as any, newState)
        newState = result.state
        for (const event of result.events) events.push(event)
        if (result.injectedMessage) {
            deferredMessages.push(result.injectedMessage)
        }
    }

    // 将所有 injectMessage 追加到所有 tool 消息之后
    for (const msg of deferredMessages) {
        newState = addMessage(newState, msg)
    }

    return {state: newState, events}
}

// ─── 串行/并行执行 ─────────────────────────────────────────

/** 串行执行工具调用 */
export async function executeSerially(
    toolExecutor: ToolExecutor,
    toolCalls: any[],
    context: ToolContext,
    signal?: AbortSignal,
) {
    const results: any[] = []
    for (const tc of toolCalls) {
        if (signal?.aborted) break
        results.push(await toolExecutor.execute(tc as any, context))
    }
    return results
}

/** 并行执行工具调用 */
export async function executeInParallel(
    toolExecutor: ToolExecutor,
    toolCalls: any[],
    context: ToolContext,
) {
    return Promise.all(toolCalls.map(tc => toolExecutor.execute(tc as any, context)))
}

// ═══════════════════════════════════════════════════════════
//  从 tool result 提取媒体文件
// ═══════════════════════════════════════════════════════════

/**
 * 从工具执行结果中提取媒体文件（图片等）并关联到最近的 assistant 消息
 */
export function extractMediaFromToolResults(state: AgentLoopState): AgentLoopState {
    try {
        const mediaBlocks = extractMediaBlocksFromToolResults(state.messages as any[])
        if (mediaBlocks.length > 0) {
            const msgs = [...state.messages]
            for (let i = msgs.length - 1; i >= 0; i--) {
                if ((msgs[i] as any).role === 'assistant') {
                    msgs[i] = attachMediaBlocksToMessage(msgs[i] as any, mediaBlocks) as any
                    break
                }
            }
            logger.info(`[AgentLoop] extracted ${mediaBlocks.length} media blocks from tool results`)
            return {...state, messages: msgs as any}
        }
    } catch (err) {
        logger.warn('[AgentLoop] media extraction failed:', {error: String(err)})
    }
    return state
}
