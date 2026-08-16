// ── 文本批量更新（减少高频流式渲染） ──────────────────────
// ★ 方案 A：queueMicrotask → setTimeout 固定 24ms 窗口。
//   原因（spec §1.3）：流式 for await 中每个 chunk 跨宏任务边界，queueMicrotask
//   会在下一个 chunk 到达前被执行——实际每 chunk 触发一次 flush，合并失效。
//   setTimeout 固定窗口：窗口固定不因新 chunk 推迟，慢速流每窗 1 chunk 逐字顺滑，
//   快速流一窗内合并为一次 flush。store 层不能用 rAF（慢速流被帧调度推迟 → 积压涌出）。

import {useAgentStore} from '..'
import {useConversationStore, recordTextBlock} from '../../conversationStore'

const FLUSH_WINDOW_MS = 24   // spec §4.2：60fps 半帧，上限 ≈42 次/s

/** 按会话隔离的文本段累积（string[] 消除 O(n²) 拼接；flush 时 join('')） */
let textBatches: Record<string, string[]> = {}

/** 全局单一窗口定时器（避免每会话一个 timer） */
let flushTimer: ReturnType<typeof setTimeout> | null = null

/** 累积文本到批处理缓冲区（O(1) push，不再逐字拼接） */
export function accumulateTextBatch(convId: string, text: string) {
    (textBatches[convId] ??= []).push(text)
}

export function flushTextBatch(convId: string, streamingMessageId: string | null) {
    const parts = textBatches[convId]
    if (!parts || parts.length === 0 || !streamingMessageId) {
        if (parts) textBatches[convId] = []
        return
    }
    const batch = parts.join('')
    textBatches[convId] = []

    const convState = useAgentStore.getState().convAgentStates[convId]
    if (!convState) return
    const updated = (convState.streamBuffer || '') + batch
    // 写入该会话的消息（使用按会话的方法，防止写入错误会话）
    useConversationStore.getState().updateMessageForConv(convId, streamingMessageId, {content: updated})
    // ★ 块级增量：传增量 batch（独立短字符串，不持有完整 streamBuffer）
    recordTextBlock(convId, streamingMessageId, batch)
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

/** 固定窗口调度：已有 timer 则不重置（窗口固定是慢速流顺滑的关键） */
export function scheduleImmediateTextFlush(convId: string, streamingMessageId: string | null) {
    if (!streamingMessageId) return
    if (flushTimer !== null) return
    flushTimer = setTimeout(() => {
        flushTimer = null
        flushAllTextBatches()
    }, FLUSH_WINDOW_MS)
}

export function clearTextBatch(convId: string) {
    textBatches[convId] = []
}

/** 同步刷新全部待刷文本批次（done/error/abort/visibilitychange 兜底路径） */
export function flushAllTextBatches() {
    for (const convId of Object.keys(textBatches)) {
        if (!textBatches[convId] || textBatches[convId].length === 0) continue
        const convState = useAgentStore.getState().convAgentStates[convId]
        flushTextBatch(convId, convState?.streamingMessageId ?? null)
    }
    // ★ 兜底 flush 后取消并复位窗口定时器：done/HMR/visibility 手动刷入后
    //   不应残留定时器阻塞新一轮流的第一个窗口（也避免旧 timer 到期后空跑）
    if (flushTimer !== null) {
        clearTimeout(flushTimer)
        flushTimer = null
    }
}
