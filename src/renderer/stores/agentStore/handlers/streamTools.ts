// ── 工具相关事件处理器 ──────────────────────────────
// tool_use, tools_start, tool_start, tool_progress, tool_detail, tool_result, tool_denied

import type {StreamCtx} from './streamContext'
import type {ToolCall} from '@shared/types'
import {makeAgentState, createDefaultConvData} from '../defaultState'
import {useConversationStore, recordToolCallBlock} from '../../conversationStore'
import {useToolCallsStore} from '../../toolCallsStore'
import {
    flushTextBatch,
    clearTextBatch,
} from '../batching/textBatch'
import {
    scheduleToolResultUpdate,
} from '../batching/toolResultBatch'
import {normalizeToolResult} from '../helpers/misc'
import {ensureAgentToolTaskId} from './streamSubAgents'
import {isRetryMessage} from './streamCore'

export function handleToolUse(ctx: StreamCtx) {
    const {get, convId, isAgentAborted, isActiveConv, event} = ctx
    if (isAgentAborted) return
    const tc = event.toolCall
    if (!tc) return
    const convState = get().convAgentStates[convId] || createDefaultConvData()
    const convStore = useConversationStore.getState()

    if (convState.streamingMessageId === null && convState.agentState.status === 'idle') {
        return
    }

    // 清除重试状态消息（成功重试后 LLM 开始调用工具）
    // 覆盖倒计时对象分支（{label: '重试中...'}）与遗留字符串分支（'重试 ...'）
    if (isRetryMessage(convState.executingToolsMessage)) {
        get().updateConvData(convId, {executingToolsMessage: null})
    }

    flushTextBatch(convId, convState.streamingMessageId)
    clearTextBatch(convId)

    let msgId = convState.streamingMessageId
    if (!msgId) {
        // ★ 子会话（主进程累积器）通过 messageId 指定固定 assistant 消息 id，
        //   与主进程增量落库的 SQLite 消息 id 一致 → 运行中切换/刷新无重复气泡。
        //   主会话无 messageId，仍用 UUID 创建。
        msgId = (event.messageId as string | undefined) || crypto.randomUUID()
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
    const existing = msg?.toolCalls || []
    if (existing.some(e => e.id === tc.id)) {
        return
    }
    const updatedConvState = get().convAgentStates[convId] || createDefaultConvData()
    const textOffset = updatedConvState.streamBuffer.length
    const newTc: ToolCall = {
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
        status: 'running',
        textOffset,
        reason: tc.reason,
        terminal: tc.terminal,
        // ★ 倒计时数据持久化：tool_use 阶段通常无 timeoutMs（主进程在 tool_start 才注入），
        //   但若已携带则落库，保证不丢（tool_start 到达时会再补齐）
        timeoutMs: tc.timeoutMs,
    }
    convStore.updateMessageForConv(convId, msgId, {
        toolCalls: [...existing, newTc],
    })
    // ★ 块级增量：tool_use 事件到达即记 tool_call 块（id = ${msgId}-tc-${tc.id}）
    recordToolCallBlock(convId, msgId, newTc)
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
    if (!existing.some(e => e.id === tc.id)) {
        // 工具尚未经 tool_use 事件加入消息 → 补建 toolCall 条目（保留 textOffset 交错）
        const textOffset = convState.streamBuffer.length
        convStore.updateMessageForConv(convId, msgId, {
            toolCalls: [...existing, {id: tc.id, name: tc.name, arguments: tc.arguments, status: 'running', textOffset, reason: tc.reason, terminal: tc.terminal, timeoutMs: tc.timeoutMs}],
        })
    } else {
        // ★ 已存在条目：tool_start 到达时主进程才注入 timeoutMs（tool_use 阶段可能缺失），
        //   补写进消息副本，使倒计时数据随消息持久化（模式切换/重载后仍可用）
        const needsTimeout = existing.some(e => e.id === tc.id && e.timeoutMs === undefined && tc.timeoutMs !== undefined)
        if (needsTimeout) {
            const patched = existing.map(e => e.id === tc.id && e.timeoutMs === undefined ? {...e, timeoutMs: tc.timeoutMs} : e)
            convStore.updateMessageForConv(convId, msgId, {toolCalls: patched})
        }
    }

    // ★ 倒计时起点：tool_start 到达时刻（已存在则更新，否则注册）
    registerRunningTool(tc.id, tc.timeoutMs)

    get().updateConvData(convId, {
        streamingMessageId: msgId,
        agentState: {...convState.agentState, status: 'running', phase: 'executing_tools'},
        executingToolsMessage: null,
    })
}

/** 注册运行中工具的倒计时数据（tool_start 到达时刻为起点） */
function registerRunningTool(toolCallId: string, timeoutMs?: number) {
    const updates = {
        status: 'running' as const,
        startedAt: Date.now(),
        ...(timeoutMs !== undefined ? {timeoutMs} : {}),
    }
    const store = useToolCallsStore.getState()
    if (store.states[toolCallId]) {
        store.updateToolCall(toolCallId, updates)
    } else {
        store.registerToolCall(toolCallId, updates)
    }
}

export function handleToolProgress(ctx: StreamCtx) {
    const {get, convId, isAgentAborted, event} = ctx
    if (isAgentAborted) return
    if (!event.toolCallId) return
    const convState = get().convAgentStates[convId] || createDefaultConvData()
    if (!convState.streamingMessageId && convState.agentState.status === 'idle') return

    // ★ retryBackoff 每秒推送的剩余秒数 → 渲染为带紧迫态的倒计时对象
    if (typeof (event as any).retryCountdown === 'number') {
        get().updateConvData(convId, {
            executingToolsMessage: {
                label: `重试中，${(event as any).retryCountdown}s 后重试...`,
                urgent: (event as any).retryCountdown <= 3,
            },
        })
        return
    }

    // 状态缺失时同步注册（确保 UI 立即可见），已存在时走批量队列（防抖高频更新）
    const existingState = useToolCallsStore.getState().states[event.toolCallId]
    if (!existingState || existingState.status === 'pending') {
        useToolCallsStore.getState().registerToolCall(event.toolCallId, {status: 'running', progress: event.progress})
    } else {
        useToolCallsStore.getState().updateToolCall(event.toolCallId, {progress: event.progress})
    }
}

export function handleToolDetail(ctx: StreamCtx) {
    const {get, isAgentAborted, event} = ctx
    if (isAgentAborted) return
    if (!event.toolCallId) return
    const state = get()
    if (!state.streamingMessageId && state.agentState.status === 'idle') return
    useToolCallsStore.getState().updateToolCall(event.toolCallId, {
        status: 'running',
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

    // ★ 完成态兜底：agent 工具结果携带 _meta.childConvId 时给父工具补写子会话关联
    //   （运行中已由 subagent_progress 写入，此处幂等覆盖；随增量落库持久化）
    const meta = (event.result as any)?._meta as {childConvId?: string} | undefined
    if (meta?.childConvId) {
        ensureAgentToolTaskId(convId, event.toolCallId, meta.childConvId)
    }

    const convMsgs = convStore.messagesMap[convId] || []
    const msg = convMsgs.find(m => m.id === msgId)
    const result = event.result ? normalizeToolResult(event.result) : null

    if (msg?.toolCalls && result && msgId) {
        useToolCallsStore.getState().setToolResult(event.toolCallId, result)
        const tc = msg.toolCalls.find(tc => tc.id === event.toolCallId)
        if (event.skillName && tc) {
            useToolCallsStore.getState().updateToolCall(event.toolCallId, {skillName: event.skillName} as any)
        }
        // ★ 内存释放：agent 工具完成态不再需要过程数据（思考/工具执行流），
        //   只保留最终输出（result）与 token 用量，避免长会话中大量子 Agent 的过程数据常驻内存。
        //   clearAgentProcessData 内部对非 agent / 无过程数据的工具自动短路
        useToolCallsStore.getState().clearAgentProcessData(event.toolCallId)
        scheduleToolResultUpdate(convId, msgId, event.toolCallId, result)
    }

    const newCount = Math.max(0, convState.runningToolCount - 1)
    const isDone = newCount <= 0
    get().updateConvData(convId, {
        runningToolCount: newCount,
        isThinkingAfterTools: isDone,
        agentState: {...convState.agentState, ...makeAgentState('running', isDone ? 'responding' : 'executing_tools')},
    })

    if (isActiveConv) {
        get().updateMessageContentBlocks(convId)
    }
}

/**
 * ★ 即时完成信号（tool_completed）：与 tool_start 的即时推送对称。
 *   并行工具场景下 Promise.all 会阻塞正式 tool_result，导致已完成工具
 *   的倒计时误判为「已超时」。此事件仅更新 UI 状态（停止倒计时），
 *   不递减 runningToolCount、不落库——这些由正式 tool_result 负责。
 */
export function handleToolCompleted(ctx: StreamCtx) {
    const {event} = ctx
    if (!event.toolCallId || !event.result) return
    useToolCallsStore.getState().setToolResult(event.toolCallId, normalizeToolResult(event.result))
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
    // 增量落库由 updateMessageForConv 内部调度（debounce 合并），无需立即全量 flush
}
