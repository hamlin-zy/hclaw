// ── 会话辅助函数 ──────────────────────────────────────────

import {useAgentStore} from '..'
import {useConversationStore} from '../../conversationStore'
import {useToolCallsStore} from '../../toolCallsStore'
import {clearTextBatch} from '../batching/textBatch'
import {clearThinkingBatch} from '../batching/thinkingBatch'
import {clearToolResultBatchData} from '../batching/toolResultBatch'
import type {Message} from '@shared/types'

/** 将指定 conv 的状态同步到顶层 store 字段 */
export function syncConvToTopLevel(convId: string) {
    const convStore = useConversationStore.getState()
    if (convId !== convStore.activeConversationId) return
    const convData = useAgentStore.getState().convAgentStates[convId]
    if (!convData) return
    useAgentStore.setState({
        streamingMessageId: convData.streamingMessageId,
        streamBuffer: convData.streamBuffer,
        agentState: convData.agentState,
    })
}

/** 清空全部批量状态（文本 + 思考 + 工具结果） */
export function clearAllBatches(convId: string) {
    clearTextBatch(convId)
    clearThinkingBatch(convId)
    clearToolResultBatchData(convId)
}

/** 清空会话的运行时状态（工具运行时 key）：done/error 收尾与会话删除兜底共用 */
export function clearConversationRuntimeState(convId: string) {
    useToolCallsStore.getState().clearConversationToolCalls(convId)
}

/**
 * 判断一条 assistant 消息是否「空」——既无正文、无思考块、无工具调用、无内容块。
 * 空占位气泡是 handleBegin/ensureStreamingMessage 在 LLM 首 token 前创建的，
 * 若此时用户立即终止（abort），该占位没有任何可展示内容，应被移除而非留作空白气泡。
 */
export function isAssistantMessageEmpty(msg: Message): boolean {
    if (msg.role !== 'assistant') return false
    const content = typeof msg.content === 'string' ? msg.content.trim() : ''
    const hasBlocks = (msg.contentBlocks?.length ?? 0) > 0
    const hasThink = !!msg.thinkBlock && (msg.thinkBlock.content?.trim() ?? '') !== ''
    const hasToolCalls = (msg.toolCalls?.length ?? 0) > 0
    return content === '' && !hasBlocks && !hasThink && !hasToolCalls
}

/**
 * 若指定消息是「空」的 assistant 消息，从会话中移除。
 * 供 abort / done(aborted) 收尾调用，消除用户立即终止后残留的空白气泡。
 */
export function removeEmptyAssistantMessage(convId: string, messageId: string | null | undefined): void {
    if (!messageId) return
    const convStore = useConversationStore.getState()
    const msg = convStore.messagesMap[convId]?.find(m => m.id === messageId)
    if (!msg || !isAssistantMessageEmpty(msg)) return
    convStore.deleteMessageForConv(convId, messageId)
}
