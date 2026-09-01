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
 */

import type {AgentStreamEvent} from '../stream'
import type {LoopState as AgentLoopState} from '../state'
import type {CommandExecutionContext} from '@shared/types'

import {LLMCaller} from './llmCaller'
import {ToolExecutor} from './toolExecutor'
import {addMessage, createAssistantMessage} from '../state'
import {logger} from '../logger'
import {extractTextContent, getMessagePreview} from '../utils/contentUtils'
import {formatYmd, isCacheStale} from '../utils/dateUtils'
import {permissionRulesManager} from '../permissions/permissionRule'
import type {IConversationRepository} from '../../repositories/interfaces'
import {createConversationRepository} from '../../repositories'
import {randomUUID} from 'crypto'
import type {Message} from '@shared/types'
import {SOURCE_KIND_COMMAND_TASK} from '@shared/types'

import type {RunParams, MainLoopExitReason, ControllerState} from './types'
import {endTurnCleanup} from './helpers'
import {initializeRunEnvironment, detectCommandContext, selectModelForTurn, defaultRoleForTrace, filterTools, filterToolsForDegrade, buildSystemPrompt} from './setup'
import {executeLlmCallWithRetry, executeToolCalls, extractMediaFromToolResults} from './execute'
import {PreprocessCache} from './preprocessCache'
import {LoopDetector, buildTurnToolCalls, isLoopPatternSilenced, type LoopVerdict} from './loopDetector'
import {restoreCatalogState, runCatalogPreStep, type CatalogState} from './catalogPublish'
import {buildCommandTaskContent} from '../utils/userContentBuilder'
// ─── LLM 调用事件与工具方法（内联自历史 compress.ts） ───
import type {ChatMessage} from '../model/types'

/**
 * 发射 llm_call_done 事件（含输入输出摘要）
 */
function* emitLlmCallDone(
    turnCount: number,
    state: AgentLoopState,
    lastLoggedMsgCount: number,
    assistantContent: string,
    collectedToolCalls: Array<{id: string; name: string; arguments: Record<string, unknown>}>,
    conversationTitle: string,
    provider: string,
    providerType: string,   // 新增：精确服务商类型
    providerName: string,   // 新增：providers 表服务商名（人类可读）
    providerId: string | undefined,   // providers.id（稳定维度，llm_usage 精确归因）
    model: string,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens: number,
    cacheWriteTokens: number,
    reasoningTokens: number,
    ttftMs: number | undefined,
    decodeMs: number | undefined,
    tokensPerSecond: number | undefined,
    llmDuration: number,
    systemPrompt: string,
): Generator<AgentStreamEvent, void> {
    let inputContent = ''
    if (turnCount === 1) {
        const lastUserMsg = getLastUserMessage(state)
        inputContent = lastUserMsg ? extractTextContent(lastUserMsg.content) : ''
    } else {
        const newMessages = state.messages.slice(lastLoggedMsgCount)
        const toolNameMap = new Map<string, string>()
        for (const msg of state.messages) {
            if (msg.role === 'assistant' && msg.toolCalls) {
                for (const tc of msg.toolCalls) {
                    toolNameMap.set(tc.id, tc.name)
                }
            }
        }
        const toolResults = newMessages
            .filter(m => m.role === 'tool')
            .map(m => {
                const toolName = m.toolCallId ? (toolNameMap.get(m.toolCallId) || 'unknown') : 'unknown'
                const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
                return `[tool result: ${toolName}]\n${content.slice(0, 300)}`
            })
            .join('\n\n')
        inputContent = toolResults || '(no new context)'
    }

    let outputContent = assistantContent
    if (collectedToolCalls.length > 0) {
        const toolInfo = collectedToolCalls
            .map(tc => `[tool: ${tc.name}] ${JSON.stringify(tc.arguments).slice(0, 200)}`)
            .join('\n')
        outputContent = assistantContent
            ? `${assistantContent}\n\n--- tool calls ---\n${toolInfo}`
            : `--- tool calls ---\n${toolInfo}`
    }

    const toolCallsInfo = collectedToolCalls.map(tc => ({
        id: tc.id,
        name: tc.name,
        input: tc.arguments,
    }))

    const recentMessages = state.messages.slice(lastLoggedMsgCount).map(msg => {
        const result: {
            role: string
            content: string
            toolCalls?: Array<{id: string; name: string; arguments: Record<string, unknown>}>
            toolCallId?: string
            toolResult?: string
        } = {
            role: msg.role,
            content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        }
        if (msg.role === 'assistant' && msg.toolCalls) {
            result.toolCalls = msg.toolCalls.map(tc => ({
                id: tc.id,
                name: tc.name,
                arguments: tc.arguments,
            }))
        }
        if (msg.role === 'tool') {
            result.toolCallId = msg.toolCallId
            result.toolResult = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
        }
        return result
    })

    yield {
        type: 'llm_call_done',
        conversationTitle,
        provider,
        providerType,   // 新增
        providerName,   // 新增
        providerId,   // providers.id（稳定维度）
        model,
        duration: llmDuration,
        inputTokens,
        outputTokens,
        cacheReadTokens: cacheReadTokens > 0 ? cacheReadTokens : undefined,
        cacheWriteTokens: cacheWriteTokens > 0 ? cacheWriteTokens : undefined,
        reasoningTokens: reasoningTokens > 0 ? reasoningTokens : undefined,
        ttftMs,
        decodeMs,
        tokensPerSecond,
        inputContent: inputContent.slice(0, 500),
        outputContent: outputContent.slice(0, 2000),
        toolCalls: toolCallsInfo,
        messages: recentMessages,
        systemPrompt,
    }
}

/**
 * 处理 LLM 未发起工具调用的情况
 */
function* handleNoToolCalls(
    assistantContent: string,
    assistantThinking: string,
    assistantReasoningContent: string,
    turns: number,
): Generator<AgentStreamEvent, void> {
    if (!assistantContent && !assistantThinking && !assistantReasoningContent) {
        logger.warn(`[AgentLoop] LLM 返回了空响应（无文本、无思考内容、无工具调用）`)
    }

    logger.debug(`[AgentLoop] end turn ${turns} reason:no_tool_calls`)
    logger.info(`[AgentLoop] loop done turns:${turns} reason:completed`)
    yield {type: 'done', reason: 'completed'}
    endTurnCleanup()
}

/** 获取最后一条用户消息 */
function getLastUserMessage(state: AgentLoopState): ChatMessage | null {
    return state.messages && state.messages.length > 0
        ? [...state.messages].reverse().find(m => m.role === 'user') ?? null
        : null
}

// ─── 缓存载荷类型 ────────────────────────────────────────

/**
 * 缓存载荷 commandId 跨轮携带：本轮有新命令用新值，否则沿用缓存值。
 * 用途：后续普通轮从缓存恢复 agentDefinition（工具集一致性，见 execution.ts）。
 */
export function carryForwardCommandId(
    commandContext: {commandId: string} | null | undefined,
    cached: {commandId?: string | null} | null | undefined,
): string | null {
    return commandContext?.commandId ?? cached?.commandId ?? null
}

interface CachePayload {
    core: string
    /** 系统提示词构建日期（yyyy-MM-dd），用于跨天失效 */
    buildDate?: string
    /**
     * 产生当前 system prompt 的命令 ID（agent:/skill:/插件命令）。
     * agent: 命令轮的 agentDefinition 影响工具过滤；后续普通轮从该值恢复
     * agentDefinition，保证 tools 数组跨轮逐字节一致（否则 prompt cache 前缀
     * 在 tools 段断裂 → cached_tokens 归零），同时保持只读 Agent 的工具限制。
     */
    commandId?: string | null
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
    return { core: raw }
}

// Re-export for backward compatibility — 使用 controller.ts 导出引用
export {isVisionModel, sanitizeMessagesForModel} from './helpers'
export type {RunParams} from './types'

export class AgentLoopController {
    private ctrlState: ControllerState = 'idle'
    private turns = 0

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
        const {commandContext} = await detectCommandContext(params)

        // ── 阶段 3：计算最大轮数 ──
        const maxTurnsLimit = getSettings()?.agent?.maxTurns ?? params.agentDefinition?.maxTurns ?? params.maxTurns ?? 500

        // ── 阶段 4：主循环 ──
        const loopResult = yield* this.#mainLoop(
            params, state, commandContext, getSettings, workingDir, maxTurnsLimit,
        )

        // ── 阶段 5：收尾（仅 max_turns_reached / loop_detected 路径需要额外处理） ──
        if (loopResult === 'loop_detected') {
            // done(loop_detected) 已在 #mainLoop 检测门内发出，此处不重复 yield
            logger.info(`[AgentLoop] loop finish turns:${this.turns} reason:loop_detected`)
            this.ctrlState = 'done'
            return
        }
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
     * Agent 主循环：每轮执行模型选择 → 系统提示词 → LLM 调用 → 工具执行
     */
    async *#mainLoop(
        params: RunParams,
        state: AgentLoopState,
        commandContext: CommandExecutionContext | null,
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

        // ★ LLM 调用前 normalize 增量缓存
        const preprocessCache = new PreprocessCache()

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

        // ★ 能力目录状态：循环外初始化；从既有会话消息流还原（恢复会话零重复发布）
        let catalogState: CatalogState = restoreCatalogState(currentState.messages)

        // ★ CT 真实消息化（spec §3.2）：主循环前插入 state 并落库，轮内后续 LLM 调用从 state 自然读到。
        // 位置在 catalog pre-step 之前：assistant 行首建于首次内容落库（无占位行），CT 天然先于它们。
        if (commandContext) {
            const ctMessage: ChatMessage = {
                id: randomUUID(),
                role: 'user',
                content: buildCommandTaskContent(commandContext.commandTemplate),
                // ★ 内部机制消息标记：UI 层（MessageList）据此过滤，不渲染为气泡。
                //   metadata 不进发给 LLM 的 content 字节，仅用于读回后识别（与 catalog 的
                //   sourceKind 契约同构；messageBlockHelper 用 ...(msg.metadata) 透传持久化）。
                metadata: {sourceKind: SOURCE_KIND_COMMAND_TASK},
            }
            currentState = addMessage(currentState, ctMessage)
            if (conversationRepo && sessionId) {
                try {
                    conversationRepo.writeMessagesDelta(sessionId, {...ctMessage, timestamp: Date.now()} as unknown as Message)
                } catch (err) {
                    logger.debug('[AgentLoop] CT message persist failed (in-memory only)', {error: String(err)})
                }
            }
        }

        // ── LLM 循环检测：按档位初始化（off / 子 Agent 运行 → 不检测）──
        // 子 Agent 运行标识：modelRole 为 agentTool 子会话专用字段（grep agentTool.ts 确认，
        // 仅子 Agent 的 agentLoop 调用传入）；traceContext === 'subAgent' 同理。
        const ldMode = getSettings()?.agent?.loopDetection?.mode ?? 'notify'
        const isSubagentRun = params.modelRole !== undefined || params.traceContext === 'subAgent'
        let detector: LoopDetector | null =
            (ldMode === 'off' || isSubagentRun)
                ? null
                : new LoopDetector(Math.max(2, getSettings()?.agent?.loopDetection?.threshold ?? 3))
        let lastVerdict: LoopVerdict | null = null
        let lastReportedFingerprint: string | null = null
        let lastEscalationReported = false
        let lastVerdictSilenced = false

        while (turnCount < maxTurnsLimit) {
            // ── 检查中止信号 ──
            if (abortSignal?.aborted) {
                logger.info(`[AgentLoop] loop done turns:${turnCount} reason:aborted`)
                yield {type: 'done', reason: 'aborted'}
                return 'early_exit'
            }

            // ── LLM 循环检测门：上一轮记录的签名达到触发条件时按档位处理 ──
            if (detector && lastVerdict) {
                // 消费主进程经 worker 传入的静默指纹（渲染端"这是误判"）
                let fp: string | undefined
                while (params.pendingSilences && params.pendingSilences.length > 0 && (fp = params.pendingSilences.shift()) !== undefined) {
                    detector.silence(fp)
                }
                const mode = getSettings()?.agent?.loopDetection?.mode ?? 'notify'
                // 渠道等无 askUserQuestion 回调时 pause 降级 notify
                const canPause = mode === 'pause' && typeof params.askUserQuestion === 'function'
                const silenced = lastVerdictSilenced || detector.isSilenced(lastVerdict.fingerprint)
                if (!silenced && mode !== 'off') {
                    if (canPause) {
                        const isEscalation = lastReportedFingerprint === lastVerdict.fingerprint
                            && detector.isEscalationReached(lastVerdict.fingerprint)
                        if (!lastReportedFingerprint || isEscalation) {
                            const answer = await params.askUserQuestion?.(
                                `检测到 Agent 可能陷入重复循环（${lastVerdict.kind === 'consecutive' ? '连续' : '周期'} ${lastVerdict.repeatCount} 轮执行了相同的工具调用并得到相同结果）。为避免打扰，任务已暂停。如果这是误判，抱歉打扰了您——您可以在 系统设置 → LLM循环检测 中调整档位或关闭此功能。`,
                                ['继续一轮', '终止 loop', '本会话不再提示'],
                            )
                            if (answer === '终止 loop') {
                                logger.info(`[AgentLoop] loop terminated by user via loop detection, turns:${turnCount}`)
                                yield {type: 'done', reason: 'loop_detected'} as AgentStreamEvent
                                endTurnCleanup()
                                return 'loop_detected'
                            }
                            if (answer === '本会话不再提示') {
                                detector.silence(lastVerdict.fingerprint)   // worker 内模块状态，本 worker 存续期内有效
                            }
                            lastReportedFingerprint = lastVerdict.fingerprint
                        }
                    } else {
                        // notify 档（含 pause 无 askUserQuestion 的降级路径）
                        const threshold = Math.max(2, getSettings()?.agent?.loopDetection?.threshold ?? 3)
                        if (lastReportedFingerprint !== lastVerdict.fingerprint) lastEscalationReported = false   // 新模式重置升级标记
                        const escalated = lastReportedFingerprint === lastVerdict.fingerprint
                            && detector.isEscalationReached(lastVerdict.fingerprint) && !lastEscalationReported
                        if (!lastReportedFingerprint || escalated) {
                            yield {
                                type: escalated ? 'loop_escalated' : 'loop_suspected',
                                fingerprint: lastVerdict.fingerprint,
                                kind: lastVerdict.kind,
                                repeatCount: lastVerdict.repeatCount,
                                threshold,
                                detail: lastVerdict.detail,
                            } as AgentStreamEvent
                            if (escalated) lastEscalationReported = true
                            lastReportedFingerprint = lastVerdict.fingerprint
                        }
                    }
                }
                lastVerdict = null; lastVerdictSilenced = false
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

            // ── 选择模型（显式 modelRole → 会话 override → 默认角色降级链）──
            // 子会话（agentTool，traceContext='subAgent'）未显式指定 modelRole 时默认轻量模型
            // 子会话（agentTool，traceContext='subAgent'）未显式指定 modelRole 时默认轻量模型
            const selection = yield* selectModelForTurn(schemeConfig, sessionId, params.modelRole, defaultRoleForTrace(params.traceContext))

            // ── 过滤工具列表 ──
            const agentType = (agentTypeParam ?? params.agentType) || 'General'
            // ★ 400 降级恢复用：能力过滤前、白名单后的完整列表（含 analyze_image，已过 agent 白名单）
            const preCapabilityToolDefinitions = await filterToolsForDegrade(agentDefinition, agentType)
            const availableToolDefinitions = await filterTools(
                agentDefinition, agentType, selection.modelConfig.model, preCapabilityToolDefinitions,
            )
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
                providerName: selection.providerName,
                providerId: selection.providerId,
                tools: availableToolDefinitions.map(t => t.name),
            }

            // ── 能力目录发布（pre-step）：digest 变化时发布/原地替换 catalog 消息 ──
            {
                const fullDescriptions = getSettings()?.fullSkillDescriptions ?? false
                const r = runCatalogPreStep(currentState, catalogState, conversationRepo, sessionId, fullDescriptions)
                currentState = r.state
                catalogState = r.catalogState
            }

            // ── 构建系统提示词 ──
            const sysPromptContext = await permissionRulesManager.getContext()
            const currentPermissionMode = sysPromptContext.mode

            // ★ 解析 DB 缓存 JSON（兼容旧格式纯字符串）
            const cached = safeParseCache(cachedSystemPrompt)
            const cachedCore = cached?.core ?? null

            // ★ 缓存跨天失效：构建日期不是今天（或无 buildDate 的旧缓存）→ 强制重建
            const today = formatYmd()
            const cacheStale = isCacheStale(cached?.buildDate, today)

            const systemPrompt = await buildSystemPrompt({
                commandContext,
                agentDefinition,
                workingDir,
                availableToolDefinitions,
                currentPermissionMode,
                customInstructions,
                agentType,
                agentTemplates,
                cachedSystemPrompt: cacheStale ? null : cachedCore,
            })

            // ★ 构建新的缓存载荷（JSON 格式）
            // commandId 跨轮携带：无新命令时沿用缓存中的值，保证后续普通轮
            // 能从 execution.ts 恢复 agentDefinition（工具集一致性）
            const newCachePayload = JSON.stringify({
                core: systemPrompt,
                buildDate: today,
                commandId: carryForwardCommandId(commandContext, cached),
            })

            // ★ 缓存未命中时写入 DB（不阻塞主流程）
            if (conversationRepo && newCachePayload !== cachedSystemPrompt) {
                conversationRepo.setSystemPrompt(sessionId!, newCachePayload)
                cachedSystemPrompt = newCachePayload
            }

            // ── LLM 调用（含重试） ──
            const llmResult = yield* executeLlmCallWithRetry({
                llmCaller: this.llmCaller,
                state: currentState,
                systemPrompt,
                availableToolDefinitions,
                preCapabilityToolDefinitions,
                modelConfig: selection.modelConfig,
                workModeRole: selection.suggestedRole,
                schemeName: selection.schemeName,
                getSettings,
                params,
                turns: turnCount,
                preprocessCache,
                directModel: selection.directModel,
            })

            if (abortSignal?.aborted) return 'early_exit'
            if (llmResult === null) return 'early_exit'

            const {
                assistantContent, assistantThinking, assistantThinkingSignature,
                assistantReasoningContent, collectedToolCalls, plannedCommands,
                inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
                reasoningTokens, llmDuration,
                ttftMs, decodeMs, tokensPerSecond,
                currentProvider, currentModel, currentSchemeName, providerName, providerId,
                handoffRequested,
            } = llmResult

            // ── 发送 LLM 调用完成事件 ──
            yield* emitLlmCallDone(
                turnCount, currentState, lastLoggedMsgCount,
                assistantContent, collectedToolCalls,
                conversationTitle ?? '',
                currentSchemeName || currentProvider, currentProvider, providerName, providerId, currentModel,
                inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
                reasoningTokens, ttftMs, decodeMs, tokensPerSecond, llmDuration, systemPrompt,
            )
            lastLoggedMsgCount = currentState.messages.length

            // ── 将 assistant 消息加入状态 ──
            currentState = addMessage(
                currentState,
                createAssistantMessage(
                    assistantContent, collectedToolCalls, plannedCommands,
                    undefined,
                    // llmStats 不再随消息落库（B1：llm_usage 唯一源，Message.llmStats 由读取层组装）
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
                sessionId,
                // 运行时白名单：与发送给 LLM 的 tools 定义一致，拦截幻觉调用。
                // 并入 preCapabilityToolDefinitions：400 降级重试时 LLM 实际收到的是
                // 该列表（多出 analyze_image），降级后的合法调用不应被误拦。
                allowedToolNames: new Set([
                    ...availableToolDefinitions.map(t => t.name),
                    ...preCapabilityToolDefinitions.map(t => t.name),
                ]),
            })
            currentState = toolResult.state
            for (const event of toolResult.events) yield event

            // ── 从 tool result 提取媒体文件 ──
            currentState = extractMediaFromToolResults(currentState)

            // ── LLM 循环检测：记录本轮工具签名 ──
            if (detector) {
                const v = detector.recordTurn(buildTurnToolCalls(currentState.messages as any))
                if (v && !isLoopPatternSilenced(sessionId ?? '', v.fingerprint)) {
                    lastVerdict = v; lastVerdictSilenced = false
                } else if (v) {
                    lastVerdict = v; lastVerdictSilenced = true
                }
            }

            // ── mid-loop 交接门：auto-handoff 注入后，工具执行完成即强制结束本轮 ──
            // 无论模型是否成功调用 session_handoff，都不进入下一轮，防止交接门反复命中导致重复注入死循环。
            if (handoffRequested) {
                logger.info(`[AgentLoop] mid-loop handoff requested, force ending turn ${this.turns}`)
                endTurnCleanup()
                return 'early_exit'
            }

            // Turn 结束
            logger.debug(`[AgentLoop] end turn ${this.turns} reason:tool_calls_executed`)
            endTurnCleanup()
        }

        // Agent Loop 结束
        logger.info(`[AgentLoop] agent loop ended, turns:${this.turns}`)
        return 'max_turns'
    }
}
