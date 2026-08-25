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

/**
 * 给父会话消息中的 agent 工具调用补写子会话关联（taskId === childConvId）。
 * 内联运行的子 Agent（agentTool.ts）不产生 subagent_start 事件，
 * 父工具 card 的 taskId 只能从 subagent_progress / tool_result 事件中恢复。
 * 幂等：已存在同名 taskId 时跳过；写入后经 updateMessageForConv 增量落库持久化。
 * 注意：不从 agentStore 取 streamingMessageId（避免与 handlers 形成循环依赖），
 * 直接从 messagesMap 查找包含该 toolCallId 的消息。
 */
export function ensureAgentToolTaskId(convId: string, toolCallId: string | undefined, childConvId: string) {
    if (!toolCallId || !childConvId) return
    const convStore = useConversationStore.getState()
    const convMsgs = convStore.messagesMap[convId] || []
    const msg = convMsgs.find(m => m.toolCalls?.some(tc => tc.id === toolCallId))
    const agentTool = msg?.toolCalls?.find(tc => tc.id === toolCallId)
    if (agentTool && agentTool.name === 'agent' && agentTool.taskId !== childConvId) {
        const updatedToolCalls = msg!.toolCalls!.map(tc =>
            tc.id === toolCallId ? {...tc, taskId: childConvId} : tc,
        )
        convStore.updateMessageForConv(convId, msg!.id, {toolCalls: updatedToolCalls})
        // 同步运行时状态（toolCallsStore），使弹窗/卡片立即响应
        useToolCallsStore.getState().updateToolCall(toolCallId, {taskId: childConvId})
        // ★ 重建 contentBlocks（其 tool_use 块持有 toolCall 副本，不重建则渲染层读到的
        //   仍是无 taskId 的旧副本，导致 Normal/Compact 卡片运行中不显示跳转按钮）
        updateMessageContentBlocks(convId)
    }
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

    // ★ 内联子 Agent（agentTool.ts 不产生 subagent_start，subagent_progress 无 toolCallId）：
    //   用「无 taskId 的 running agent 工具」回退定位父工具，补写 taskId（运行中即可跳转子会话）
    const parentAgentTool = findAgentCall(
        (convStore.messagesMap[convId] || []).find(m => m.id === convState.streamingMessageId)?.toolCalls,
        (event as any).toolCallId,
        true,
    )
    if (parentAgentTool) {
        ensureAgentToolTaskId(convId, parentAgentTool.id, event.taskId)
    }

    // B1：仅更新渲染层内存态 llmStats（UI 实时展示）；不再写回 messages.llm_stats 列
    // （repository 写侧已剥离，否则与 llm_usage 双源重复统计）
    const subLlmEvent = (event as any).subAgentStreamEvent
    if (subLlmEvent?.type === 'llm_call_done' && subLlmEvent.inputTokens !== undefined) {
        if (!convState.streamingMessageId) return
        const newStats = {
            inputTokens: subLlmEvent.inputTokens,
            outputTokens: subLlmEvent.outputTokens ?? 0,
            provider: subLlmEvent.provider,
            model: subLlmEvent.model ?? 'unknown',
            providerName: subLlmEvent.providerName,
            duration: subLlmEvent.duration ?? 0,
            ttftMs: subLlmEvent.ttftMs,
            decodeMs: subLlmEvent.decodeMs,
            tokensPerSecond: subLlmEvent.tokensPerSecond,
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
    if (!convState.streamingMessageId) return
    const convStore = useConversationStore.getState()

    const convMsgs = convStore.messagesMap[convId] || []
    const msg = convMsgs.find(m => m.id === convState.streamingMessageId)
    const agentTool = findAgentCall(msg?.toolCalls, (event as any).toolCallId)
    if (agentTool) {
        // ★ 立即给父 agent 工具补写 taskId（taskId === childConvId，运行中即可跳转子会话）。
        //   agentTool.ts 在子会话创建成功瞬间即推送 subagent_start（携带 toolCallId），
        //   此处精确按 toolCallId 定位父工具并幂等补写，无需等 subagent_progress。
        ensureAgentToolTaskId(convId, agentTool.id, event.taskId)

        const subToolCallId = `sub-${event.taskId}`

        // 防御性检查：避免重复 subagent_start 导致 toolCalls 中创建重复条目
        const alreadyExists = msg?.toolCalls?.some(tc => tc.id === subToolCallId)
        if (!alreadyExists) {
            useToolCallsStore.getState().registerToolCall(subToolCallId, {
                status: 'running',
                progress: '子 Agent 启动中...',
            }, convId)
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
        // ★ 即时清理：子 Agent 完成瞬间即删运行时 key。状态/tokenUsage 先固化到消息
        //   （消息是持久化源，渲染层回退读取），long loop 期间不积压已完成子 Agent 数据。
        const nextStatus = event.success ? 'success' : 'error'
        const runtimeSub = useToolCallsStore.getState().states[subTool.id]
        useConversationStore.getState().updateMessageForConv(convId, msg!.id, {
            toolCalls: (msg!.toolCalls || []).map(t => t.id === subTool.id
                ? {...t, status: nextStatus, ...(runtimeSub?.tokenUsage ? {tokenUsage: runtimeSub.tokenUsage} : {})}
                : t),
        })
        useToolCallsStore.getState().clearToolCall(subTool.id)
        const parentTool = findAgentCall(msg?.toolCalls, (event as any).toolCallId, true)
        if (parentTool) {
            const doneText = event.success
                ? `子 Agent 完成: ${(subTool.taskDescription || event.taskId).slice(0, 40)}`
                : `子 Agent 失败: ${(subTool.taskDescription || event.taskId).slice(0, 40)}`
            useToolCallsStore.getState().appendProgressLog(parentTool.id, doneText)
        }
    }
}
