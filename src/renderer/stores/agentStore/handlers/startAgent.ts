// ── startAgent 实现 ─────────────────────────────────────

import type {AgentStore} from '../types'
import {IDLE_STATE, makeAgentState} from '../defaultState'
import {useConversationStore} from '../../conversationStore'
import {clearAllBatches} from '../helpers/convHelpers'
import {flushAllTextBatches, clearTextBatch} from '../batching/textBatch'
import {saveHmrContext} from '../helpers/hmrPersistence'
import {updateMessageContentBlocks} from '../contentBlocks'

type SetFn = (...args: any[]) => any
type GetFn = () => AgentStore

export async function startAgentImpl(
    set: SetFn,
    get: GetFn,
    params: Parameters<AgentStore['startAgent']>[0],
) {
    const {conversationId} = params
    // 检查该会话的 agent 状态，而非全局
    const convData = get().convAgentStates[conversationId]
    if (convData && (convData.agentState.status === 'thinking' || convData.agentState.status === 'running' || convData.agentState.status === 'paused')) {
        return
    }

    clearAllBatches(conversationId)

    // ⚠️ 注意：不要清空 toolCallsStore！
    // 保留运行时状态（progress、tokenUsage 等）用于终止后卡片展示
    // 状态会随着用户开始新的对话自然清空

    // 修复：检查上一轮是否有未完成的 toolCalls（如用户强制杀死进程导致）
    // 如果有，自动补充为用户终止的 error 结果，防止工具调用对不匹配
    const prevStreamingId = convData?.streamingMessageId
    if (prevStreamingId) {
        const convMsgs = useConversationStore.getState().messagesMap[conversationId] || []
        const msg = convMsgs.find(m => m.id === prevStreamingId)
        if (msg?.toolCalls && msg.toolCalls.length > 0) {
            const hasRunning = msg.toolCalls.some(tc => tc.status === 'running')
            if (hasRunning) {
                const updatedToolCalls = msg.toolCalls.map(tc => {
                    if (tc.status === 'running') {
                        return {
                            ...tc,
                            status: 'error' as const,
                            result: {
                                output: '',
                                error: '[ABORTED] 用户已终止执行',
                            },
                        }
                    }
                    return tc
                })
                useConversationStore.getState().updateMessage(prevStreamingId, {
                    toolCalls: updatedToolCalls,
                })
            }
        }
    }

    // 初始化或重置该会话的 agent 数据
    get().updateConvData(conversationId, {
        streamBuffer: '',
        thinkingContent: null,
        streamBlocks: [],
        streamingMessageId: null,
        isThinkingAfterTools: false,
        runningToolCount: 0,
        agentState: {
            ...(convData?.agentState || IDLE_STATE),
            ...makeAgentState('thinking', 'starting'),
            currentModelName: undefined,
            currentModelProvider: undefined,
        },
        errorMessage: null,
    })

    try {
        const result = await window.electronAPI?.agentStart?.({
            conversationId: params.conversationId,
            message: params.message,
            messageAttachments: params.messageAttachments,
            messageMetadata: params.messageMetadata,
        })
        if (result && !result.success) {
            get().updateConvData(conversationId, {
                agentState: {
                    ...get().convAgentStates[conversationId]?.agentState || get().agentState,
                    status: 'error',
                },
                errorMessage: result.error || 'Agent 启动失败',
            })
        }
    } catch (err: any) {
        get().updateConvData(conversationId, {
            agentState: {
                ...get().convAgentStates[conversationId]?.agentState || get().agentState,
                status: 'error',
            },
            errorMessage: err?.message || 'Agent 启动异常',
        })
    }
}
