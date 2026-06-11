// ── 工具相关事件处理器 ──────────────────────────────
// tool_use, tools_start, tool_start, tool_progress, tool_detail, tool_result, tool_denied

import type {StreamCtx} from './streamContext'
import {makeAgentState, createDefaultConvData} from '../defaultState'
import {useConversationStore} from '../../conversationStore'
import {useToolCallsStore} from '../../toolCallsStore'
import {
    flushTextBatch,
    clearTextBatch,
} from '../batching/textBatch'
import {
    scheduleToolResultUpdate,
} from '../batching/toolResultBatch'
import {normalizeToolResult} from '../helpers/misc'

export function handleToolUse(ctx: StreamCtx) {
    const {get, convId, isAgentAborted, isActiveConv, event} = ctx
    if (isAgentAborted) return
    const tc = event.toolCall
    if (!tc) return
    const convState = get().convAgentStates[convId] || createDefaultConvData()
    const convStore = useConversationStore.getState()

    console.log('[handleStreamEvent] tool_use event received, toolCallId:', tc.id, 'toolName:', tc.name, 'current streamingMessageId:', convState.streamingMessageId)

    if (convState.streamingMessageId === null && convState.agentState.status === 'idle') {
        console.log('[handleStreamEvent] tool_use SKIPPED: streamingMessageId is null and status is idle')
        return
    }

    // 清除重试状态消息（成功重试后 LLM 开始调用工具）
    if (convState.executingToolsMessage?.startsWith('重试 ')) {
        get().updateConvData(convId, {executingToolsMessage: null})
    }

    flushTextBatch(convId, convState.streamingMessageId)
    clearTextBatch(convId)

    let msgId = convState.streamingMessageId
    if (!msgId) {
        msgId = crypto.randomUUID()
        console.log('[handleStreamEvent] tool_use: creating new assistant message, id:', msgId)
        convStore.addMessageToConv(convId, {
            id: msgId,
            role: 'assistant',
            content: '',
            toolCalls: [],
        })
        get().updateConvData(convId, {streamingMessageId: msgId})
    }

    const convMsgs = convStore.messagesMap[convId] || []
    const msg = convMsgs.find(m => m.id === msgId)
    console.log('[handleStreamEvent] tool_use: found message, id:', msgId, 'existing toolCalls:', msg?.toolCalls?.length)
    const existing = msg?.toolCalls || []
    if (existing.some(e => e.id === tc.id)) {
        console.log('[handleStreamEvent] tool_use: SKIPPED (already exists), id:', tc.id)
        return
    }
    const updatedConvState = get().convAgentStates[convId] || createDefaultConvData()
    const textOffset = updatedConvState.streamBuffer.length
    console.log('[handleStreamEvent] tool_use: adding toolCall to message, total toolCalls will be:', existing.length + 1)
    convStore.updateMessageForConv(convId, msgId, {
        toolCalls: [...existing, {
            id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
            status: 'running',
            textOffset,
            reason: tc.reason,
            terminal: tc.terminal,
        }],
    })
    console.log(`[tool_use] ${tc.name}[${tc.id}] count: ${updatedConvState.runningToolCount}→${updatedConvState.runningToolCount + 1}`)
    get().updateConvData(convId, {
        runningToolCount: updatedConvState.runningToolCount + 1,
    })

    const toolOffset = updatedConvState.streamBuffer.length
    const newBlocks = [...updatedConvState.streamBlocks, {
        type: 'tool_use' as const,
        id: `tool-${tc.id}`,
        textOffset: toolOffset,
        toolCall: {id: tc.id, name: tc.name, arguments: tc.arguments, status: 'running', textOffset: toolOffset, reason: tc.reason, terminal: tc.terminal} as import('@shared/types').ToolCall,
    }]
    get().updateConvData(convId, {streamBlocks: newBlocks})
    if (isActiveConv) {
        get().updateMessageContentBlocks(convId)
    }
}

export function handleToolsStart(ctx: StreamCtx) {
    const {get, convId, isAgentAborted, event} = ctx
    if (isAgentAborted) return
    const convState = get().convAgentStates[convId] || createDefaultConvData()
    const convStore = useConversationStore.getState()

    if (!convState.streamingMessageId && convState.agentState.status === 'idle') return
    const msgId = convState.streamingMessageId
    if (!msgId) return

    if (convState.thinkingContent) {
        convStore.updateMessageForConv(convId, msgId, {
            thinkBlock: {id: `think-${msgId}`, content: convState.thinkingContent, status: 'complete', timestamp: Date.now()},
        })
    }

    const toolLabel = event.toolCount > 1 ? `${event.toolCount} 个工具` : '工具'
    get().updateConvData(convId, {
        agentState: {...convState.agentState, status: 'running', phase: 'executing_tools'},
        executingToolsMessage: `${toolLabel} 执行中...`,
    })
}

export function handleToolStart(ctx: StreamCtx) {
    const {get, convId, isAgentAborted, event} = ctx
    if (isAgentAborted || !event.toolCall) return
    const tc = event.toolCall
    const convState = get().convAgentStates[convId] || createDefaultConvData()
    const convStore = useConversationStore.getState()

    if (!convState.streamingMessageId && convState.agentState.status === 'idle') return

    flushTextBatch(convId, convState.streamingMessageId)
    clearTextBatch(convId)

    let msgId = convState.streamingMessageId
    if (!msgId) {
        msgId = (event.messageId as string | undefined) || crypto.randomUUID()
        convStore.addMessageToConv(convId, {id: msgId, role: 'assistant', content: '', toolCalls: []})
    }

    const msg = convStore.messagesMap[convId]?.find(m => m.id === msgId)
    const existing = msg?.toolCalls || []
    if (existing.some(e => e.id === tc.id)) {
        get().updateConvData(convId, {
            agentState: {...convState.agentState, status: 'running', phase: 'executing_tools'},
            executingToolsMessage: null,
        })
        return
    }

    const textOffset = convState.streamBuffer.length
    convStore.updateMessageForConv(convId, msgId, {
        toolCalls: [...existing, {id: tc.id, name: tc.name, arguments: tc.arguments, status: 'running', textOffset, reason: tc.reason, terminal: tc.terminal}],
    })

    get().updateConvData(convId, {
        streamingMessageId: msgId,
        agentState: {...convState.agentState, status: 'running', phase: 'executing_tools'},
        executingToolsMessage: null,
    })

    useToolCallsStore.getState().registerToolCall(tc.id, {status: 'running'})
}

export function handleToolProgress(ctx: StreamCtx) {
    const {get, convId, isAgentAborted, event} = ctx
    if (isAgentAborted) return
    if (!event.toolCallId) return
    const convState = get().convAgentStates[convId] || createDefaultConvData()
    if (!convState.streamingMessageId && convState.agentState.status === 'idle') return
    useToolCallsStore.getState().updateToolCall(event.toolCallId, {progress: event.progress})
}

export function handleToolDetail(ctx: StreamCtx) {
    const {get, isAgentAborted, event} = ctx
    if (isAgentAborted) return
    if (!event.toolCallId) return
    const state = get()
    if (!state.streamingMessageId && state.agentState.status === 'idle') return
    useToolCallsStore.getState().updateToolCall(event.toolCallId, {
        detailStatus: event.status,
        progressPercent: typeof event.progress === 'number' ? event.progress : undefined,
        eta: event.eta,
    })
}

export function handleToolResult(ctx: StreamCtx) {
    const {get, convId, isAgentAborted, isActiveConv, event} = ctx
    if (isAgentAborted || !event.toolCallId) return
    const convState = get().convAgentStates[convId] || createDefaultConvData()
    const msgId = convState.streamingMessageId
    const convStore = useConversationStore.getState()

    if (!msgId && convState.agentState.status === 'idle') return

    const convMsgs = convStore.messagesMap[convId] || []
    const msg = convMsgs.find(m => m.id === msgId)
    const result = event.result ? normalizeToolResult(event.result) : null

    if (msg?.toolCalls && result && msgId) {
        useToolCallsStore.getState().setToolResult(event.toolCallId, result)
        if (event.skillName) {
            const tc = msg.toolCalls.find(tc => tc.id === event.toolCallId)
            if (tc) useToolCallsStore.getState().updateToolCall(event.toolCallId, {skillName: event.skillName} as any)
        }
        scheduleToolResultUpdate(convId, msgId, event.toolCallId, result)
    }

    const newCount = Math.max(0, convState.runningToolCount - 1)
    const isDone = newCount <= 0
    console.log(`[tool_result] toolId=${event.toolCallId}, runningToolCount: ${convState.runningToolCount} -> ${newCount}, isDone=${isDone}`)
    get().updateConvData(convId, {
        runningToolCount: newCount,
        isThinkingAfterTools: isDone,
        agentState: {...convState.agentState, ...makeAgentState('running', isDone ? 'responding' : 'executing_tools')},
    })

    if (isActiveConv) {
        get().updateMessageContentBlocks(convId)
    }
}

export function handleToolDenied(ctx: StreamCtx) {
    const {get, convId, isAgentAborted, event} = ctx
    if (isAgentAborted || !event.toolCallId) return
    const deniedConvData = get().convAgentStates[convId] || createDefaultConvData()
    const msgId = deniedConvData.streamingMessageId
    if (!msgId) return
    const convStore = useConversationStore.getState()
    const convMsgs = convStore.messagesMap[convId] || []
    const msg = convMsgs.find(m => m.id === msgId)
    if (!msg?.toolCalls) return

    const errorResult = {output: '', error: event.reason || '权限被拒绝'}
    const updatedToolCalls = msg.toolCalls.map(tc =>
        tc.id === event.toolCallId ? {...tc, status: 'error' as const, result: errorResult} : tc,
    )

    convStore.updateMessageForConv(convId, msgId, {toolCalls: updatedToolCalls})
    useConversationStore.getState().flushMessages()
}
