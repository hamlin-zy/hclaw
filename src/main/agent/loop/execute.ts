/**
 * Agent 循环 — LLM 调用执行与工具执行
 *
 * 包含：
 * - LLM 调用（含重试、适配器管理、plannedCommands 权限、指数退避）
 * - 工具执行（串行/并行、结果处理、媒体提取）
 */

import type {AgentStreamEvent} from '../stream'
import type {ChatMessage} from '../model/types'
import type {ModelConfig} from '../model/types'
import type {ModelAdapter} from '../model/index'
import type {ToolContext, ToolDefinitionForLLM} from '../tools/types'
import type {LoopState as AgentLoopState} from '../state'
import type {ModelRole} from '@shared/types'
import {DEFAULT_MAX_TOKENS} from '@shared/types'
import type {RunParams, LlmStreamResult, ToolExecutionResult} from './types'

import {LLMCaller, isContextLengthError as checkContextLengthError, parsePlannedCommands} from './llmCaller'
import {selectModelForTurn} from './setup'
import {ToolExecutor} from './toolExecutor'
import {addMessage} from '../state'
import {PreprocessCache} from './preprocessCache'
import {logger} from '../logger'
import {permissionEngine} from '../tools/permission'
import {isThirdPartyAnthropicAPI} from '../model/utils'
import {classifyErrorEnhanced} from '../common/errorClassifier'
import {LLM_TIMEOUT_MS, sleep, TimeoutError, withTimeout} from '../../utils/retry'
import {attachMediaBlocksToMessage, extractMediaBlocksFromToolResults} from '../mediaExtractor'
import {supportsImageInput} from '../modelCapability'
import {sanitizeMessagesForModel, sanitizeThinkingForModel} from './helpers'
import {getToolRegistry} from '../tools/registry'
import {computeTokenTiming, isTokenDelta} from './tokenTiming'
import {resolveContextUsageTokens} from '../context'
import {resolveMaxContextTokens} from './modelMaxContext'
import {modelMetaRegistry} from '../../modelMetaRegistry'
import {withLlmTraceStream, type LlmTraceCallContext} from '../../utils/llmTraceRecorder'

const toolRegistry = getToolRegistry()

// ── mid-loop 交接门（取代自动截断）：接近窗口上限时的溢出保护 ──
// 触发线复用用户配置 handoffThresholdRatio（默认 0.5；0 = 关闭 loop 级保护）。
// 不再硬编码 0.9（用户 2026-08-18 拍板：完全尊重用户配置）。

/** mid-loop 专用交接指令（与发送前模板不同——无用户新输入，交接进行中的任务） */
export const MID_LOOP_HANDOFF_PROMPT = `当前任务执行中上下文接近窗口上限，请总结对话历史与任务进度，准备交接(session_handoff)到新会话继续执行当前任务。

【重要】若希望新会话自动启动特定技能/代理，请在调用 session_handoff 时传入 capability 参数（值为技能/代理名，不带 / 前缀）。`

export type HandoffGateAction = 'none' | 'inject' | 'stop'

export function evaluateHandoffGate(
    usageTokens: number,
    windowTokens: number,
    thresholdRatio: number,
    mode: 'auto-handoff' | 'graceful-stop',
): HandoffGateAction {
    if (thresholdRatio <= 0) return 'none' // 0 = 关闭 loop 级保护（用户自担超窗风险）
    if (usageTokens <= thresholdRatio * windowTokens) return 'none'
    return mode === 'auto-handoff' ? 'inject' : 'stop'
}

// ═══════════════════════════════════════════════════════════
//  LLM 调用（含重试）
// ═══════════════════════════════════════════════════════════

export interface ExecuteLlmCallParams {
    llmCaller: LLMCaller
    state: AgentLoopState
    systemPrompt: string
    /** skill/agent 命令模板，作为 system 独立块传递（Anthropic 多块缓存用） */
    commandTemplate?: string
    availableToolDefinitions: ToolDefinitionForLLM[]
    /**
     * ★ 能力过滤前、白名单过滤后的工具列表（400 降级恢复 analyze_image 时用，
     *    保证注入定义经过 agent 白名单，不绕过约束）
     */
    preCapabilityToolDefinitions: ToolDefinitionForLLM[]
    modelConfig: ModelConfig
    workModeRole: ModelRole
    schemeName: string | null
    getSettings: () => import('@shared/types').SystemSettings | undefined
    params: RunParams
    turns: number
    /** LLM 调用前 normalize 增量缓存（source-count 判失效） */
    preprocessCache: PreprocessCache
    /** 模型由会话 override 直接指定，跳过角色路由直接以 modelConfig 创建适配器 */
    directModel?: boolean
}

/**
 * 判定本次 attempt 是否值得重试。
 * 用户决策（2026-08-19）：LLM 报错无论什么原因都自动重试，直到成功或用户手动终止。
 * 依据：错误重试不产生额外损失（LLM 按成功 token 计费，失败调用不计费），
 * 错误分类器误判（如 OpenRouter worker error 被划为不可重试）只会白白放弃本可恢复的调用。
 * 重试次数上限由 settings.agent.retryCount 控制，达到上限才报最终错误。
 */
export function shouldRetryAttempt(
    _error: any,
    _isContextLengthError: boolean,
    _retryableFromClassifier: boolean,
): boolean {
    return true
}

/**
 * 执行 LLM 调用，包含完整的重试逻辑
 *
 * 职责：
 * - 适配器创建/重建
 * - 流式响应处理
 * - plannedCommands 解析与权限检查
 * - 错误重试（指数退避）
 *
 * @returns LlmStreamResult — 调用成功时返回结果；失败时 yield error 并返回 null
 */
export async function* executeLlmCallWithRetry(
    ctx: ExecuteLlmCallParams,
): AsyncGenerator<AgentStreamEvent, LlmStreamResult | null> {
    const {llmCaller, state, systemPrompt, commandTemplate, availableToolDefinitions, preCapabilityToolDefinitions,
        schemeName, getSettings, params, turns, preprocessCache} = ctx
    const {abortSignal, requestConfirmation} = params

    // ★ modelConfig/directModel/workModeRole 用 let：重试倒计时期间用户可能已切换模型
    //   （会话 override / 全局方案），每次 attempt 重新解析后用最新配置重试，避免旧模型空转重试。
    let modelConfig = ctx.modelConfig
    let directModel = ctx.directModel ?? false
    let workModeRole = ctx.workModeRole

    const retryCount = getSettings()?.agent.retryCount ?? 10
    const maxDelay = getSettings()?.agent.maxRetryDelay ?? 120_000
    let currentDelay = getSettings()?.agent.initialRetryDelay ?? 5000

    const llmStartTime = Date.now()
    let adapter: ModelAdapter | null = null
    let currentProvider: string = modelConfig.provider
    let currentModel: string = modelConfig.model
    let currentConfigSource: string = 'fallback'
    let currentSchemeName = schemeName
    let lastError: any

    /** ★ 400 误判降级：本 turn 内仅触发一次，后续 attempt 保持（图片不再尝试直达） */
    let degraded = false

    let handoffGateEvaluated = false
    let handoffInjected = false

    for (let attempt = 1; attempt <= retryCount; attempt++) {
        if (abortSignal?.aborted) return null

        // ★ 重试前（attempt ≥ 2）重新解析当前模型配置：重试倒计时期间用户可能已切换
        //   模型服务商/模型（会话 override 仅同步内存、不 bump schemeVersion，getAdapter 指纹无法感知），
        //   每次 attempt 基于最新选择重试，及时切换到用户新选的模型。
        if (attempt > 1) {
            const fresh = yield* selectModelForTurn(params.schemeConfig, params.sessionId, params.modelRole)
            const freshModel = fresh.modelConfig
            const freshDirect = fresh.directModel ?? false
            // 守卫：无可用方案时 selectModelForTurn 返回空占位（{provider:'custom', model:''}），
            // 此时保留原配置继续重试，避免空配置覆盖。
            const hasValidModel = !!freshModel.provider && !!freshModel.model
            if (hasValidModel) {
                const changed =
                    freshModel.provider !== modelConfig.provider ||
                    freshModel.model !== modelConfig.model ||
                    freshDirect !== directModel
                if (changed) {
                    logger.info(
                        `[AgentLoop] 重试前检测到模型切换：${modelConfig.provider}/${modelConfig.model}` +
                        ` → ${freshModel.provider}/${freshModel.model}（direct=${freshDirect}）`,
                    )
                }
                modelConfig = freshModel
                directModel = freshDirect
                workModeRole = fresh.suggestedRole
            }
        }

        const contentParts: string[] = []
        const thinkingParts: string[] = []
        const reasoningParts: string[] = []
        const collectedToolCalls: Array<{id: string; name: string; arguments: Record<string, unknown>}> = []

        try {
            // ── 获取/重建适配器（收归 LLMCaller，含 schemeVersion + provider:model/direct 检测） ──
            const adapterResult = await llmCaller.getAdapter(
                'main',
                modelConfig,
                params.schemeUpdatePromise,
                abortSignal,
                directModel,
                // ★ modelRole 生效时（文本角色）：透传已解析角色，
                //   否则 createAdapterForContext 按 context='main' 重新解析恒选 primary
                workModeRole,
            )
            adapter = adapterResult.adapter
            currentProvider = adapterResult.providerType
            currentModel = adapterResult.modelId
            currentConfigSource = adapterResult.configSource
            currentSchemeName = adapterResult.schemeName ?? currentSchemeName

            // ── 一致性防御：adapter 实际模型与 selectModelForTurn 解析结果不一致时告警 ──
            //   防止未来回归出「agent_start 显示 A / 实际运行 B / llm_usage 落库 A+B」的错配
            if (modelConfig.model && currentModel !== modelConfig.model) {
                logger.warn(
                    `[AgentLoop] adapter model mismatch: resolved=${modelConfig.model} (${modelConfig.provider}) actual=${currentModel} (${currentProvider})`,
                    {configSource: currentConfigSource, workModeRole},
                )
            }

            // ── 归一化消息历史（增量缓存） ──
            const normalizedMessages = preprocessCache.process(state.messages || [])
            let messagesToSend: ChatMessage[] = normalizedMessages

            // ── mid-loop 交接门（每轮 LLM 调用评估一次）──
            // 估算仅在首次 attempt 执行；注入在每次 attempt 重新追加（messagesToSend 每次重建）。
            if (!handoffGateEvaluated) {
                handoffGateEvaluated = true
                const windowTokens = resolveMaxContextTokens({
                    provider: currentProvider,
                    model: currentModel,
                    modelScheme: modelConfig as {maxContextTokens?: number},
                    modelMetaContextLength: modelMetaRegistry.getContextLength(currentModel),
                    adapterInfo: adapter?.getModelInfo?.() ?? null,
                })
                // 分子：优先最近一次请求的真实 usage（llmStats），字符估算仅兜底（中文失真）
                const usageTokens = resolveContextUsageTokens(messagesToSend, systemPrompt)
                const agentSettings = getSettings()?.agent
                const action = evaluateHandoffGate(
                    usageTokens,
                    windowTokens,
                    agentSettings?.handoffThresholdRatio ?? 0.5,
                    agentSettings?.midLoopOverflowMode ?? 'auto-handoff',
                )
                if (action === 'stop') {
                    const pct = windowTokens > 0 ? Math.round((usageTokens / windowTokens) * 100) : 0
                    yield {
                        type: 'error',
                        error: `上下文已接近窗口上限（约 ${pct}%），本轮已停止。建议交接或新建会话继续。`,
                    }
                    return null
                }
                if (action === 'inject') handoffInjected = true
            }
            if (handoffInjected) {
                messagesToSend = [
                    ...messagesToSend,
                    {
                        role: 'user',
                        content: MID_LOOP_HANDOFF_PROMPT,
                        id: `handoff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    } as ChatMessage,
                ]
            }

            // ★ normalize 发生了合成注入/取代（输出 ≠ 输入，非纯追加）：
            //   adapter 的增量转换缓存按「长度」命中，无法感知前缀内容变化，
            //   若复用旧缓存会把过期前缀与新追加段拼接，产生孤儿 tool 消息
            //   （opencode 网关 400: Messages with role 'tool' must be a response
            //    to a preceding message with role 'tool_calls'）。
            //   失效 adapter 转换缓存，让本次 chat() 全量重建。
            if (preprocessCache.lastWasNonZeroCopy) {
                adapter?.invalidateConvertCache?.()
            }

            // ── 执行 LLM 调用 ──
            if (!adapter) throw new Error('Adapter not initialized')

            // ★ 思考强度：尊重方案配置（modelConfig.thinkingEffort 由 modelSelector 从
            //   scheme role 的 thinking_effort 解析，如 lightweight=high）。
            //   此前硬编码 workModeRole === 'reasoning' 才启用思考，导致 lightweight 等
            //   角色配置的 thinking_effort 被丢弃（配置→执行断链：方案配了 high 实际不思考，
            //   且 LLM 仍返回 reasoning → 落库 think 块 vs loop 发送剥离 → 跨 turn 缓存断裂）。
            //   旧行为兜底：scheme 未配 thinking_effort 时，reasoning 角色仍默认 'auto'。
            const thinkingEffort = modelConfig.thinkingEffort
                ?? (workModeRole === 'reasoning' ? 'auto' : undefined)

            // ★ 400 降级（degraded=true）：恢复白名单后完整工具集（含 analyze_image）
            const toolsToSend = degraded ? preCapabilityToolDefinitions : availableToolDefinitions

            // ── 非视觉模型/降级：过滤消息中的 image_url ──
            // ★ 判定与工具侧同源（supportsImageInput）：元数据优先，命名模式回退
            // ★ 400 降级后强制过滤（与工具侧恢复 analyze_image 同步）
            const modelSupportsImages = supportsImageInput(currentModel)
            const stripImages = !modelSupportsImages || degraded
            if (stripImages) {
                const hasImageContent = messagesToSend.some(msg =>
                    Array.isArray(msg.content) && msg.content.some(p => p.type === 'image_url')
                )
                if (hasImageContent) {
                    if (!modelSupportsImages) {
                        logger.info(`[AgentLoop] 当前模型 ${currentModel} 不支持视觉，过滤历史消息中的 image_url`)
                    }
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

            // ── 命令模板尾随注入（R1 缓存修复）──
            // 模板不拼接进 systemPrompt（会破坏前缀缓存：命令轮 system 与普通轮不一致
            // 导致 cached_tokens 归零），而是作为末尾 user 消息追加，所有 adapter 一致。
            let effectiveMessages = messagesToSend
            if (commandTemplate) {
                effectiveMessages = [
                    ...messagesToSend,
                    {
                        role: 'user',
                        content: `<command-task>\n${commandTemplate}\n</command-task>`,
                        id: `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    } as ChatMessage,
                ]
            }

            const maxTokens = getSettings()?.model.defaultMaxTokens ?? DEFAULT_MAX_TOKENS
            // ── LLM 出口：agent 主循环 chat 调用 ──
            // withLlmTraceStream 包裹生成器：recordingFetch 在流消费时刻仍能读到归因上下文
            const traceCtx: LlmTraceCallContext = {
                conversationId: params.sessionId ?? 'unknown',
                turn: turns,
                step: 1,
                attempt: attempt - 1,          // 循环变量从 1 起，轨迹记录从 0 起
                provider: currentProvider,
                model: currentModel,
                apiStyle: adapter.apiStyle ?? 'chat',
                // agentTool 子会话携带 agentType，归类为 subAgent；否则为 main
                context: params.agentType ? 'subAgent' : 'main',
            }
            const rawStream = withLlmTraceStream(traceCtx, adapter!.chat({
                systemPrompt,
                messages: effectiveMessages,
                tools: toolsToSend,
                maxTokens,
                temperature: getSettings()?.model.defaultTemperature ?? 0,
                ...(effectiveThinkingEffort ? {thinkingEffort: effectiveThinkingEffort} : {}),
            }))

            const stream = withTimeout(
                rawStream,
                getSettings()?.agent.llmTimeout ?? LLM_TIMEOUT_MS,
                abortSignal,
            )

            // ── 处理流式 chunk ──
            // 本次 attempt 的解码时序（首 token 边界，与 llmStartTime 的重试级语义区分）
            const attemptStartTime = Date.now()
            let firstTokenTime: number | null = null
            let inputTokens = 0
            let outputTokens = 0
            let cacheReadTokens = 0
            let cacheWriteTokens = 0
            let reasoningTokens = 0
            let assistantThinkingSignature = ''

            for await (const chunk of stream) {
                if (abortSignal?.aborted) break

                if (firstTokenTime === null && isTokenDelta(chunk)) {
                    firstTokenTime = Date.now()
                }

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
                } else if (chunk.type === 'done') {
                    // ── max_tokens 截断：回复不完整，提示用户（不视为错误，不中断流程） ──
                    // adapter 层已识别 stop_reason='max_tokens' 并发出 done 事件，
                    // 此处分发 warning 事件（主进程对 warning 直接穿透不终结 agent）。
                    if (chunk.stopReason === 'max_tokens') {
                        const tip = `响应达到最大 Token 数（${maxTokens}）上限被截断，回复可能不完整。请增大「设置 → 模型参数 → 默认最大Token数」后重试。`
                        logger.warn(`[AgentLoop] ${tip}`)
                        yield {type: 'warning', message: tip}
                    }
                }
            }

            const attemptEnd = Date.now()
            const timing = firstTokenTime !== null
                ? computeTokenTiming(attemptStartTime, firstTokenTime, attemptEnd, outputTokens)
                : null

            // ── 流式汇编 ──
            const assistantContent = contentParts.join('')
            const assistantThinking = thinkingParts.join('')
            const assistantReasoningContent = reasoningParts.join('')

            // ── 检测空/blank 响应：若 LLM 既无文本内容也无工具调用，视为可重试错误 ──
            //   覆盖 ""、仅空白字符、或流式传输中无有效内容的情况。纯工具调用（仅
            //   tool_use 事件、无 text 事件）是合法响应，text 为空但 collectedToolCalls
            //   非空时不能误判为空响应。此处避免在空内容上解析 plannedCommands。
            if (!assistantContent.trim() && collectedToolCalls.length === 0) {
                throw new Error('LLM 返回了空响应')
            }

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
                providerName: modelConfig._providerName || currentProvider,
                handoffRequested: handoffInjected,
                ...(timing === null ? {} : timing),
            }
        } catch (error: any) {
            lastError = error

            // ★ 400 自愈：模型被误判为多模态 → 下次 attempt 清除 image_url 并恢复 analyze_image
            if (!degraded && isImageUnsupportedError(error)) {
                degraded = true
                logger.warn(
                    `[AgentLoop] 模型 ${currentModel} 返回图片不支持错误，降级为工具通道（清 image_url + 恢复 analyze_image）`,
                    {turn: turns, attempt},
                )
            }

            const hasContextLengthErr = checkContextLengthError(error)

            // ★ 分类器仅用于日志/提示，绝不能因分类器自身异常阻断重试流程。
            //   用户决策（2026-08-19）：LLM 报错无论什么原因都自动重试。
            //   分类器失败时按可重试处理（与 shouldRetryAttempt 恒 true 的语义一致）。
            let retryableFromClassifier = true
            try {
                retryableFromClassifier = classifyErrorEnhanced(error).retryable
            } catch (classifyErr: any) {
                logger.warn(`[AgentLoop] error classifier failed (${classifyErr?.message || classifyErr}), treating as retryable`)
            }
            const isRetryable = shouldRetryAttempt(error, hasContextLengthErr, retryableFromClassifier)

            if (isRetryable) {
                logger.warn(`[AgentLoop] turn ${turns} attempt ${attempt} failed: ${error.message} retryable${hasContextLengthErr ? ' (context length exceeded, still retrying per user policy)' : ''}`)
            } else {
                logger.error(`[AgentLoop] attempt ${attempt} failed: ${error.message} non-retryable`)
            }

            if (!isRetryable || attempt >= retryCount) break

            yield* retryBackoff(attempt, retryCount, error, currentDelay, abortSignal)
            currentDelay = Math.min(currentDelay * 2, maxDelay)
        }
    }

    // ── 所有重试都失败 ──
    if (!abortSignal?.aborted) {
        const isCtx = checkContextLengthError(lastError)
        const errorMessage = isCtx
            ? `上下文已超出模型窗口，本会话无法继续执行。请新建会话（原会话历史仍可查看）；可在设置中调整交接引导阈值，让后续会话更早收到交接提醒。`
            : `LLM call failed after ${retryCount} retries: ${extractErrorDetail(lastError)}`
        logger.info(`[AgentLoop] llm_call_failed: ${errorMessage}`)
        yield {type: 'error', error: errorMessage}
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
 * 判定错误是否为"模型不支持图片输入"（400 降级触发条件）。
 *
 * 来源：DeepSeek 官方文档 — 仅视觉模型接受图片，其他模型返回 400
 * ("This model does not support image")。其他服务商变体："image data is not supported"。
 * 兼容 OpenAI SDK 风格 response.data.error.message 结构。
 */
export function isImageUnsupportedError(error: any): boolean {
    if (!error) return false
    const msg = extractErrorDetail(error) || error.message || String(error)
    return /does not support image|image.*not.*support/i.test(msg)
}

/**
 * 提取用户可读的错误详情。
 *
 * SDK 抛错的 message 常是泛化文案（如 "400 Provider returned error"——
 * 该文案通常来自服务端响应体，SDK 仅拼接状态码），接口真实报错在
 * 响应体里（OpenAI 风格 {error:{message}} / {message} / 纯文本）。
 * 回退链：
 *   1. HTTP 响应体 detail（error.response.data.error.message → error.data.message → 原始 body）
 *   2. OpenAI SDK v4 APIError 的 error 属性（无 response 包装）
 *   3. cause 链上的 message（合并）
 *   4. error.message（最终兜底）
 * 命中响应体详情后，附加错误对象上的补充字段（type/code/param/request_id），
 * 便于复制后向服务商/中转排查（request_id 是定位日志的关键）。
 * 结果压缩为单行并截断（500 字符，兼顾 UI 单行展示与一键复制的内容完整性）。
 */
export function extractErrorDetail(error: any): string {
    if (!error) return 'network_error'

    const normalize = (s: string): string => s.replace(/\s+/g, ' ').trim()

    // 1. HTTP 响应体（axios/SDK 风格）
    const data = error.response?.data ?? error.data ?? error.body
    if (data) {
        let detail: string | undefined
        if (typeof data === 'string') {
            detail = data
        } else if (data.error && typeof data.error === 'object' && typeof data.error.message === 'string') {
            detail = data.error.message          // OpenAI 风格 {error: {message}}
        } else if (typeof data.error === 'string') {
            detail = data.error
        } else if (typeof data.message === 'string') {
            detail = data.message
        }
        if (detail) {
            const normalized = normalize(detail)
            if (normalized) return attachExtras(error, normalized)
        }
    }

    // 2. OpenAI SDK v4 APIError：无 response 包装，error.error 直接是响应体 error 对象/文本
    const sdkBody = error.error
    if (typeof sdkBody === 'string' && sdkBody.trim()) {
        return attachExtras(error, normalize(sdkBody))
    }
    if (sdkBody && typeof sdkBody === 'object' && typeof sdkBody.message === 'string' && sdkBody.message.trim()) {
        return attachExtras(error, normalize(sdkBody.message))
    }

    // 3. cause 链合并
    const parts: string[] = []
    let current: any = error
    let guard = 0
    while (current && current.cause && current.cause !== current && guard < 5) {
        current = current.cause
        if (current?.message) parts.push(normalize(String(current.message)))
        guard++
    }
    const msg = normalize(String(error.message || 'network_error'))
    const combined = parts.length > 0 ? `${msg}; ${parts.join('; ')}` : msg
    return combined.slice(0, 500)
}

/**
 * 拼接状态码前缀 + 响应体详情 + 补充字段（type/code/param/request_id）。
 * 补充字段仅取自错误对象顶层（SDK 会把响应体 error 字段拷贝到顶层）。
 */
function attachExtras(error: any, detail: string): string {
    const status = error.response?.status ?? error.status ?? error.statusCode
    const extras: string[] = []
    for (const key of ['type', 'code', 'param', 'request_id']) {
        const v = typeof error[key] === 'string' ? error[key].trim() : ''
        if (v && v !== detail) {
            extras.push(`${key}: ${v}`)
        }
    }
    const base = `${status ? `${status} ` : ''}${detail}`
    return extras.length > 0 ? `${base}（${extras.join('，')}）`.slice(0, 500) : base.slice(0, 500)
}

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
    const errorMsg = error instanceof TimeoutError ? 'timeout' : extractErrorDetail(error)
    const delaySeconds = Math.ceil(currentDelay / 1000)

    logger.warn(`[AgentLoop] retry ${attempt}/${retryCount}: ${errorMsg}, waiting ${delaySeconds}s`)

    yield {type: 'warning', message: `retry ${attempt}/${retryCount}：${errorMsg}`}

    for (let s = delaySeconds; s > 0; s--) {
        if (abortSignal?.aborted) {
            // ★ 明确告知用户重试已被取消，避免"倒计时后不重试"的错觉
            yield {type: 'warning', message: `retry ${attempt}/${retryCount}：已取消重试`}
            return
        }
        // ★ 每秒发一次剩余倒计时（渲染端 streamInteraction 已支持 tool_progress 显示）。
        //   progress 携带完整上下文（次数 + 错误详情 + 倒计时），防止渲染端
        //   倒计时文案覆盖 warning 的错误详情导致"只看到倒计时、看不到错因"。
        yield {
            type: 'tool_progress',
            toolCallId: 'retry-backoff',
            progress: `重试 ${attempt}/${retryCount}：${errorMsg}，${s}s 后重试...`,
            retryCountdown: s,
        }
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
    /** 当前会话 ID（用于子 Agent 创建等场景） */
    sessionId?: string
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
        requestConfirmation, askUserQuestion, channelSend, onEvent, sessionId} = ctx

    // 通知 UI 工具执行即将开始（停止 thinking 动画 + 显示执行状态）
    yield {type: 'tools_start', toolCount: collectedToolCalls.length}

    const toolContext: ToolContext = {
        workingDir,
        abortSignal: abortSignal || new AbortController().signal,
        requestConfirmation,
        askUserQuestion,
        channelSend,
        onEvent,
        conversationId: sessionId,
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
        const result = toolExecutor.processResult(execResult, collectedToolCalls[i] as any, newState, sessionId)
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
