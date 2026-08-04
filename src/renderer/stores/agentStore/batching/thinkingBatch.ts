// ── 思考块批量更新（减少高频流式渲染） ──────────────────────
// 与 textBatch 对称：handleThinking 高频触发时，把 chunk 累积到缓冲区，
// 通过 queueMicrotask 合并为一次 store 更新 + 一次 contentBlocks 重建，
// 避免每个 thinking chunk 都走 updateMessageForConv / updateMessageContentBlocks
// 全量重建链（此前是 UI 卡死的核心原因）。

import {useAgentStore} from '..'
import {useConversationStore} from '../../conversationStore'
import {createDefaultConvData} from '../defaultState'

/** 每个会话的累积思考文本 */
let thinkingBatches: Record<string, string> = {}

/** 全局微任务调度标志（与 textBatch 共享同一微任务时机） */
let globalThinkingFlushScheduled = false

/** 累积思考 chunk 到批处理缓冲区 */
export function accumulateThinkingBatch(convId: string, chunk: string) {
    thinkingBatches[convId] = (thinkingBatches[convId] || '') + chunk
}

/** 清空某会话的思考批处理（如中止/错误时丢弃残留） */
export function clearThinkingBatch(convId: string) {
    thinkingBatches[convId] = ''
}

/**
 * 把某会话累积的 thinking chunk 一次性合并写入：
 *  - 更新 convData.thinkingContent（拼接）
 *  - 更新流式消息的 thinkBlock（整块内容）
 *  - 更新 streamBlocks 的 think 块内容
 *  - 触发一次 contentBlocks 重建（仅在必要时）
 */
export function flushThinkingBatch(convId: string) {
    const batch = thinkingBatches[convId] || ''
    if (!batch) return
    thinkingBatches[convId] = ''

    const agentStore = useAgentStore.getState()
    const convState = agentStore.convAgentStates[convId] || createDefaultConvData()
    const msgId = convState.streamingMessageId
    if (!msgId) return

    const prevContent = convState.thinkingContent || ''
    const newContent = prevContent + batch

    // 1. convData.thinkingContent 拼接（沿用 handleThinking 的 agentState 语义：thinking/streaming）
    const isAfterTools = convState.isThinkingAfterTools
    agentStore.updateConvData(convId, {
        thinkingContent: newContent,
        isThinkingAfterTools: isAfterTools ? false : convState.isThinkingAfterTools,
        agentState: {
            ...convState.agentState,
            status: 'running',
            phase: isAfterTools ? 'waiting_for_response' : 'streaming',
        },
    })

    // 2. 更新流式消息的 thinkBlock（合并后只写一次，替代每 chunk 一次 updateMessageForConv）
    useConversationStore.getState().updateMessageForConv(convId, msgId, {
        thinkBlock: {
            id: `think-${msgId}`,
            content: newContent,
            status: 'thinking',
            timestamp: Date.now(),
        },
    })

    // 3. streamBlocks 的 think 块内容追加（合并后只更新一次）
    const updatedState = useAgentStore.getState().convAgentStates[convId] || createDefaultConvData()
    const currentBlocks = [...updatedState.streamBlocks]
    const lastBlock = currentBlocks.length > 0 ? currentBlocks[currentBlocks.length - 1] : null
    if (lastBlock?.type === 'think') {
        lastBlock.thinkContent = (lastBlock.thinkContent || '') + batch
    } else {
        currentBlocks.push({
            type: 'think',
            id: `think-${crypto.randomUUID()}`,
            textOffset: updatedState.streamBuffer.length,
            thinkContent: batch,
        })
    }
    useAgentStore.getState().updateConvData(convId, {streamBlocks: currentBlocks})

    // 4. 仅在活跃会话重建 contentBlocks（合并后一次全量重建，替代每 chunk 一次）
    const activeConvId = useConversationStore.getState().activeConversationId
    if (convId === activeConvId) {
        useAgentStore.getState().updateMessageContentBlocks(convId)
    }
}

/**
 * 微任务级思考批处理 —— queueMicrotask 时统一刷入，
 * 同一微任务内多个 thinking chunk 合并为一次 store 更新。
 */
export function scheduleImmediateThinkingFlush(convId: string, streamingMessageId: string | null) {
    if (!streamingMessageId) return
    if (globalThinkingFlushScheduled) return
    globalThinkingFlushScheduled = true

    queueMicrotask(() => {
        globalThinkingFlushScheduled = false
        if (thinkingBatches[convId]) {
            flushThinkingBatch(convId)
        }
    })
}

/** 清空全部思考批处理状态（HMR 保护 / 中止兜底） */
export function flushAllThinkingBatches() {
    for (const convId of Object.keys(thinkingBatches)) {
        if (!thinkingBatches[convId]) continue
        flushThinkingBatch(convId)
    }
}
