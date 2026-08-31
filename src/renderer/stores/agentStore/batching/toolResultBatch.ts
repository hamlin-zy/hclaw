// ── 工具结果批量更新（减少高频 loadedMessages 更新） ──────────────────────

import {useConversationStore, flatString} from '../../conversationStore'
import {useAgentStore} from '..'

export interface PendingToolResultUpdate {
    toolCallId: string
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

    const convState = useAgentStore.getState().convAgentStates[convId]
    const msgId = convState?.streamingMessageId
    if (!msgId) return

    const convStoreState = useConversationStore.getState()
    const convMsgs = convStoreState.messagesMap[convId] || []
    const msg = convMsgs.find(m => m.id === msgId)
    if (!msg?.toolCalls) return

    const updatedToolCalls = msg.toolCalls.map(tc => {
        const pending = batch.get(tc.id)
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

    // 走 store action 更新（持久化由主进程负责）
    if (convMsgs.some(m => m.id === msgId)) {
        useConversationStore.getState().updateMessageForConv(convId, msgId, {toolCalls: updatedToolCalls})
        // ★ 内存泄漏修复：立即截断内存中的 output 与 toolResult，
        //   防止大输出累积驻留。完整内容已由主进程持久化到 DB（message_blocks），
        //   内存只保留摘要。两个字段都必须截断：normalizeToolResult 为每个结果生成
        //   output + formatToolResult 两份全文，漏掉 toolResult 会使数 MB 原文永久驻留。
        //   slice 后用 flatString 强制扁平复制，避免 SlicedString 钉住整个父串（Issue 2869）。
        const TRUNCATE_LEN = 2000
        const truncatedToolCalls = updatedToolCalls.map(tc => {
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
        if (truncatedToolCalls.some((tc, i) => tc !== updatedToolCalls[i])) {
            useConversationStore.getState().updateMessageForConv(convId, msgId, {toolCalls: truncatedToolCalls})
        }
    }
}

export function scheduleToolResultUpdate(convId: string, msgId: string, toolCallId: string, result: any) {
    const batch = getToolResultBatch(convId)
    batch.set(toolCallId, {toolCallId, result})

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
