// ── 工具结果批量更新（减少高频 loadedMessages 更新） ──────────────────────

import {useConversationStore, flatString} from '../../conversationStore'

export interface PendingToolResultUpdate {
    toolCallId: string
    /** ★ schedule 时固化的所属消息 id：flush 不再依赖 convAgentStates.streamingMessageId
     *  （done（onWorkerExit 安全网 aborted 直发）可能先清空 streamingMessageId）。
     *  为 null 时（历史调用方/定位失败），flush 按 toolCallId 兜底反查所属消息。 */
    msgId: string | null
    result: any
}

let toolResultBatches: Record<string, Map<string, PendingToolResultUpdate>> = {}

/** 工具结果截断阈值（单位：字符）。入队侧与 flush 侧共用，保证两侧口径一致。 */
export const TOOL_RESULT_TRUNCATE_LEN = 2000

/** 截断提示后缀（入队侧与 flush 侧共用；措辞不得改动，否则两侧截断结果不再逐字节相同） */
export const TOOL_RESULT_TRUNCATE_SUFFIX = '\n\n...(输出过长，完整内容已落库)'

/**
 * 纯函数：截断单个「工具结果对象」的 output / toolResult 全文（原地不动，返回新对象）。
 *
 *  - 只切 output / toolResult（各自独立判断是否超长），error / artifacts / diff 等其余字段原样保留
 *  - 任一字段超长即置 `_fullOutputStored: true`（语义：内存副本已非全文，完整内容已落库）
 *  - 未超长时原样返回入参引用（调用方可据此判等，避免无谓重建）
 *  - 幂等：已截断结果再截断逐字节相同 —— 截断串 = first2000 + 后缀(19 字符)，
 *    再 slice(0, 2000) 恰好把后缀切掉、重新拼回同一后缀；本函数被入队侧与 flush 侧
 *    各调用一次，幂等性是「两侧都截断」逐字节等价的前提（有测试锁定）。
 */
export function truncateToolResultObject(result: any): any {
    if (!result || typeof result.output !== 'string') return result
    const outputTooLong = result.output.length > TOOL_RESULT_TRUNCATE_LEN
    const toolResultTooLong = typeof result.toolResult === 'string' && result.toolResult.length > TOOL_RESULT_TRUNCATE_LEN
    if (!outputTooLong && !toolResultTooLong) return result
    return {
        ...result,
        output: outputTooLong
            ? flatString(result.output.slice(0, TOOL_RESULT_TRUNCATE_LEN)) + TOOL_RESULT_TRUNCATE_SUFFIX
            : result.output,
        ...(toolResultTooLong ? {
            toolResult: flatString(result.toolResult.slice(0, TOOL_RESULT_TRUNCATE_LEN)) + TOOL_RESULT_TRUNCATE_SUFFIX,
        } : {}),
        _fullOutputStored: true,
    }
}

/** 全局 RAF 调度 */
let globalToolResultFlushScheduled = false

/** 隐藏冻结：hidden 时已注册一次性 visibilitychange 监听（避免重复注册） */
let hiddenFlushRegistered = false

/** 合并 flush 全部会话的积压 batch（rAF 与 visibilitychange 恢复共用） */
function flushAllBatches(): void {
    for (const cId of Object.keys(toolResultBatches)) {
        flushToolResultBatch(cId)
    }
}

export function getToolResultBatch(convId: string): Map<string, PendingToolResultUpdate> {
    if (!toolResultBatches[convId]) {
        toolResultBatches[convId] = new Map()
    }
    return toolResultBatches[convId]
}

export function flushToolResultBatch(convId: string) {
    const batch = toolResultBatches[convId]
    if (!batch || batch.size === 0) return

    // 即时清理：flush 后即删除会话 batch（新结果经 getToolResultBatch 重建）
    delete toolResultBatches[convId]

    const convStoreState = useConversationStore.getState()
    const convMsgs = convStoreState.messagesMap[convId] || []

    // ★ 定位优先级（不读 convAgentStates.streamingMessageId）：
    //   ① entry.msgId（schedule 时固化）且该消息确实含此 toolCallId
    //   ② 按 toolCallId 兜底反查所属消息（msgId 缺失或消息已被重建时）
    //   done（onWorkerExit 安全网 aborted 直发，绕过主进程批量累积器）可能先于
    //   worker 尾批 tool_result 到达 —— 晚到结果不能被丢弃，否则工具卡片永远停在「处理中」。
    const byMsg = new Map<string, PendingToolResultUpdate[]>()
    for (const entry of batch.values()) {
        const target = findOwningMessage(convMsgs, entry.msgId, entry.toolCallId)
        if (!target) continue
        const list = byMsg.get(target.id)
        if (list) list.push(entry)
        else byMsg.set(target.id, [entry])
    }

    for (const [msgId, entries] of byMsg) {
        applyToolResultEntries(convId, convMsgs, msgId, entries)
    }
}

/** 消息定位：优先 preferredMsgId（且该消息确实含此 toolCallId）；否则按 toolCallId 兜底反查所属消息。
 *  done（onWorkerExit 安全网 aborted 直发）可能先于 worker 尾批 tool_result 到达 ——
 *  晚到结果不能被丢弃，否则工具卡片永远停在「处理中」。 */
export function findOwningMessage(
    convMsgs: Array<{id: string; toolCalls?: any[]}>,
    preferredMsgId: string | null | undefined,
    toolCallId: string,
): {id: string; toolCalls?: any[]} | undefined {
    if (preferredMsgId) {
        const byId = convMsgs.find(m => m.id === preferredMsgId && m.toolCalls?.some(tc => tc.id === toolCallId))
        if (byId) return byId
    }
    return convMsgs.find(m => m.toolCalls?.some(tc => tc.id === toolCallId))
}

/** 将一组已定位的 tool_result 应用到指定消息（含完成状态写入与 output 截断） */
function applyToolResultEntries(
    convId: string,
    convMsgs: Array<{id: string; toolCalls?: any[]}>,
    msgId: string,
    entries: PendingToolResultUpdate[],
): void {
    const entryMap = new Map(entries.map(e => [e.toolCallId, e]))
    const msg = convMsgs.find(m => m.id === msgId)
    if (!msg?.toolCalls) return

    const updatedToolCalls = msg.toolCalls.map((tc: any) => {
        const pending = entryMap.get(tc.id)
        if (pending) {
            return {
                ...tc,
                status: (pending.result?.success ? 'success' : 'error') as 'success' | 'error',
                result: {
                    output: String(pending.result.output ?? ''),
                    error: pending.result.error,
                    toolResult: pending.result.toolResult,
                    artifacts: pending.result.artifacts,
                    diff: pending.result.diff,
                },
            } as typeof tc
        }
        return tc
    })

    // 走 store action 更新（持久化由主进程负责；上方已确认 msg 含 toolCalls）
    if (msg) {
        useConversationStore.getState().updateMessageForConv(convId, msgId, {toolCalls: updatedToolCalls})
        // ★ 内存泄漏修复：立即截断内存中的 output 与 toolResult，
        //   防止大输出累积驻留。完整内容已由主进程持久化到 DB（message_blocks），
        //   内存只保留摘要。两个字段都必须截断：normalizeToolResult 为每个结果生成
        //   output + formatToolResult 两份全文，漏掉 toolResult 会使数 MB 原文永久驻留。
        //   slice 后用 flatString 强制扁平复制，避免 SlicedString 钉住整个父串（Issue 2869）。
        //   ★ 与入队侧（scheduleToolResultUpdate）共用 truncateToolResultObject（同一口径）；
        //     入队已截断的串在此处再截断逐字节相同（幂等），故本处保留为兜底/防御，
        //     覆盖「entry 由外部直接塞入未经入队截断」等旁路。
        const truncatedToolCalls = updatedToolCalls.map((tc: any) => {
            const truncatedResult = truncateToolResultObject(tc.result)
            return truncatedResult === tc.result ? tc : ({...tc, result: truncatedResult} as typeof tc)
        })
        if (truncatedToolCalls.some((tc: any, i: number) => tc !== updatedToolCalls[i])) {
            useConversationStore.getState().updateMessageForConv(convId, msgId, {toolCalls: truncatedToolCalls})
        }
    }
}

export function scheduleToolResultUpdate(convId: string, msgId: string, toolCallId: string, result: any) {
    const batch = getToolResultBatch(convId)
    // ★ msgId 随 entry 固化：flush 时按 entry 定位消息，与 flush 时刻的
    //   convAgentStates.streamingMessageId 解耦（竞态安全）
    // ★ 入队即截断：hidden 时只累积不 flush，若不在此截断，全量 result（output +
    //   toolResult 两份全文）会一直驻留在 Map 中直到可见/done 兜底 —— 小时级后台
    //   loop（1Hz 心跳不断产出工具结果）下无界累积。此处用与 flush 侧同一纯函数截断，
    //   flush 侧保留截断作为幂等兜底。
    batch.set(toolCallId, {toolCallId, msgId: msgId || null, result: truncateToolResultObject(result)})

    // ★ 隐藏冻结：窗口 hidden 时只累积，注册一次性 visibilitychange，visible 时合并 flush
    if (typeof document !== 'undefined' && document.hidden) {
        if (!hiddenFlushRegistered) {
            hiddenFlushRegistered = true
            document.addEventListener('visibilitychange', function onVis() {
                if (document.visibilityState === 'visible') {
                    document.removeEventListener('visibilitychange', onVis)
                    hiddenFlushRegistered = false
                    flushAllBatches()
                }
            })
        }
        return
    }

    if (globalToolResultFlushScheduled) return
    globalToolResultFlushScheduled = true
    requestAnimationFrame(() => {
        globalToolResultFlushScheduled = false
        flushAllBatches()
    })
}

export function clearToolResultBatchData(convId: string) {
    // 即时清理：删除整条会话 batch（原 clear() 只清 Map 内容，convId key 永久残留）
    delete toolResultBatches[convId]
}

export function getToolResultBatchMap(): Record<string, Map<string, PendingToolResultUpdate>> {
    return toolResultBatches
}
