// ── 会话辅助函数 ──────────────────────────────────────────

import {useAgentStore} from '..'
import {useConversationStore} from '../../conversationStore'
import {useToolCallsStore} from '../../toolCallsStore'
import {clearTextBatch} from '../batching/textBatch'
import {clearThinkingBatch} from '../batching/thinkingBatch'
import {clearToolResultBatchData} from '../batching/toolResultBatch'
import {clearLastStreamType} from '../handlers/streamType'

/** 保存当前活跃对话消息 */
export async function saveCurrentConversation() {
    const convId = useConversationStore.getState().activeConversationId
    if (convId) {
        await useConversationStore.getState().saveMessages()
    }
}

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

/** 清空会话的运行时状态（段边界 + 工具运行时 key）：done/error 收尾与会话删除兜底共用 */
export function clearConversationRuntimeState(convId: string) {
    clearLastStreamType(convId)
    useToolCallsStore.getState().clearConversationToolCalls(convId)
}
