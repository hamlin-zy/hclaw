// ── 文本批量更新（减少高频流式渲染） ──────────────────────
// 按会话隔离的批处理状态（仅累积数据，不创建独立 RAF）

import {useAgentStore} from '..'
import {useConversationStore} from '../../conversationStore'

let textBatches: Record<string, string> = {}

/** 全局微任务调度标志 */
let globalTextFlushScheduled = false

/** 累积文本到批处理缓冲区 */
export function accumulateTextBatch(convId: string, text: string) {
    textBatches[convId] = (textBatches[convId] || '') + text
}

/** 检查是否有待处理的文本批次 */
export function hasTextBatch(convId: string): boolean {
    return !!(textBatches[convId])
}

export function flushTextBatch(convId: string, streamingMessageId: string | null) {
    const batchText = textBatches[convId] || ''
    if (!batchText || !streamingMessageId) {
        textBatches[convId] = ''
        return
    }
    const batch = batchText
    textBatches[convId] = ''

    const convState = useAgentStore.getState().convAgentStates[convId]
    if (!convState) return
    const updated = (convState.streamBuffer || '') + batch
    // 写入该会话的消息（使用按会话的方法，防止写入错误会话）
    useConversationStore.getState().updateMessageForConv(convId, streamingMessageId, {content: updated})
    // 更新该会话的 agent 状态
    useAgentStore.getState().updateConvData(convId, {
        streamBuffer: updated,
        agentState: {...convState.agentState, status: 'running'},
    })
    //  仅当有交织块（think/tool_use）时才重建 contentBlocks，纯文本流无需此步骤
    const activeConvId = useConversationStore.getState().activeConversationId
    if (convId === activeConvId && convState.streamBlocks.length > 0) {
        useAgentStore.getState().updateMessageContentBlocks(convId)
    }
}

/**
 * 微任务级文本批处理 —— queueMicrotask 时统一刷入，同微任务内多个文本块合并为一次 store 更新。
 */
export function scheduleImmediateTextFlush(convId: string, streamingMessageId: string | null) {
    if (!streamingMessageId) return
    if (globalTextFlushScheduled) return
    globalTextFlushScheduled = true

    queueMicrotask(() => {
        globalTextFlushScheduled = false
        if (textBatches[convId]) {
            flushTextBatch(convId, streamingMessageId)
        }
    })
}

/** 清空文本批处理状态（仅清空积攒文本） */
export function clearTextBatch(convId: string) {
    textBatches[convId] = ''
}

/** 同步刷新全部待刷文本批次（HMR 保护） */
export function flushAllTextBatches() {
    for (const convId of Object.keys(textBatches)) {
        if (!textBatches[convId]) continue
        const convState = useAgentStore.getState().convAgentStates[convId]
        flushTextBatch(convId, convState?.streamingMessageId ?? null)
    }
}
