/**
 * 子会话消息累积器 — 主进程侧构建子 Agent 的完整执行过程消息
 *
 * 背景：子会话的持久化由主进程 agentTool 负责（渲染进程 isChildConversation 跳过落库，
 * 防幽灵重复气泡）。此前 agentTool 仅在子 Agent 完成时写入一条最终输出摘要，
 * 导致子会话 SQLite 中丢失思考过程 / 工具调用等完整执行记录（切换会话或刷新后不可回溯）。
 *
 * 本模块在 agentTool 的事件循环中把子 Agent 的**单次运行**累积为「一条」assistant 消息
 * （与主会话同构：一次 agent 运行 = 一条消息，contentBlocks 按时间序记录思考/文本/工具调用）：
 * - 消息 id 为 msg-<ts>-<rand>（与主会话 assistant 消息同格式）；同一子会话内用户二次发指令
 *   会开启新的 agent 运行（新 id），与主会话多轮交互行为一致
 * - tool_result（该轮工具全部完成）/ llm_call_done 时机增量 UPSERT 同一条消息（频率受轮次限制）
 * - done / error 时最终写入（附加 endedAt，错误信息并入正文尾部）
 *
 * 消息结构与主会话一致（contentBlocks 结构，复用 messageToBlocks / blocksToMessage），
 * UI 渲染复用同一管线，无需改动。子会话侧栏显示为「1 条指令 + 1 条助手消息」。
 */

import type {AgentStreamEvent} from '../../stream'
import type {ContentBlock, LlmStats, Message, ToolCall} from '@shared/types'

// ─── 累积器状态 ──────────────────────────────────────────

/** 流式块（复刻渲染进程 streamBlocks 结构，按 textOffset 与文本交错） */
interface StreamBlock {
    type: 'think' | 'tool_use'
    id: string
    /** 该块在正文流中的锚点位置（= 声明时 textContent 长度） */
    textOffset: number
    /** think 块内容（连续 thinking 事件拼接） */
    thinkContent?: string
    /** tool_use 块对应的工具调用（与 toolCalls map 同一引用，result 更新自动反映） */
    toolCall?: ToolCall
    timestamp: number
}

export interface ChildConvAccumulator {
    /** 本次运行的 assistant 消息 id（msg-<ts>-<rand>，与主会话 assistant 消息同格式）。
     *  一次子 Agent 运行 = 一条消息；同一子会话内用户二次发指令会开启新的 agent 运行，
     *  生成新的 id（不覆盖旧消息），与主会话的多轮交互行为一致。 */
    assistantMsgId: string
    /** 全部轮次正文（text 事件累积） */
    textContent: string
    /** 全部轮次的流式块（think / tool_use，按事件序累积） */
    blocks: StreamBlock[]
    /** 全部轮次的工具调用（tool_use / tool_start / tool_result 关联） */
    toolCalls: Map<string, ToolCall>
    /** 当前轮已声明但未收到 tool_result 的工具数（=0 时该轮工具全部完成，可增量落库） */
    pendingToolCount: number
    /** 全部轮次的 llmStats（llm_call_done 时写入，随单条消息持久化） */
    llmStats: LlmStats[]
    /** 是否已发生错误 */
    hasError: boolean
    /** 错误信息 */
    errorMsg: string
}

export function createChildConvAccumulator(_convId?: string): ChildConvAccumulator {
    const now = Date.now()
    return {
        assistantMsgId: `msg-${now}-${Math.random().toString(36).slice(2, 8)}`,
        textContent: '',
        blocks: [],
        toolCalls: new Map(),
        pendingToolCount: 0,
        llmStats: [],
        hasError: false,
        errorMsg: '',
    }
}

// ─── 消息构建 ────────────────────────────────────────────

/**
 * 从累积器构建完整 assistant 消息（单条，含至今全部轮次）。
 * contentBlocks 按 textOffset 交错：think / text / tool_use 保持时间序。
 * 仅当存在有效内容（思考/文本/工具调用/llmStats）时返回非 null。
 */
export function buildCurrentMessage(acc: ChildConvAccumulator, now: number): Message | null {
    const blocks: ContentBlock[] = []
    const toolCalls: ToolCall[] = []

    const sortedBlocks = [...acc.blocks].sort(
        (a, b) => (a.textOffset - b.textOffset) || (a.timestamp - b.timestamp),
    )
    let cursor = 0
    for (const sb of sortedBlocks) {
        if (sb.textOffset > cursor) {
            const slice = acc.textContent.slice(cursor, sb.textOffset)
            if (slice) blocks.push({id: `text-${sb.id}`, type: 'text', text: slice})
        }
        if (sb.type === 'think') {
            blocks.push({
                id: sb.id,
                type: 'think',
                thinkBlock: {
                    id: sb.id,
                    content: sb.thinkContent || '',
                    status: 'complete',
                    timestamp: sb.timestamp,
                },
            })
        } else {
            const tc = acc.toolCalls.get(sb.id) || sb.toolCall
            if (tc) {
                blocks.push({id: `tool-${sb.id}`, type: 'tool_use', toolCall: tc})
                toolCalls.push(tc)
            }
        }
        cursor = sb.textOffset
    }
    if (cursor < acc.textContent.length) {
        const rest = acc.textContent.slice(cursor)
        if (rest) blocks.push({id: `text-tail-${now}`, type: 'text', text: rest})
    }

    if (blocks.length === 0 && acc.llmStats.length === 0) return null

    const msg: Message = {
        id: acc.assistantMsgId,
        role: 'assistant',
        content: acc.textContent,
        timestamp: now,
    }
    if (toolCalls.length > 0) msg.toolCalls = toolCalls
    if (blocks.length > 0) msg.contentBlocks = blocks
    if (acc.llmStats.length > 0) msg.llmStats = [...acc.llmStats]
    return msg
}

// ─── 事件处理 ────────────────────────────────────────────

/**
 * 处理单个流事件，更新累积器状态。
 * 返回当前轮次是否"完成"（调用方应在该时机增量落库）。
 */
export function handleChildEvent(acc: ChildConvAccumulator, event: AgentStreamEvent): boolean {
    switch (event.type) {
        case 'text': {
            acc.textContent += event.content || ''
            return false
        }

        case 'thinking': {
            const lastBlock = acc.blocks.length > 0 ? acc.blocks[acc.blocks.length - 1] : null
            if (lastBlock?.type === 'think') {
                // 连续思考块拼接（与渲染进程 handleThinking 一致）
                lastBlock.thinkContent = (lastBlock.thinkContent || '') + (event.content || '')
            } else {
                acc.blocks.push({
                    type: 'think',
                    id: `think-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                    textOffset: acc.textContent.length,
                    thinkContent: event.content || '',
                    timestamp: Date.now(),
                })
            }
            return false
        }

        case 'tool_use': {
            const tc = event.toolCall
            if (!tc?.id) return false
            return addToolBlock(acc, tc)
        }

        case 'tool_start': {
            const tc = event.toolCall
            if (!tc?.id) return false
            const existing = acc.toolCalls.get(tc.id)
            if (existing) {
                existing.status = 'running'
                existing.reason = tc.reason ?? existing.reason
                return false
            }
            return addToolBlock(acc, tc)
        }

        case 'tool_progress': {
            const existing = acc.toolCalls.get(event.toolCallId)
            if (existing) existing.progress = event.progress
            return false
        }

        case 'tool_result': {
            const existing = acc.toolCalls.get(event.toolCallId)
            if (existing) {
                existing.status = event.result?.error ? 'error' : 'success'
                existing.result = {
                    output: event.result?.output || '',
                    error: event.result?.error,
                    _meta: (event.result as {_meta?: Record<string, unknown>})?._meta,
                }
                if (event.skillName) existing.skillName = event.skillName
                acc.pendingToolCount = Math.max(0, acc.pendingToolCount - 1)
            }
            // 该轮全部工具完成 → 轮次结束，标记增量落库时机
            return acc.pendingToolCount === 0
        }

        case 'llm_call_done': {
            acc.llmStats.push({
                inputTokens: event.inputTokens,
                outputTokens: event.outputTokens,
                provider: event.provider,
                model: event.model,
                duration: event.duration,
                cacheReadTokens: event.cacheReadTokens,
                cacheWriteTokens: event.cacheWriteTokens,
                reasoningTokens: event.reasoningTokens,
            })
            // LLM 调用完成 → 该轮输出完毕，标记增量落库时机
            return true
        }

        case 'error': {
            acc.hasError = true
            acc.errorMsg = event.error || '未知错误'
            return true
        }

        default:
            return false
    }
}

/** 注册一个工具块（tool_use / 首次 tool_start），返回 false（不触发落库） */
function addToolBlock(acc: ChildConvAccumulator, tc: {id: string; name: string; arguments?: Record<string, unknown>; reason?: string}): false {
    const offset = acc.textContent.length
    const toolCall: ToolCall = {
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments || {},
        reason: tc.reason,
        status: 'pending',
        textOffset: offset,
    }
    acc.toolCalls.set(tc.id, toolCall)
    acc.blocks.push({type: 'tool_use', id: tc.id, textOffset: offset, toolCall, timestamp: Date.now()})
    acc.pendingToolCount++
    return false
}

// ─── 落库辅助 ────────────────────────────────────────────

/**
 * 将累积器的完整消息写入 SQLite（UPSERT 语义，固定 id，不触碰其他消息）。
 * 写入后**不重置**累积状态——后续轮次继续追加到同一条消息，下次落库覆盖更新。
 *
 * @param final - 是否为最终写入（done/error）：附加 endedAt；空累积时生成占位消息
 */
export function flushAccumulatorMessage(
    acc: ChildConvAccumulator,
    repo: { writeMessages(convId: string, messages: Message[]): boolean },
    convId: string,
    final: boolean,
): void {
    const now = Date.now()
    let msg = buildCurrentMessage(acc, now)

    if (!msg && final) {
        // 最终兜底：空累积也写一条占位（避免子会话无 assistant 记录）
        msg = {
            id: acc.assistantMsgId,
            role: 'assistant',
            content: acc.textContent || (acc.hasError ? `执行失败: ${acc.errorMsg}` : '(无输出)'),
            timestamp: now,
        }
        if (acc.llmStats.length > 0) msg.llmStats = [...acc.llmStats]
    }

    if (!msg) return

    if (final) {
        msg.endedAt = now
        // 错误信息并入正文尾部（保持单条消息，便于子会话回溯失败原因）
        if (acc.hasError && acc.errorMsg && !msg.content.includes('执行失败')) {
            msg.content = msg.content + `\n\n> ⚠️ **执行失败**: ${acc.errorMsg}`
        }
    }

    repo.writeMessages(convId, [msg])

    // 工具轮次计数重置（下一轮工具声明重新计数）；内容持续累积不重置
    acc.pendingToolCount = 0
}

/**
 * 子 Agent 完成时的最终落库（done / error）。
 */
export function finalizeChildConv(
    acc: ChildConvAccumulator,
    repo: { writeMessages(convId: string, messages: Message[]): boolean },
    convId: string,
): void {
    flushAccumulatorMessage(acc, repo, convId, true)
}
