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
        const TRUNCATE_LEN = 2000
        const truncatedToolCalls = updatedToolCalls.map((tc: any) => {
            const r = tc.result as {output?: unknown; toolResult?: string} | undefined
            if (!r || typeof r.output !== 'string') return tc
            const outputTooLong = r.output.length > TRUNCATE_LEN
            const toolResultTooLong = typeof r.toolResult === 'string' && r.toolResult.length > TRUNCATE_LEN
            if (!outputTooLong && !toolResultTooLong) return tc
            return {
                ...tc,
                result: {
                    ...r,
                    output: outputTooLong
                        ? flatString(r.output.slice(0, TRUNCATE_LEN)) + '\n\n...(输出过长，完整内容已落库)'
                        : r.output,
                    ...(toolResultTooLong ? {
                        toolResult: flatString(r.toolResult!.slice(0, TRUNCATE_LEN)) + '\n\n...(输出过长，完整内容已落库)',
                    } : {}),
                    _fullOutputStored: true,
                } as typeof tc.result,
            }
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
    batch.set(toolCallId, {toolCallId, msgId: msgId || null, result})

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
