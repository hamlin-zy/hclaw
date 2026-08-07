// ── 工具结果批量更新（减少高频 loadedMessages 更新） ──────────────────────

import {useConversationStore} from '../../conversationStore'
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

    toolResultBatches[convId] = new Map()

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
                    artifacts: pending.result.artifacts,
                    diff: pending.result.diff,
                },
            } as typeof tc
        }
        return tc
    })

    const newConvMsgs = convMsgs.map(m => m.id === msgId ? {...m, toolCalls: updatedToolCalls} : m)
    // 走 store action 更新，自动标记 dirty 并调度增量落库（避免全量 flushMessages）
    const updatedMsg = newConvMsgs.find(m => m.id === msgId)
    if (updatedMsg) {
        useConversationStore.getState().updateMessageForConv(convId, msgId, {toolCalls: updatedToolCalls})
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
    if (toolResultBatches[convId]) {
        toolResultBatches[convId]!.clear()
    }
}

export function getToolResultBatchMap(): Record<string, Map<string, PendingToolResultUpdate>> {
    return toolResultBatches
}
