// ── 系统/状态事件处理器 ────────────────────────────
// mode_change, tasks_update,
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

export function handleTasksUpdate(ctx: StreamCtx) {
    const {get, set, convId, isActiveConv, event} = ctx
    const tasks = event.tasks || []
    const isAllDone = tasks.length > 0 && tasks.every((t: any) => t.status === 'completed' || t.status === 'failed')

    // 批次信息（Task 2 事件载荷）：三字段齐备时写入 currentBatch，缺失时保留原值不动
    const batchPatch = event.batchId && event.batchName != null && event.batchStatus != null
        ? {currentBatch: {id: event.batchId as string, name: event.batchName as string, status: event.batchStatus}}
        : {}

    // ★ 仅当事件属于「当前激活会话」时才更新顶层 tasks/agentState：
    //   后台会话（如运行中的子会话）的任务更新只写入 convAgentStates[convId]，
    //   切换会话时由 updateConvData 按 activeConversationId 同步顶层，实现待办跟随切换。
    if (isActiveConv) {
        set((prev: any) => ({
            tasks,
            ...batchPatch,
            agentState: isAllDone && prev.runningToolCount === 0
                ? {...prev.agentState, status: 'idle'}
                : prev.agentState,
            isThinkingAfterTools: isAllDone ? false : prev.isThinkingAfterTools,
            streamingMessageId: isAllDone ? null : prev.streamingMessageId,
        }))
    }

    get().updateConvData(convId, {tasks, ...batchPatch})

    const convState = get().convAgentStates[convId]
    const convMsgId = convState?.streamingMessageId
    if (convMsgId) {
        useConversationStore.getState().updateMessageForConv(convId, convMsgId, {
            tasksBlock: {id: 'tasks', tasks},
        })
    }
}

/**
 * llm_call_done 事件。
 * B1：llm_usage 表为用量唯一数据源（主进程 llm_call_done 时写入）。
 * 此处仅更新渲染层内存态 llmStats（供 UI 实时展示），不再通过任何路径
 * 写回 messages.llm_stats 列——repository 写侧已剥离（writeMessages/writeMessagesDelta
 * 忽略 message.llmStats），否则与 llm_usage 双源重复统计。
 */
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
