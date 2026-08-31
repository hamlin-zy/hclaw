// ── startAgent 实现 ─────────────────────────────────────

import type {AgentStore} from '../types'
import {IDLE_STATE, makeAgentState} from '../defaultState'
import {useConversationStore, finalizeMessageDelta} from '../../conversationStore'
import type {ContentBlock} from '@shared/types'
import {clearAllBatches} from '../helpers/convHelpers'

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
    // 运行时状态（progress、tokenUsage 等）在工具完成时已即时清理（handleToolResult），
    // 此处无需清空；仅保留极少数跨轮次展示场景（如 pending 结果），
    // 渲染层回退到消息内静态 toolCall 数据。

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

    // ★ 兜底补全：上一条 assistant 消息若因异常（abort 时 done 丢失 / 崩溃）未终结
    //   （无 endedAt），补 end 块 + endedAt 后再开始新一轮。否则 ensureStreamingMessage
    //   孤儿收养会把新响应合并进旧气泡。
    //   时间戳取最后一条用户消息 timestamp - 1（而非"最后一块时间+1"）：
    //   保证 assistant.endedAt < 新 user.timestamp（消息按 timestamp 排序合并时不串位），
    //   且语义上"消息在用户发话前已结束"恒成立。
    {
        const convMsgs = useConversationStore.getState().messagesMap[conversationId] || []
        const lastUserTs = [...convMsgs].reverse().find(m => m.role === 'user')?.timestamp
        const endedAt = (lastUserTs ?? Date.now()) - 1
        for (const msg of convMsgs) {
            if (msg.role !== 'assistant' || msg.endedAt) continue
            // 内存补 endedAt + end 块（末块非 end 时追加，end 语义恒为收尾哨兵）
            const blocks: ContentBlock[] | undefined = msg.contentBlocks
            const patch: Record<string, unknown> = {endedAt}
            if (blocks && blocks.length > 0 && blocks[blocks.length - 1].type !== 'end') {
                patch.contentBlocks = [...blocks, {id: `end-${msg.id}`, type: 'end' as const, endedAt}]
            }
            useConversationStore.getState().updateMessageForConv(conversationId, msg.id, patch)
            finalizeMessageDelta(conversationId, msg.id, endedAt)
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
