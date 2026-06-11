// ── abortAgent 实现 ─────────────────────────────────────

import type {AgentStore} from '../types'
import {IDLE_STATE, createDefaultConvData} from '../defaultState'
import {useConversationStore} from '../../conversationStore'
import {useToolCallsStore} from '../../toolCallsStore'
import {clearAllBatches} from '../helpers/convHelpers'
import {updateMessageContentBlocks} from '../contentBlocks'

type SetFn = (...args: any[]) => any
type GetFn = () => AgentStore

export async function abortAgentImpl(
    set: SetFn,
    get: GetFn,
    conversationId: string,
) {
    try {
        await window.electronAPI?.agentAbort?.(conversationId)
    } catch { /* ignore */ }

    const convData = get().convAgentStates[conversationId] || createDefaultConvData()
    const streamingMsgId = convData.streamingMessageId

    // 关键修复：不要在这里立即设置 streamingMessageId = null
    // 否则 controller 后续的 turn 事件会全部被忽略，导致消息丢失
    // 只设置 status = 'idle' 来阻止新的 tool_use 事件
    // streamingMessageId 会在 'done' 事件处理时被清空

    if (streamingMsgId) {
        const convMsgs = useConversationStore.getState().messagesMap[conversationId] || []
        const currentMsg = convMsgs.find(m => m.id === streamingMsgId)
        if (currentMsg) {
            if (convData.thinkingContent) {
                useConversationStore.getState().updateMessageForConv(conversationId, streamingMsgId, {
                    thinkBlock: {
                        id: `think-${streamingMsgId}`,
                        content: convData.thinkingContent,
                        status: 'complete',
                        timestamp: Date.now(),
                    },
                })
            }

            const runningToolCalls = currentMsg.toolCalls?.filter(tc => tc.status === 'running') || []
            if (runningToolCalls.length > 0) {
                const updatedToolCalls = currentMsg.toolCalls!.map(tc => {
                    if (tc.status === 'running') {
                        return {
                            ...tc,
                            status: 'error' as const,
                            result: {output: '', error: '[ABORTED]'},
                        }
                    }
                    return tc
                })
                useConversationStore.getState().updateMessageForConv(conversationId, streamingMsgId, {
                    toolCalls: updatedToolCalls,
                })
                useConversationStore.getState().flushMessages()

                for (const tc of runningToolCalls) {
                    useToolCallsStore.getState().updateToolCall(tc.id, {
                        status: 'cancelled',
                        progress: '已取消',
                    })
                }
            }

            if (convData.streamBlocks.length > 0) {
                const msgForContent = (useConversationStore.getState().messagesMap[conversationId] || []).find(
                    m => m.id === streamingMsgId,
                )
                const toolCallMap = new Map<string, import('@shared/types').ToolCall>()
                if (msgForContent?.toolCalls) {
                    for (const tc of msgForContent.toolCalls) {
                        toolCallMap.set(tc.id, tc)
                    }
                }

                const fullText = convData.streamBuffer
                const assembled: import('@shared/types').ContentBlock[] = []
                let lastOffset = 0
                for (const sb of convData.streamBlocks) {
                    if (sb.textOffset > lastOffset) {
                        const textSlice = fullText.slice(lastOffset, sb.textOffset)
                        if (textSlice) {
                            assembled.push({id: `text-${crypto.randomUUID()}`, type: 'text', text: textSlice})
                        }
                    }
                    if (sb.type === 'think') {
                        assembled.push({
                            id: sb.id,
                            type: 'think',
                            thinkBlock: {
                                id: sb.id,
                                content: sb.thinkContent || '',
                                status: 'complete',
                                timestamp: Date.now(),
                                ...(sb.thinkSignature ? {signature: sb.thinkSignature} : {}),
                            },
                        })
                    } else if (sb.type === 'tool_use' && sb.toolCall) {
                        const latestTc = toolCallMap.get(sb.toolCall.id) || sb.toolCall
                        assembled.push({id: sb.id, type: 'tool_use', toolCall: latestTc})
                    }
                    lastOffset = sb.textOffset
                }
                if (lastOffset < fullText.length) {
                    const remainingText = fullText.slice(lastOffset)
                    if (remainingText) {
                        assembled.push({id: `text-${crypto.randomUUID()}`, type: 'text', text: remainingText})
                    }
                }
                if (assembled.length > 0) {
                    useConversationStore.getState().updateMessageForConv(conversationId, streamingMsgId, {contentBlocks: assembled})
                    useConversationStore.getState().flushMessages()
                }
            }
        }
    }

    get().updateConvData(conversationId, {
        agentState: {
            ...convData.agentState,
            ...IDLE_STATE,
            currentModelName: undefined,
            currentModelProvider: undefined,
        },
        streamBuffer: '',
        thinkingContent: null,
        streamBlocks: [],
        isThinkingAfterTools: false,
        runningToolCount: 0,
        pendingPermissionConfirm: null,
        pendingQuestion: null,
        errorMessage: null,
        executingToolsMessage: null,
    })

    clearAllBatches(conversationId)

    const toolCallStates = useToolCallsStore.getState().states
    for (const [toolCallId, tcState] of Object.entries(toolCallStates)) {
        if (tcState.status === 'running') {
            useToolCallsStore.getState().updateToolCall(toolCallId, {
                status: 'cancelled',
                progress: tcState.progress || '已取消',
            })
        }
    }
}
