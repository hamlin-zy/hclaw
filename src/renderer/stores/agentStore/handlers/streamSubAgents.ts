// ── 子 Agent / Agent 进度事件处理器 ───────────────────
// agent_progress, subagent_progress, subagent_start, subagent_done

import type {StreamCtx} from './streamContext'
import {createDefaultConvData} from '../defaultState'
import {useConversationStore} from '../../conversationStore'
import {useToolCallsStore} from '../../toolCallsStore'
import {toStreamEntry} from '../helpers/misc'
import {updateMessageContentBlocks} from '../contentBlocks'

/** 按 toolCallId 精确查找 agent 工具调用，无 ID 时按条件回退 */
function findAgentCall(
    calls: Array<Record<string, any>> | undefined,
    toolCallId: string | undefined,
    parentOnly?: boolean,
) {
    if (toolCallId) return calls?.find(c => c.id === toolCallId)
    return calls?.find(c => c.name === 'agent' && c.status === 'running' && (!parentOnly || !c.taskId))
}

export function handleAgentProgress(ctx: StreamCtx) {
    const {get, isAgentAborted, event} = ctx
    if (isAgentAborted) return
    if (event.inputTokens === undefined) return
    const state = get()
    if (!state.streamingMessageId && state.agentState.status === 'idle') return
    const msg = useConversationStore.getState().loadedMessages.find(
        m => m.id === state.streamingMessageId,
    )
    const agentTool = findAgentCall(msg?.toolCalls, (event as any).toolCallId)
    if (agentTool) {
        useToolCallsStore.getState().updateToolCall(agentTool.id, {
            tokenUsage: {
                inputTokens: event.inputTokens ?? 0,
                outputTokens: event.outputTokens ?? 0,
                totalTokens: event.totalTokens ?? 0,
            },
        })
    }
}

export function handleSubagentProgress(ctx: StreamCtx) {
    const {get, convId, isAgentAborted, event} = ctx
    if (isAgentAborted) return
    if (!event.taskId || !event.progress) return
    const convState = get().convAgentStates[convId] || createDefaultConvData()
    if (!convState.streamingMessageId && convState.agentState.status === 'idle') return
    const convStore = useConversationStore.getState()

    const subLlmEvent = (event as any).subAgentStreamEvent
    if (subLlmEvent?.type === 'llm_call_done' && subLlmEvent.inputTokens !== undefined) {
        if (!convState.streamingMessageId) return
        const newStats = {
            inputTokens: subLlmEvent.inputTokens,
            outputTokens: subLlmEvent.outputTokens ?? 0,
            provider: subLlmEvent.provider,
            model: subLlmEvent.model ?? 'unknown',
            duration: subLlmEvent.duration ?? 0,
        }
        const activeConvMsgs = convStore.messagesMap[convId] || []
        const currentMsg = activeConvMsgs.find(m => m.id === convState.streamingMessageId)
        const existingStats = currentMsg?.llmStats || []
        const updatedStats = [...existingStats, newStats]
        convStore.updateMessageForConv(convId, convState.streamingMessageId, {llmStats: updatedStats})
    }

    const convMsgsForSub = convStore.messagesMap[convId] || []
    const msgForSub = convMsgsForSub.find(m => m.id === convState.streamingMessageId)
    const agentTool = msgForSub?.toolCalls?.find(tc => tc.name === 'agent' && tc.taskId === event.taskId)
    if (agentTool) {
        useToolCallsStore.getState().appendProgressLog(agentTool.id, event.progress)
    }
    const parentTool = findAgentCall(msgForSub?.toolCalls, (event as any).toolCallId, true)
    if (parentTool && agentTool) {
        const taskLabel = agentTool.taskDescription
            ? agentTool.taskDescription.slice(0, 24)
            : event.taskId.slice(0, 8)
        const subAgentCount = msgForSub?.toolCalls?.filter(tc => tc.name === 'agent' && tc.taskId)?.length ?? 0
        const parentEntry = subAgentCount > 1
            ? `[${taskLabel}] ${event.progress.replace(/^子 Agent /, '')}`
            : event.progress
        useToolCallsStore.getState().appendProgressLog(parentTool.id, parentEntry)
    }

    const raw = (event as any).subAgentStreamEvent
    if (agentTool && raw) {
        const entry = toStreamEntry(raw)
        if (entry) {
            useToolCallsStore.getState().appendSubAgentStream(agentTool.id, entry)
            if (parentTool && parentTool.id !== agentTool.id) {
                useToolCallsStore.getState().appendSubAgentStream(parentTool.id, entry)
            }
        }
    }
}

export function handleSubagentStart(ctx: StreamCtx) {
    const {get, convId, isAgentAborted, event} = ctx
    if (isAgentAborted) return
    if (!event.taskId || !event.description) return
    const convState = get().convAgentStates[convId] || createDefaultConvData()
    if (!convState.streamingMessageId && convState.agentState.status === 'idle') return
    if (!convState.streamingMessageId) return
    const convStore = useConversationStore.getState()

    const convMsgs = convStore.messagesMap[convId] || []
    const msg = convMsgs.find(m => m.id === convState.streamingMessageId)
    const agentTool = findAgentCall(msg?.toolCalls, (event as any).toolCallId)
    if (agentTool) {
        const subToolCallId = `sub-${event.taskId}`

        // 防御性检查：避免重复 subagent_start 导致 toolCalls 中创建重复条目
        const alreadyExists = msg?.toolCalls?.some(tc => tc.id === subToolCallId)
        if (!alreadyExists) {
            useToolCallsStore.getState().registerToolCall(subToolCallId, {
                status: 'running',
                progress: '子 Agent 启动中...',
            })
            useToolCallsStore.getState().appendProgressLog(subToolCallId, '启动中...')
            if (agentTool.id !== subToolCallId) {
                useToolCallsStore.getState().appendProgressLog(agentTool.id, `启动子 Agent: ${event.description.slice(0, 60)}`)
            }
            const existing = msg?.toolCalls || []
            useConversationStore.getState().updateMessageForConv(convId, convState.streamingMessageId, {
                toolCalls: [...existing, {
                    id: subToolCallId,
                    name: 'agent',
                    arguments: {task: event.description},
                    status: 'running',
                    taskId: event.taskId,
                    taskDescription: event.description.length > 60
                        ? event.description.slice(0, 60) + '...'
                        : event.description,
                }],
            })
            // 新增子 Agent toolCall 后必须同步 contentBlocks，否则模式切换后子 Agent 不显示
            updateMessageContentBlocks(convId)
        }
    }
}

export function handleSubagentDone(ctx: StreamCtx) {
    const {get, convId, isAgentAborted, event} = ctx
    if (isAgentAborted) return
    if (!event.taskId) return
    const convState = get().convAgentStates[convId] || createDefaultConvData()
    if (!convState.streamingMessageId && convState.agentState.status === 'idle') return
    const convStore = useConversationStore.getState()

    const convMsgs = convStore.messagesMap[convId] || []
    const msg = convMsgs.find(m => m.id === convState.streamingMessageId)
    const subTool = msg?.toolCalls?.find(tc => tc.name === 'agent' && tc.taskId === event.taskId)
    if (subTool) {
        useToolCallsStore.getState().updateToolCall(subTool.id, {
            status: event.success ? 'success' : 'error',
        })
        const parentTool = findAgentCall(msg?.toolCalls, (event as any).toolCallId, true)
        if (parentTool) {
            const doneText = event.success
                ? `子 Agent 完成: ${(subTool.taskDescription || event.taskId).slice(0, 40)}`
                : `子 Agent 失败: ${(subTool.taskDescription || event.taskId).slice(0, 40)}`
            useToolCallsStore.getState().appendProgressLog(parentTool.id, doneText)
        }
    }
}
