// ── 系统/状态事件处理器 ────────────────────────────
// mode_change, hook_result, tasks_update,
// llm_call_done, command_start

import type {StreamCtx} from './streamContext'
import {useConversationStore} from '../../conversationStore'

export function handleModeChange(ctx: StreamCtx) {
    const {set, event} = ctx
    if (!event.mode) return
    set((prev: any) => ({
        agentState: {...prev.agentState, mode: event.mode as 'auto'},
    }))
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

export function handleTasksUpdate(ctx: StreamCtx) {
    const {get, set, convId, isActiveConv, event} = ctx
    const tasks = event.tasks || []
    const isAllDone = tasks.length > 0 && tasks.every((t: any) => t.status === 'completed' || t.status === 'failed')

    // ★ 仅当事件属于「当前激活会话」时才更新顶层 tasks/agentState：
    //   后台会话（如运行中的子会话）的任务更新只写入 convAgentStates[convId]，
    //   切换会话时由 updateConvData 按 activeConversationId 同步顶层，实现待办跟随切换。
    if (isActiveConv) {
        set((prev: any) => ({
            tasks,
            agentState: isAllDone && prev.runningToolCount === 0
                ? {...prev.agentState, status: 'idle'}
                : prev.agentState,
            isThinkingAfterTools: isAllDone ? false : prev.isThinkingAfterTools,
            streamingMessageId: isAllDone ? null : prev.streamingMessageId,
        }))
    }

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
            providerName: event.providerName,
            duration: event.duration ?? 0,
            cacheReadTokens: event.cacheReadTokens,
            cacheWriteTokens: event.cacheWriteTokens,
            reasoningTokens: event.reasoningTokens,
            ttftMs: event.ttftMs,
            decodeMs: event.decodeMs,
            tokensPerSecond: event.tokensPerSecond,
        }

        const msgs = useConversationStore.getState().messagesMap[convId] || []
        const currentMsg = msgs.find(m => m.id === msgId)
        const existingStats = currentMsg?.llmStats || []
        const updatedStats = [...existingStats, newStats]

        useConversationStore.getState().updateMessageForConv(convId, msgId, {llmStats: updatedStats})
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
