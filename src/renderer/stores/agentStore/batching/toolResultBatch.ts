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
                    output: pending.result?.success ? String(pending.result.output ?? '') : '',
                    error: pending.result.error,
                    artifacts: pending.result.artifacts,
                    diff: pending.result.diff,
                },
            } as typeof tc
        }
        return tc
    })

    const newConvMsgs = convMsgs.map(m => m.id === msgId ? {...m, toolCalls: updatedToolCalls} : m)
    if (convId === useConversationStore.getState().activeConversationId) {
        useConversationStore.setState({
            messagesMap: {...useConversationStore.getState().messagesMap, [convId]: newConvMsgs},
            loadedMessages: newConvMsgs,
        })
    } else {
        useConversationStore.setState({
            messagesMap: {...useConversationStore.getState().messagesMap, [convId]: newConvMsgs},
        })
    }
    useConversationStore.getState().flushMessages()
}

export function scheduleToolResultUpdate(convId: string, msgId: string, toolCallId: string, result: any) {
    const batch = getToolResultBatch(convId)
    batch.set(toolCallId, {toolCallId, result})

    if (globalToolResultFlushScheduled) return
    globalToolResultFlushScheduled = true
    requestAnimationFrame(() => {
        globalToolResultFlushScheduled = false
        for (const cId of Object.keys(toolResultBatches)) {
            flushToolResultBatch(cId)
        }
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
