// ── ContentBlocks 构建 ──────────────────────────────────

import {useAgentStore} from '.'
import {useConversationStore} from '../conversationStore'
import {createDefaultConvData} from './defaultState'
import {flushToolResultBatch, getToolResultBatchMap} from './batching/toolResultBatch'

/**
 * 从 streamBlocks + streamBuffer 重建 contentBlocks
 *
 *  关键修复：
 *   1. 按 textOffset 排序 streamBlocks，保证处理顺序正确
 *   2. lastOffset 只增不减（Math.max），防止乱序 streamBlock 导致 textOffset 回退
 *   3. 工具结果更新后重新调用以刷新 tool 状态
 */
export function updateMessageContentBlocks(convId?: string) {
    // 使用传入的 convId，否则回退到当前活跃会话（向后兼容）
    const targetConvId = convId || useConversationStore.getState().activeConversationId
    if (!targetConvId) return
    const convData = useAgentStore.getState().convAgentStates[targetConvId] || createDefaultConvData()
    const {streamBlocks, streamBuffer, streamingMessageId} = convData
    if (!streamingMessageId || streamBlocks.length === 0) return

    // 刷新待处理的工具结果批处理，确保 messagesMap 包含最新数据
    const pendingBatch = getToolResultBatchMap()[targetConvId]
    if (pendingBatch && pendingBatch.size > 0) {
        flushToolResultBatch(targetConvId)
    }

    const fullText = streamBuffer
    const assembled: import('@shared/types').ContentBlock[] = []
    let lastOffset = 0

    //  按 textOffset 排序，确保处理顺序正确（防止乱序到达）
    const sortedBlocks = [...streamBlocks].sort((a, b) => a.textOffset - b.textOffset)

    for (const sb of sortedBlocks) {
        // 提取 textOffset 之前的文本段
        if (sb.textOffset > lastOffset) {
            const textSlice = fullText.slice(lastOffset, sb.textOffset)
            if (textSlice) {
                assembled.push({
                    id: `text-${crypto.randomUUID()}`,
                    type: 'text',
                    text: textSlice,
                })
            }
        }

        // 添加 think 或 tool_use block
        if (sb.type === 'think') {
            assembled.push({
                id: sb.id,
                type: 'think',
                thinkBlock: {
                    id: sb.id,
                    content: sb.thinkContent || '',
                    status: 'thinking',
                    timestamp: Date.now(),
                    ...(sb.thinkSignature ? {signature: sb.thinkSignature} : {}),
                },
            })
        } else if (sb.type === 'tool_use' && sb.toolCall) {
            // 从 messagesMap 查找最新工具调用数据（含 result），
            // streamBlocks 不存储 result，避免与 messagesMap 冗余
            const convMsgs = useConversationStore.getState().messagesMap[targetConvId] || []
            const currentMsg = convMsgs.find(m => m.id === streamingMessageId)
            const latestTc = currentMsg?.toolCalls?.find(tc => tc.id === sb.toolCall!.id) || sb.toolCall
            assembled.push({
                id: sb.id,
                type: 'tool_use',
                toolCall: latestTc,
            })
        }

        //  lastOffset 只增不减，防止 textOffset 回退导致文本重复/丢失
        if (sb.textOffset > lastOffset) {
            lastOffset = sb.textOffset
        }
    }

    // 所有 block 之后的剩余文本
    if (lastOffset < fullText.length) {
        const remainingText = fullText.slice(lastOffset)
        if (remainingText) {
            assembled.push({
                id: `text-${crypto.randomUUID()}`,
                type: 'text',
                text: remainingText,
            })
        }
    }

    if (assembled.length > 0) {
        useConversationStore.getState().updateMessageForConv(targetConvId, streamingMessageId, {
            contentBlocks: assembled,
        })
    }
}
