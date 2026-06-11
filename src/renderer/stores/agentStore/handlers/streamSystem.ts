// ── 系统/状态事件处理器 ────────────────────────────
// intent_analyzed, mode_change, context_compacted, compact_status,
// hook_result, compact_persisted, tasks_update, llm_call_done, command_start

import type {StreamCtx} from './streamContext'
import {createDefaultConvData} from '../defaultState'
import {useConversationStore} from '../../conversationStore'
import {
    clearTextBatch,
} from '../batching/textBatch'
import {
    clearToolResultBatchData,
} from '../batching/toolResultBatch'

export function handleIntentAnalyzed(ctx: StreamCtx) {
    const {get, convId, isAgentAborted, event} = ctx
    if (isAgentAborted) return
    if (!event.result) return
    const convState = get().convAgentStates[convId] || createDefaultConvData()
    const convStore = useConversationStore.getState()
    if (convState.streamingMessageId && event.result.summary) {
        const intentText = `\n\n> 💡 ${event.result.summary}`
        const intentContent = convState.streamBuffer + intentText
        convStore.updateMessageForConv(convId, convState.streamingMessageId, {
            content: intentContent,
        })
        get().updateConvData(convId, {streamBuffer: intentContent})
    }
}

export function handleModeChange(ctx: StreamCtx) {
    const {set, event} = ctx
    if (!event.mode) return
    set((prev: any) => ({
        agentState: {...prev.agentState, mode: event.mode as 'auto'},
    }))
}

export function handleContextCompacted(ctx: StreamCtx) {
    const {get, convId, isAgentAborted, event} = ctx
    if (isAgentAborted) return
    const convState = get().convAgentStates[convId] || createDefaultConvData()
    const convStore = useConversationStore.getState()
    if (convState.streamingMessageId && event.message) {
        const compactText = `\n\n> 📦 ${event.message}`
        const compactContent = convState.streamBuffer + compactText
        convStore.updateMessageForConv(convId, convState.streamingMessageId, {
            content: compactContent,
        })
        get().updateConvData(convId, {streamBuffer: compactContent})
    }
}

export function handleCompactStatus(ctx: StreamCtx) {
    const {set, isAgentAborted, event} = ctx
    if (isAgentAborted) return
    const compactStatus = event.compactStatus
    if (compactStatus === 'compacting') {
        set({compactInProgress: true})
    } else if (compactStatus === 'completed') {
        set({compactInProgress: false})
    }
}

export function handleHookResult(ctx: StreamCtx) {
    const {get, isAgentAborted, event} = ctx
    if (isAgentAborted) return
    const hr = event as {type: 'hook_result'; event: string; hookName: string; success: boolean; error?: string}
    const convId = useConversationStore.getState().activeConversationId
    if (!convId) return
    get().addHookResult({
        id: `${hr.event}:${hr.hookName}:${Date.now()}`,
        event: hr.event,
        hookName: hr.hookName,
        success: hr.success,
        error: hr.error,
        timestamp: Date.now(),
        conversationId: convId,
    })
}

export async function handleCompactPersisted(ctx: StreamCtx) {
    const {get, set, convId, isAgentAborted, event} = ctx
    if (isAgentAborted || !convId) return

    clearTextBatch(convId)
    clearToolResultBatchData(convId)

    get().updateConvData(convId, {
        streamingMessageId: null,
        streamBuffer: '',
        thinkingContent: null,
        streamBlocks: [],
        isThinkingAfterTools: false,
        runningToolCount: 0,
    })

    useConversationStore.getState().cancelPendingSave()
    await useConversationStore.getState().loadMessages(convId)
    set({
        compactStats: {
            beforeTokens: event.beforeTokens,
            afterTokens: event.afterTokens,
            savedTokens: event.savedTokens,
            compactedMessages: event.compactedMessages,
            showBanner: true,
        },
    })
}

export function handleTasksUpdate(ctx: StreamCtx) {
    const {get, set, convId, event} = ctx
    const tasks = event.tasks || []
    const isAllDone = tasks.length > 0 && tasks.every((t: any) => t.status === 'completed' || t.status === 'failed')
    const state = get()

    set((prev: any) => ({
        tasks,
        agentState: isAllDone && prev.runningToolCount === 0
            ? {...prev.agentState, status: 'idle'}
            : prev.agentState,
        isThinkingAfterTools: isAllDone ? false : prev.isThinkingAfterTools,
        streamingMessageId: isAllDone ? null : prev.streamingMessageId,
    }))

    get().updateConvData(convId, {tasks})

    const convState = get().convAgentStates[convId]
    const convMsgId = convState?.streamingMessageId
    if (convMsgId) {
        useConversationStore.getState().updateMessageForConv(convId, convMsgId, {
            tasksBlock: {id: 'tasks', tasks},
        })
    }
}

export function handleLlmCallDone(ctx: StreamCtx) {
    const {get, convId, event} = ctx
    const convState = get().convAgentStates[convId]
    const msgId = convState?.streamingMessageId
    if (msgId && event.inputTokens !== undefined && event.provider !== undefined) {
        const newStats = {
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens ?? 0,
            provider: event.provider,
            model: event.model ?? 'unknown',
            duration: event.duration ?? 0,
            cacheReadTokens: event.cacheReadTokens,
            cacheWriteTokens: event.cacheWriteTokens,
            reasoningTokens: event.reasoningTokens,
        }

        const msgs = useConversationStore.getState().messagesMap[convId] || []
        const currentMsg = msgs.find(m => m.id === msgId)
        const existingStats = currentMsg?.llmStats || []
        const updatedStats = [...existingStats, newStats]

        useConversationStore.getState().updateMessageForConv(convId, msgId, {llmStats: updatedStats})

        if (convId) {
            ;(window.electronAPI as any)?.message?.updateLlmStats?.({
                conversationId: convId,
                messageId: msgId,
                llmStats: updatedStats,
            })
        }
    }
}

export function handleCommandStart(ctx: StreamCtx) {
    const {get, isAgentAborted, event} = ctx
    if (isAgentAborted) return
    const convState = get().convAgentStates[ctx.convId]
    const msgId = convState?.streamingMessageId
    if (msgId) {
        const commandName = typeof event.commandName === 'string' ? event.commandName : ''
        useConversationStore.getState().updateMessageForConv(ctx.convId, msgId, {
            commandExecution: {
                commandId: event.commandId || '',
                commandName,
                commandArgs: event.commandArgs,
                status: 'loading',
                startTime: Date.now(),
            },
        })
    }
}
