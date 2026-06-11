/**
 * Agent 循环控制器
 *
 * 职责：
 * - 管理循环状态（协调各阶段）
 * - 编排主循环流程
 * - 对外暴露公共接口
 *
 * 具体实现已拆分到：
 *   types.ts      — 类型定义
 *   helpers.ts    — 工具函数（视觉模型检测、消息清理、意图分析等）
 *   setup.ts      — 运行前设置（初始化、命令检测、模型选择、工具过滤、系统提示词）
 *   execute.ts    — LLM 调用执行与工具执行
 *   compress.ts   — 压缩与事件发送
 */

import type {AgentStreamEvent} from '../stream'
import type {LoopState as AgentLoopState} from '../state'
import type {CommandExecutionContext} from '@shared/types'

import {isContextLengthError as checkContextLengthError, LLMCaller} from './llmCaller'
import {ToolExecutor} from './toolExecutor'
import {addMessage, createAssistantMessage} from '../state'
import {logger} from '../logger'
import {extractTextContent, getMessagePreview} from '../utils/contentUtils'
import {permissionRulesManager} from '../permissions/permissionRule'
import type {IConversationRepository} from '../../repositories/interfaces'
import {createConversationRepository} from '../../repositories'

import type {RunParams, MainLoopExitReason, ControllerState} from './types'
import {createDefaultResult, endTurnCleanup} from './helpers'
import {initializeRunEnvironment, detectCommandContext, selectModelForTurn, filterTools, buildSystemPrompt} from './setup'
import {executeLlmCallWithRetry, executeToolCalls, extractMediaFromToolResults} from './execute'
import {executeCompactCommand, autoCompressIfNeeded, emitLlmCallDone, handleNoToolCalls, getLastUserMessage} from './compress'

// ─── 缓存载荷类型 ────────────────────────────────────────

interface CachePayload {
    core: string
    commandTemplate: string
}

/** 安全解析 DB 缓存 JSON，兼容旧格式纯字符串 */
function safeParseCache(raw: string | null): CachePayload | null {
    if (!raw) return null
    try {
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed.core === 'string') {
            return parsed as CachePayload
        }
    } catch {
        // 旧格式：纯字符串（core = 完整提示词，无模板）
    }
    return { core: raw, commandTemplate: '' }
}

// Re-export for backward compatibility — 使用 controller.ts 导出引用
export {isVisionModel, sanitizeMessagesForModel} from './helpers'
export type {RunParams} from './types'

export class AgentLoopController {
    private ctrlState: ControllerState = 'idle'
    private turns = 0
    private compactLevel = 0
    /** 上一次 LLM 调用的实际 inputTokens（API 返回），用于精确压缩阈值判定 */
    private lastActualInputTokens = 0
    /** 记录 inputTokens 时的消息数量，用于计算增量 */
    private messagesAtLLMCall = 0

    constructor(
        private llmCaller: LLMCaller,
        private toolExecutor: ToolExecutor,
    ) {}

    // ═══════════════════════════════════════════════════════
    //  公共接口
    // ═══════════════════════════════════════════════════════

    getState(): ControllerState {
        return this.ctrlState
    }

    getTurns(): number {
        return this.turns
    }

    // ═══════════════════════════════════════════════════════
    //  主循环入口
    // ═══════════════════════════════════════════════════════

    /**
     * 运行 Agent 循环
     */
    async *run(params: RunParams): AsyncGenerator<AgentStreamEvent> {
        this.ctrlState = 'running'
        this.turns = 0

        // ── 阶段 1：初始化运行时环境 ──
        const {state, getSettings, workingDir} = yield* initializeRunEnvironment(params)

        // ── 阶段 2：检测命令执行上下文 ──
        const {commandContext, isCompactCommand} = await detectCommandContext(params)

        // ── 阶段 3：计算最大轮数 ──
        const maxTurnsLimit = getSettings()?.agent?.maxTurns ?? params.agentDefinition?.maxTurns ?? params.maxTurns ?? 500

        // ── 阶段 4：主循环 ──
        const loopResult = yield* this.#mainLoop(
            params, state, commandContext, isCompactCommand, getSettings, workingDir, maxTurnsLimit,
        )

        // ── 阶段 5：收尾（仅 max_turns_reached 路径需要额外处理） ──
        if (loopResult === 'max_turns') {
            logger.info(`[AgentLoop] loop finish turns:${this.turns} reason:max_turns_reached`)
            this.ctrlState = 'done'
            logger.info(`[AgentLoop] loop done turns:${this.turns} reason:max_turns_reached`)
            yield {type: 'done', reason: 'completed'}
        }
    }

    // ═══════════════════════════════════════════════════════
    //  主循环
    // ═══════════════════════════════════════════════════════

    /**
     * Agent 主循环：每轮执行模型选择 → 系统提示词 → LLM 调用 → 工具执行 → 自动压缩
     */
    async *#mainLoop(
        params: RunParams,
        state: AgentLoopState,
        commandContext: CommandExecutionContext | null,
        isCompactCommand: boolean,
        getSettings: () => import('@shared/types').SystemSettings | undefined,
        workingDir: string,
        maxTurnsLimit: number,
    ): AsyncGenerator<AgentStreamEvent, MainLoopExitReason> {
        const {
            abortSignal, agentDefinition, agentType: agentTypeParam,
            customInstructions, agentTemplates, schemeConfig,
            requestConfirmation, askUserQuestion, channelSend,
            onEvent, conversationTitle, sessionId,
        } = params

        let currentState = state
        let turnCount = 0
        let lastLoggedMsgCount = 0

        // ★ 从 DB 加载缓存的系统提示词
        let cachedSystemPrompt: string | null = null
        const conversationRepo: IConversationRepository | null = sessionId
            ? createConversationRepository()
            : null
        if (conversationRepo) {
            try {
                cachedSystemPrompt = conversationRepo.getSystemPrompt(sessionId!)
            } catch (err) {
                logger.debug('[AgentLoop] failed to load cached system prompt from DB', {error: String(err)})
            }
        }

        while (turnCount < maxTurnsLimit) {
            // ── 检查中止信号 ──
            if (abortSignal?.aborted) {
                logger.info(`[AgentLoop] loop done turns:${turnCount} reason:aborted`)
                yield {type: 'done', reason: 'aborted'}
                return 'early_exit'
            }

            // ── 注入运行中新收到的用户消息 ──
            const pendingMsgs = params.pendingInjectedMessages
            if (pendingMsgs && pendingMsgs.length > 0) {
                const injected: Array<{ content: string; id?: string }> = []
                while (pendingMsgs.length > 0) {
                    const msg = pendingMsgs.shift()
                    if (msg) {
                        currentState = addMessage(currentState, msg)
                        const msgContent = typeof msg.content === 'string' ? msg.content : '(non-text)'
                        injected.push({ content: msgContent, id: msg.id })
                    }
                }
                logger.info(`[AgentLoop] 注入 ${injected.length} 条用户消息到 currentState`, {
                    messages: injected.map(m => ({ id: m.id?.slice(0, 8), content: m.content?.slice(0, 60) })),
                })
                yield {type: 'user_message_injected'}
            }

            turnCount++
            this.turns = turnCount
            logger.info(`[AgentLoop] start turn ${turnCount}/${maxTurnsLimit}`)

            // ── 获取最后一条用户消息 ──
            const lastUserMessage = getLastUserMessage(currentState)

            // ── 意图分析 ──
            const analysisText = lastUserMessage ? extractTextContent(lastUserMessage.content) : ''
            const analysis = createDefaultResult(analysisText)

            // ── 选择模型 ──
            const selection = yield* selectModelForTurn(analysis, schemeConfig)

            // ── 过滤工具列表 ──
            const agentType = (agentTypeParam ?? params.agentType) || 'General'
            const availableToolDefinitions = await filterTools(agentDefinition, agentType)
            logger.debug(
                `[AgentLoop] setup model:${selection.modelConfig.model} provider:${selection.modelConfig.provider} tools:${availableToolDefinitions.length}`,
            )

            // ── 发送 agent_start 事件 ──
            yield {
                type: 'agent_start',
                agentType,
                agentId: sessionId || '',
                model: selection.modelConfig.model,
                provider: selection.modelConfig.provider,
                tools: availableToolDefinitions.map(t => t.name),
            }

            // ── 构建系统提示词 ──
            const sysPromptContext = await permissionRulesManager.getContext()
            const currentPermissionMode = sysPromptContext.mode

            // ★ 解析 DB 缓存 JSON（兼容旧格式纯字符串）
            const cached = safeParseCache(cachedSystemPrompt)
            const cachedCore = cached?.core ?? null

            const systemPrompt = await buildSystemPrompt({
                commandContext,
                agentDefinition,
                workingDir,
                availableToolDefinitions,
                currentPermissionMode,
                customInstructions,
                agentType,
                agentTemplates,
                isCompactCommand,
                cachedSystemPrompt: cachedCore,
            })

            // ★ 提取 commandTemplate：新命令优先，其次回退到缓存值
            const commandTemplate = commandContext?.commandTemplate ?? cached?.commandTemplate ?? ''

            // ★ 构建新的缓存载荷（JSON 格式）
            const newCachePayload = JSON.stringify({core: systemPrompt, commandTemplate})

            // ★ 缓存未命中时写入 DB（不阻塞主流程）
            if (conversationRepo && newCachePayload !== cachedSystemPrompt) {
                conversationRepo.setSystemPrompt(sessionId!, newCachePayload)
                cachedSystemPrompt = newCachePayload
            }

            // ── 处理压缩命令（提前 return） ──
            if (isCompactCommand) {
                yield* executeCompactCommand(currentState, systemPrompt, params, this.turns)
                return 'early_exit'
            }

            // ── LLM 调用（含重试） ──
            const compactLevelRef = {value: this.compactLevel}
            const llmResult = yield* executeLlmCallWithRetry({
                llmCaller: this.llmCaller,
                state: currentState,
                systemPrompt,
                commandTemplate,
                availableToolDefinitions,
                modelConfig: selection.modelConfig,
                workModeRole: selection.suggestedRole,
                schemeName: selection.schemeName,
                getSettings,
                params,
                isCompactCommand,
                turns: turnCount,
                compactLevelRef,
            })
            this.compactLevel = compactLevelRef.value

            if (abortSignal?.aborted) return 'early_exit'
            if (llmResult === null) return 'early_exit'

            const {
                assistantContent, assistantThinking, assistantThinkingSignature,
                assistantReasoningContent, collectedToolCalls, plannedCommands,
                inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
                reasoningTokens, llmDuration,
                currentProvider, currentModel, currentSchemeName,
            } = llmResult

            // ── 记录 API 返回的实际 inputTokens ──
            if (inputTokens > 0) {
                this.lastActualInputTokens = inputTokens
                this.messagesAtLLMCall = currentState.messages.length
            }

            // ── 发送 LLM 调用完成事件 ──
            yield* emitLlmCallDone(
                turnCount, currentState, lastLoggedMsgCount,
                assistantContent, collectedToolCalls,
                conversationTitle ?? '',
                currentSchemeName || currentProvider, currentModel,
                inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
                reasoningTokens, llmDuration, systemPrompt,
            )
            lastLoggedMsgCount = currentState.messages.length

            // ── 将 assistant 消息加入状态 ──
            currentState = addMessage(
                currentState,
                createAssistantMessage(
                    assistantContent, collectedToolCalls, plannedCommands,
                    {
                        provider: currentSchemeName || currentProvider,
                        model: currentModel,
                        duration: llmDuration,
                        inputTokens,
                        outputTokens,
                        cacheReadTokens: cacheReadTokens > 0 ? cacheReadTokens : undefined,
                        cacheWriteTokens: cacheWriteTokens > 0 ? cacheWriteTokens : undefined,
                        reasoningTokens: reasoningTokens > 0 ? reasoningTokens : undefined,
                    },
                    assistantThinking || undefined,
                    assistantThinkingSignature || undefined,
                    selection.suggestedRole === 'reasoning'
                        ? assistantReasoningContent
                        : (assistantReasoningContent || undefined),
                ),
            )

            // ── 没有工具调用 → 检查是否有待注入消息 ──
            if (collectedToolCalls.length === 0) {
                // 退出前检查是否有正在待注入的用户消息，避免消息滞留
                // 如果用户在 LLM 调用期间插入了消息，而此时 LLM 返回无工具调用，
                // 直接退出会导致 pendingInjectedMessages 中的消息永远无法被消费
                const pendingMsgs = params.pendingInjectedMessages
                if (pendingMsgs && pendingMsgs.length > 0) {
                    logger.info(`[AgentLoop] 检测到 ${pendingMsgs.length} 条待注入消息，不退出循环`, {
                        firstContent: getMessagePreview(pendingMsgs[0]),
                    })
                    endTurnCleanup()
                    continue
                }
                yield* handleNoToolCalls(assistantContent, assistantThinking, assistantReasoningContent, this.turns)
                return 'early_exit'
            }

            // ── 执行工具调用 ──
            const toolResult = yield* executeToolCalls({
                toolExecutor: this.toolExecutor,
                collectedToolCalls,
                state: currentState,
                workingDir,
                abortSignal,
                requestConfirmation,
                askUserQuestion,
                channelSend,
                onEvent,
            })
            currentState = toolResult.state
            for (const event of toolResult.events) yield event

            // ── 从 tool result 提取媒体文件 ──
            currentState = extractMediaFromToolResults(currentState)

            // ── 自动触发压缩 ──
            currentState = yield* autoCompressIfNeeded({
                state: currentState,
                systemPrompt,
                isCompactCommand,
                params,
                lastActualInputTokens: this.lastActualInputTokens,
                messagesAtLLMCall: this.messagesAtLLMCall,
                compactLevelRef,
            })
            this.compactLevel = compactLevelRef.value

            // Turn 结束
            logger.debug(`[AgentLoop] end turn ${this.turns} reason:tool_calls_executed`)
            endTurnCleanup()
        }

        // Agent Loop 结束
        logger.info(`[AgentLoop] agent loop ended, turns:${this.turns}`)
        return 'max_turns'
    }
}

// Re-export for backward compatibility
export function isContextLengthError(error: any): boolean {
    return checkContextLengthError(error)
}
