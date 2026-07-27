/**
 * 结构感知截断 — agent loop 专用
 *
 * 设计目标：在保证 LLM 看到的 messages 结构完整的前提下，
 * 从中间安全地裁掉冗余历史。
 *
 * 保留规则：
 *   1. 永远保留**最早一条 user 消息**及其前的 system 前缀（任务目标锚点）
 *   2. 永远保留**最近 N 轮对话**（最近上下文）
 *   3. 中间区间：纯文本轮整轮丢弃；低价值工具轮整轮丢弃；混合轮配对剥离 + 工具价值剥离
 *
 * v3「配对剥离」语义（决策 2026-01-B-深化）：
 *   混合轮内若有多个 toolCall，其中部分失败：
 *     - 失败的 toolCall 必须从 assistant.toolCalls 里移除
 *     - 对应的失败 tool 消息也必须移除
 *     - 避免 LLM 看到「孤立 tool_use 没结果」
 *     - 仅保留成功 toolCall 配对的 tool_use + tool_result
 *   全部失败的 turn → 当作纯文本 turn 丢
 *
 * v4「工具价值剥离」语义（决策 2026-12）：
 *   中间区间（最近 N 轮之前的历史）中：
 *     - 仅 5 类高价值工具保留：file_read / file_write / file_edit / ask_user / bash
 *     - 低价值工具的 tool 消息从 assistant.toolCalls 和消息序列中剔除
 *     - assistant 正文（纯文本推理）剥离，仅留 toolCalls 和 tool 消息
 *     - 纯低价值工具轮（无高价值工具）整轮丢弃
 *     - 最近 N 轮和第一轮不受影响
 *
 * 调用时机：每次 LLM 调用前，预算超出后调用本函数收敛到预算内。
 */

import type {ChatMessage} from '../model/types'

/** 默认高价值工具列表（v4）— 低价值工具指不在该列表中的所有工具 */
const DEFAULT_HIGH_VALUE_TOOL_NAMES = new Set([
    'file_read', 'file_write', 'file_edit', 'ask_user', 'bash',
])

/** 一轮对话的边界 — 一个 user 消息 + 后续 assistant/tool 消息，直到下一个 user 或结尾 */
export interface TurnBoundary {
    /** 该轮首个 user 消息在原数组中的索引（system 前缀归入 0 号 turn 的 startIdx） */
    startIdx: number
    /** 该轮结束索引（不含），用于切片 */
    endIdx: number
    /** 该 turn 是否含至少一个成功的工具调用 */
    hasToolCalls: boolean
    /**
     * 该 turn 是否含至少一个成功的高价值工具调用（v4）。
     * 仅对中间区间判断有意义；第一轮和最近 N 轮不依赖此字段。
     */
    hasHighValueToolCalls: boolean
    /**
     * v3：剥离后的 turn 内容（仅混合轮有值）。
     *   undefined → 纯文本 turn，按原 startIdx/endIdx 切片即可
     *   ChatMessage[] → 混合 turn，调用方应使用此数组替换原 turn 内容
     *
     * 剥离规则：
     *   - 失败的 toolCallId 不出现在任何 assistant.toolCalls 里
     *   - 失败的 toolCallId 对应的 tool 消息被剔除
     *   - 若剥离后 assistant 没有 toolCalls 了，仍保留 assistant 消息（content 有价值）
     */
    mixedTurnKept?: ChatMessage[]
}

/** 结构感知截断结果 */
export interface StructuredTruncationResult {
    messages: ChatMessage[]
    /** 截断后保留的 message 数 */
    afterCount: number
    /** 中间丢弃的 turn 数 */
    droppedTurns: number
}

export interface StructuredTruncationOptions {
    /** 保留最近几轮（默认 7） */
    keepRecentTurns?: number
    /** 高价值工具名称集合（v4 默认值：file_read/file_write/file_edit/ask_user/bash） */
    highValueToolNames?: Set<string>
    /** 是否剥离中间区间 assistant 正文（默认 true） */
    stripAssistantContent?: boolean
}

/**
 * 切分 messages 为轮（turn）数组。
 *
 * hasToolCalls 定义：turn 内存在至少一个成功的工具调用 — 即：
 *   - assistant 消息有 toolCalls
 *   - 且其中至少 1 个 toolCallId 对应的 tool 消息存在且 isError !== true
 *
 * hasHighValueToolCalls 定义（v4）：
 *   turn 内存在至少一个成功的高价值工具调用（名称在 highValueNames 内）。
 *
 * mixedTurnKept 定义（v3 配对剥离）：
 *   当该 turn 有至少 1 个成功 toolCall 但也有失败 toolCall 时，
 *   返回剥离后的 ChatMessage[]（剔除失败 toolCall 的 tool_use 和 tool_result）。
 *   纯文本 turn 或全部成功的 turn 不设置此字段。
 *
 * 规则：
 * - 第一个 user 消息之前的消息（system 等）归入第一个 turn
 * - 一个 turn 以 user 消息开始，到下一个 user 消息前结束
 * - 若整数组无 user 消息，单独算一个 turn
 * - 若数组为空，返回空数组
 */
export function splitIntoTurns(
    messages: ChatMessage[],
    highValueNames?: Set<string>,
): TurnBoundary[] {
    const hvNames = highValueNames ?? DEFAULT_HIGH_VALUE_TOOL_NAMES

    // 第一轮：从 0 开始，到第一个 user 消息为止
    const firstUserIdx = messages.findIndex(m => m.role === 'user')

    // 数组为空或无 user 消息：整数组视为一个 turn
    if (firstUserIdx === -1) {
        if (messages.length === 0) return []
        return [{startIdx: 0, endIdx: messages.length, hasToolCalls: false, hasHighValueToolCalls: false}]
    }

    // 收集所有 user 消息索引
    const userIndices: number[] = []
    for (let i = firstUserIdx; i < messages.length; i++) {
        if (messages[i].role === 'user') userIndices.push(i)
    }

    return userIndices.map((userIdx, i) => {
        const startIdx = i === 0 ? 0 : userIdx
        const endIdx = i + 1 < userIndices.length ? userIndices[i + 1] : messages.length

        // 1. 收集该 turn 内所有 assistant.toolCallId
        const turnToolCallIds = new Set<string>()
        for (let j = startIdx; j < endIdx; j++) {
            const m = messages[j]
            if (m.role === 'assistant' && m.toolCalls) {
                for (const tc of m.toolCalls) turnToolCallIds.add(tc.id)
            }
        }

        // 2. 把每个 toolCallId 分类：成功 / 失败（看对应 tool 消息的 isError）
        const successIds = new Set<string>()
        const failedIds = new Set<string>()
        for (let j = startIdx; j < endIdx; j++) {
            const m = messages[j]
            if (m.role === 'tool' && m.toolCallId && turnToolCallIds.has(m.toolCallId)) {
                if (m.isError) failedIds.add(m.toolCallId)
                else successIds.add(m.toolCallId)
            }
        }

        // 2b (v4)：确认是否有成功的高价值工具调用
        let hasHighValue = false
        for (let j = startIdx; j < endIdx; j++) {
            const m = messages[j]
            if (m.role === 'assistant' && m.toolCalls) {
                for (const tc of m.toolCalls) {
                    if (successIds.has(tc.id) && hvNames.has(tc.name)) {
                        hasHighValue = true
                        break
                    }
                }
            }
            if (hasHighValue) break
        }

        // 3. 没有 assistant.toolCalls 的纯文本 turn
        if (turnToolCallIds.size === 0) {
            return {startIdx, endIdx, hasToolCalls: false, hasHighValueToolCalls: false}
        }

        // 4. 全部失败 → 当纯文本 turn 处理（hasToolCalls=false）
        if (successIds.size === 0) {
            return {startIdx, endIdx, hasToolCalls: false, hasHighValueToolCalls: false}
        }

        // 5. 至少 1 成功 — 混合 turn
        // 如果没有失败的，不需要 v3 剥离（mixedTurnKept 留空，让 caller 直接切片）
        if (failedIds.size === 0) {
            return {
                startIdx, endIdx,
                hasToolCalls: true,
                hasHighValueToolCalls: hasHighValue,
            }
        }

        // 6. 有成功也有失败 → v3 配对剥离
        const kept: ChatMessage[] = []
        for (let j = startIdx; j < endIdx; j++) {
            const m = messages[j]
            if (m.role === 'tool' && m.toolCallId && failedIds.has(m.toolCallId)) {
                continue  // 跳过失败 tool 消息
            }
            if (m.role === 'assistant' && m.toolCalls) {
                const cleaned = m.toolCalls.filter(tc => !failedIds.has(tc.id))
                if (cleaned.length === 0 && m.toolCalls.length > 0) {
                    // assistant 原含 toolCalls 但剥离后空了 → content 仍保留
                    kept.push({...m, toolCalls: undefined})
                } else {
                    kept.push({...m, toolCalls: cleaned})
                }
                continue
            }
            kept.push(m)
        }

        return {
            startIdx, endIdx,
            hasToolCalls: true,
            hasHighValueToolCalls: hasHighValue,
            mixedTurnKept: kept,
        }
    })
}

/**
 * v4 工具价值剥离：从 turn 中剔除低价值工具的相关消息。
 *
 * 输入：turn 内消息（已走完 v3 错误剥离）
 * 输出：仅保留高价值工具相关消息 + user 消息
 *
 * 剥离内容：
 *   1. 低价值工具对应的 tool 消息 → 跳过
 *   2. assistant.toolCalls 中移除低价值工具的 entry
 *   3. assistant.content 置空（stripAssistantContent=true 时）
 */
function applyV4Stripping(
    turnMessages: ChatMessage[],
    lowValueCallIds: Set<string>,
    stripContent: boolean,
): ChatMessage[] {
    const result: ChatMessage[] = []
    for (const m of turnMessages) {
        // 跳过低价值工具的 tool 消息
        if (m.role === 'tool' && m.toolCallId && lowValueCallIds.has(m.toolCallId)) {
            continue
        }
        // assistant 消息：清理 toolCalls 和 content
        if (m.role === 'assistant') {
            const cleaned: ChatMessage = {...m}
            if (stripContent) {
                cleaned.content = ''
            }
            if (cleaned.toolCalls) {
                cleaned.toolCalls = cleaned.toolCalls.filter(
                    tc => !lowValueCallIds.has(tc.id),
                )
            }
            result.push(cleaned)
            continue
        }
        result.push(m)
    }
    return result
}

/**
 * 收集一个 turn 内所有低价值工具的 toolCallId（v4）。
 * 低价值工具 = 不在 highValueNames 中的工具。
 */
function collectLowValueCallIds(
    turnMessages: ChatMessage[],
    highValueNames: Set<string>,
): Set<string> {
    const ids = new Set<string>()
    for (const m of turnMessages) {
        if (m.role === 'assistant' && m.toolCalls) {
            for (const tc of m.toolCalls) {
                if (!highValueNames.has(tc.name)) {
                    ids.add(tc.id)
                }
            }
        }
    }
    return ids
}

/**
 * 结构感知截断 messages。
 *
 * 算法：
 *  1. 切分 turns（含 v3 配对剥离信息和 v4 高价值工具标记）
 *  2. 第一个 user turn（含 system 前缀）保留
 *  3. 最近 N 个 turn 保留（完整，不受 v4 剥离影响）
 *  4. 中间 turns：
 *     - hasHighValueToolCalls=false → 整轮丢弃
 *     - hasHighValueToolCalls=true → 保留，但 v4 剥离（低价值 tool + assistant 正文）
 *  5. 合并时按 startIdx 排序去重
 */
export function structuredTruncateMessages(
    messages: ChatMessage[],
    options?: StructuredTruncationOptions,
): StructuredTruncationResult {
    const keepRecentTurns = options?.keepRecentTurns ?? 7
    const highValueToolNames = options?.highValueToolNames ?? DEFAULT_HIGH_VALUE_TOOL_NAMES
    const stripAssistantContent = options?.stripAssistantContent ?? true

    if (messages.length === 0) {
        return {messages: [], afterCount: 0, droppedTurns: 0}
    }

    const turns = splitIntoTurns(messages, highValueToolNames)

    // 总轮数 ≤ keepRecentTurns + 1 → 不丢任何 turn
    if (turns.length <= 1 || turns.length <= keepRecentTurns + 1) {
        return {messages: [...messages], afterCount: messages.length, droppedTurns: 0}
    }

    // 第一个 turn 保留
    const firstTurn = turns[0]
    // 最近 N 个 turn 保留
    const recentTurns = turns.slice(-keepRecentTurns)

    // 中间区间（不含第一个 turn 和最近 N 轮）
    const middleTurns = turns.slice(1, turns.length - keepRecentTurns)

    // v4：中间区间只保留有高价值工具调用的轮
    const keptMiddleTurns = middleTurns.filter(t => t.hasHighValueToolCalls)

    // 合并保留结果（按 startIdx 去重）
    const keptTurnSet = new Map<number, TurnBoundary>()
    keptTurnSet.set(firstTurn.startIdx, firstTurn)
    for (const t of keptMiddleTurns) keptTurnSet.set(t.startIdx, t)
    for (const t of recentTurns) keptTurnSet.set(t.startIdx, t)

    const keptTurns = Array.from(keptTurnSet.values()).sort((a, b) => a.startIdx - b.startIdx)

    // 组装结果 messages
    const result: ChatMessage[] = []
    for (const t of keptTurns) {
        // v3 剥离后消息（错误配对剥离）
        const baseMessages = t.mixedTurnKept
            ? t.mixedTurnKept
            : messages.slice(t.startIdx, t.endIdx)

        // 判断是否为中间区间的 turn（需走 v4 剥离）
        const isMiddleTurn = middleTurns.some(mt => mt.startIdx === t.startIdx)

        if (isMiddleTurn) {
            // 中间区间 → v4 剥离低价值工具 + assistant 正文
            const lowIds = collectLowValueCallIds(baseMessages, highValueToolNames)
            const stripped = applyV4Stripping(baseMessages, lowIds, stripAssistantContent)
            for (const m of stripped) result.push(m)
        } else {
            // 第一轮或最近 N 轮 → 完整保留
            for (const m of baseMessages) result.push(m)
        }
    }

    return {
        messages: result,
        afterCount: result.length,
        droppedTurns: middleTurns.length - keptMiddleTurns.length,
    }
}
