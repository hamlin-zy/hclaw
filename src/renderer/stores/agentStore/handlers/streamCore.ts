// ── 核心流式事件处理器 ──────────────────────────────
// begin, agent_start, text, thinking

import type {StreamCtx} from './streamContext'
import {STREAMING_STATE, makeAgentState, createDefaultConvData} from '../defaultState'
import {useConversationStore} from '../../conversationStore'
import {
    accumulateTextBatch,
    scheduleImmediateTextFlush,
} from '../batching/textBatch'

export function handleBegin(ctx: StreamCtx) {
    const {get, convId} = ctx
    console.log('[handleStreamEvent] begin event, convId:', convId)
    const prevConvState = get().convAgentStates[convId] || createDefaultConvData()
    get().updateConvData(convId, {
        streamBuffer: prevConvState.streamBuffer,
        thinkingContent: prevConvState.thinkingContent,
        streamBlocks: prevConvState.streamBlocks,
        // ★ 保留已有 streamingMessageId，防止多轮 LLM 调用（tool → begin 第二轮）
        //   时清空 ID 导致后续 text 事件创建重复消息（幽灵气泡）
        streamingMessageId: prevConvState.streamingMessageId,
        isThinkingAfterTools: false,
        runningToolCount: 0,
        agentState: STREAMING_STATE,
    })
}

export function handleAgentStart(ctx: StreamCtx) {
    const {set, get, convId, event} = ctx
    console.log('[handleStreamEvent] agent_start event, convId:', convId)
    const agentStartConvState = get().convAgentStates[convId] || createDefaultConvData()
    // ★ 只有 idle 状态才需要重置为 running
    //   避免注入消息轮次因 status==='idle' 被 text/thinking 守卫跳过
    if (agentStartConvState.agentState.status === 'idle') {
        get().updateConvData(convId, {
            agentState: {...agentStartConvState.agentState, ...STREAMING_STATE},
        })
    }

    // ── 记录当前模型信息（用于输入框底部展示） ──
    const modelName = event.model
    const provider = event.provider
    if (modelName) {
        set((prev: any) => ({
            agentState: {...prev.agentState, currentModelName: modelName, currentModelProvider: provider},
            ...(convId && prev.convAgentStates[convId] ? {
                convAgentStates: {
                    ...prev.convAgentStates,
                    [convId]: {
                        ...prev.convAgentStates[convId],
                        agentState: {
                            ...prev.convAgentStates[convId].agentState,
                            currentModelName: modelName,
                            currentModelProvider: provider,
                        },
                    },
                },
            } : {}),
        }))
    }
}

export function handleText(ctx: StreamCtx) {
    const {get, convId, isAgentAborted, event} = ctx
    if (isAgentAborted) return

    const textContent = event.content || ''
    const convState = get().convAgentStates[convId] || createDefaultConvData()
    const convStore = useConversationStore.getState()

    if (convState.streamingMessageId === null && convState.agentState.status === 'idle') {
        return
    }

    // 清除重试状态消息（成功重试后 LLM 开始输出内容）
    if (convState.executingToolsMessage?.startsWith('重试 ')) {
        get().updateConvData(convId, {executingToolsMessage: null})
    }

    if (convState.isThinkingAfterTools) {
        get().updateConvData(convId, {isThinkingAfterTools: false})
    }

    if (!convState.streamingMessageId) {
        const id = (event.messageId as string | undefined) || crypto.randomUUID()
        convStore.addMessageToConv(convId, {
            id,
            role: 'assistant',
            content: textContent,
        })
        get().updateConvData(convId, {
            streamingMessageId: id,
            streamBuffer: textContent,
            agentState: {...convState.agentState, status: 'running', phase: 'responding'},
        })
    } else {
        // ★ queueMicrotask 批处理：每个文本块累积到批处理缓冲区，
        // 同微任务内多个块合并为一次 store 更新，防止高频 IPC 触发
        accumulateTextBatch(convId, textContent)
        scheduleImmediateTextFlush(convId, convState.streamingMessageId)

        if (convState.agentState.phase !== 'responding') {
            get().updateConvData(convId, {
                agentState: {...convState.agentState, phase: 'responding'},
            })
        }
    }
}

export function handleThinking(ctx: StreamCtx) {
    const {get, convId, isAgentAborted, isActiveConv, event} = ctx
    if (isAgentAborted) return
    const convState = get().convAgentStates[convId] || createDefaultConvData()
    if (convState.streamingMessageId === null && convState.agentState.status === 'idle') return

    const convStore = useConversationStore.getState()

    // 清除重试状态消息（成功重试后 LLM 开始输出思考内容）
    if (convState.executingToolsMessage?.startsWith('重试 ')) {
        get().updateConvData(convId, {executingToolsMessage: null})
    }

    const thinkChunk = event.content || ''
    const prevContent = convState.thinkingContent || ''
    const newContent = prevContent + thinkChunk

    const isAfterTools = convState.isThinkingAfterTools
    get().updateConvData(convId, {
        thinkingContent: newContent,
        isThinkingAfterTools: isAfterTools ? false : convState.isThinkingAfterTools,
        agentState: {...convState.agentState, ...makeAgentState('thinking', isAfterTools ? 'waiting_for_response' : 'streaming')},
    })

    let msgId = convState.streamingMessageId
    if (!msgId) {
        msgId = (event.messageId as string | undefined) || crypto.randomUUID()
        convStore.addMessageToConv(convId, {
            id: msgId,
            role: 'assistant',
            content: '',
        })
        get().updateConvData(convId, {streamingMessageId: msgId})
    }

    convStore.updateMessageForConv(convId, msgId, {
        thinkBlock: {
            id: `think-${msgId}`,
            content: newContent,
            status: 'thinking',
            timestamp: Date.now(),
        },
    })

    // streamBlocks 跟踪
    const updatedConvData = get().convAgentStates[convId] || createDefaultConvData()
    const currentBlocks = [...updatedConvData.streamBlocks]
    const lastBlock = currentBlocks.length > 0 ? currentBlocks[currentBlocks.length - 1] : null
    if (lastBlock?.type === 'think') {
        lastBlock.thinkContent = (lastBlock.thinkContent || '') + thinkChunk
    } else {
        const textOffset = updatedConvData.streamBuffer.length
        currentBlocks.push({
            type: 'think',
            id: `think-${crypto.randomUUID()}`,
            textOffset,
            thinkContent: thinkChunk,
        })
    }
    get().updateConvData(convId, {streamBlocks: currentBlocks})
    if (isActiveConv) {
        get().updateMessageContentBlocks(convId)
    }
}
