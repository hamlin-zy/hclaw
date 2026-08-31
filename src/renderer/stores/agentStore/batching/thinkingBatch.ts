// ── 思考块批量更新（减少高频流式渲染） ──────────────────────
// 与 textBatch 对称：handleThinking 高频触发时，把 chunk 累积到缓冲区，
// 通过固定 24ms 时间窗合并为一次 store 更新 + 一次 contentBlocks 重建，
// 避免每个 thinking chunk 都走 updateMessageForConv / updateMessageContentBlocks
// 全量重建链（此前是 UI 卡死的核心原因）。
// ★ 方案 A：queueMicrotask → setTimeout 固定 24ms 窗口，与 textBatch 同步改造。

import {useAgentStore} from '..'
import {useConversationStore} from '../../conversationStore'
import {createDefaultConvData} from '../defaultState'

const FLUSH_WINDOW_MS = 24   // spec §4.2：60fps 半帧，上限 ≈42 次/s

/** 每个会话的累积思考文本（string[] 累积，flush 时 join('')） */
let thinkingBatches: Record<string, string[]> = {}

/** 全局单一窗口定时器（与 textBatch 共享同一 24ms 时机语义） */
let thinkingFlushTimer: ReturnType<typeof setTimeout> | null = null

/** 累积思考 chunk 到批处理缓冲区（O(1) push） */
export function accumulateThinkingBatch(convId: string, chunk: string) {
    (thinkingBatches[convId] ??= []).push(chunk)
}

/** 清空某会话的思考批处理（如中止/错误时丢弃残留） */
export function clearThinkingBatch(convId: string) {
    delete thinkingBatches[convId]
}

/**
 * 把某会话累积的 thinking chunk 一次性合并写入：
 *  - 更新 convData.thinkingContent（拼接）
 *  - 更新流式消息的 thinkBlock（整块内容）
 *  - 更新 streamBlocks 的 think 块内容
 *  - 触发一次 contentBlocks 重建（仅在必要时）
 */
export function flushThinkingBatch(convId: string) {
    const parts = thinkingBatches[convId]
    if (!parts || parts.length === 0) return
    const batch = parts.join('')
    delete thinkingBatches[convId]

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
        const thinkStartOffset = updatedState.streamBuffer.length
        // think 段序号派生：同消息内已有 think 块数（0, 1, 2, ...），单调递增天然唯一。
        // 注意不能用 thinkStartOffset 作 id——那是文本流长度，think 内容不入 streamBuffer，
        // 工具前后两个 think 段（think → tool → think）offset 相同会碰撞，导致同 id 块
        // INSERT OR REPLACE 静默覆盖。textOffset 仍是 contentBlocks 交错重建的锚点语义，需保留。
        const thinkSeq = currentBlocks.filter(b => b.type === 'think').length
        currentBlocks.push({
            type: 'think',
            id: `think-${msgId}-${thinkSeq}`,
            textOffset: thinkStartOffset,
            thinkContent: batch,
        })
    }
    useAgentStore.getState().updateConvData(convId, {streamBlocks: currentBlocks})

    // ★ 块级增量：最后 think 块的 id/textOffset 来自已更新的 streamBlocks
    //   （Task 1 后 id = think-${msgId}-${thinkSeq}，绝不能从扁平字段 think-${msgId} 派生）
    //   （Phase 3：落库已由主进程负责，此处仅派生 id 供 UI contentBlocks 更新使用）
    const updatedBlocks = useAgentStore.getState().convAgentStates[convId]?.streamBlocks ?? []
    const lastThink = [...updatedBlocks].reverse().find(b => b.type === 'think')

    // 4. ★ 方案 B1：contentBlocks 已存在 → 块级增量只替换 think 块（其他块引用不变）；
    //   首次（无 contentBlocks）→ 全量创建（仅活跃会话，成本高）
    const activeConvId = useConversationStore.getState().activeConversationId
    if (lastThink && lastThink.type === 'think') {
        const convMsgs = useConversationStore.getState().messagesMap[convId] || []
        const msg = convMsgs.find(m => m.id === msgId)
        if (msg?.contentBlocks && msg.contentBlocks.length > 0) {
            useConversationStore.getState().updateMessageBlockForConv(convId, msgId, lastThink.id, {
                id: lastThink.id,
                type: 'think',
                thinkBlock: {
                    id: lastThink.id,
                    content: lastThink.thinkContent ?? '',
                    status: 'thinking',
                    timestamp: Date.now(),
                },
            })
        } else if (convId === activeConvId) {
            useAgentStore.getState().updateMessageContentBlocks(convId)
        }
    }
}

/**
 * 固定窗口调度：已有 timer 则不重置（窗口固定是慢速流顺滑的关键）。
 */
export function scheduleImmediateThinkingFlush(convId: string, streamingMessageId: string | null) {
    if (!streamingMessageId) return
    if (thinkingFlushTimer !== null) return
    thinkingFlushTimer = setTimeout(() => {
        thinkingFlushTimer = null
        flushAllThinkingBatches()
    }, FLUSH_WINDOW_MS)
}

/** 同步刷新全部待刷思考批次（done/error/abort/visibilitychange 兜底路径） */
export function flushAllThinkingBatches() {
    for (const convId of Object.keys(thinkingBatches)) {
        if (!thinkingBatches[convId] || thinkingBatches[convId].length === 0) continue
        flushThinkingBatch(convId)
    }
    // ★ 兜底 flush 后取消并复位窗口定时器：与 textBatch 对称（见 flushAllTextBatches 注释）
    if (thinkingFlushTimer !== null) {
        clearTimeout(thinkingFlushTimer)
        thinkingFlushTimer = null
    }
}
