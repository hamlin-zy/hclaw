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

/**
 * 查找 taskId 对应的「子」toolCall：
 * 优先精确匹配 sub-<taskId> 前缀 id；未命中才回退按 taskId 模糊匹配（兼容旧数据）。
 * 不能直接按 taskId 匹配：父 agent 工具经 ensureAgentToolTaskId 补写后 taskId 相同，
 * 且排在子 toolCall 之前，模糊匹配会误命中父工具。
 */
function findSubToolCall(calls: Array<Record<string, any>> | undefined, taskId: string) {
    return calls?.find(tc => tc.id === `sub-${taskId}`)
        ?? calls?.find(tc => tc.name === 'agent' && tc.id.startsWith('sub-') && tc.taskId === taskId)
}

/**
 * 判断会话是否存在 agent 工具运行迹象（后台会话 streamingMessageId 缺失 /
 * convAgentStates 被归 idle 时的兜底信号，如渠道/调度器/cron 发起、窗口刷新后）
 */
function hasRunningAgentTool(convMsgs: Array<Record<string, any>>): boolean {
    return convMsgs.some(m => (m.toolCalls as any[] | undefined)?.some(
        tc => tc.name === 'agent' && tc.status === 'running',
    ))
}

export function handleAgentProgress(ctx: StreamCtx) {
    const {get, convId, isAgentAborted, event} = ctx
    if (isAgentAborted) return
    if (event.inputTokens === undefined) return
    // ★ 按会话取态（convAgentStates），不再用全局 streamingMessageId（仅活跃会话），
    //   避免后台主会话的 agent_progress 被误丢；无流式消息时回退查找 running agent 工具
    const convState = get().convAgentStates[convId] || createDefaultConvData()
    const convMsgs = useConversationStore.getState().messagesMap[convId] || []
    const hasSignal = !!convState.streamingMessageId
        || convState.agentState.status !== 'idle'
        || hasRunningAgentTool(convMsgs)
    if (!hasSignal) return
    const toolCallId = (event as any).toolCallId
    const msg = convMsgs.find(m => m.id === convState.streamingMessageId)
        ?? (toolCallId
            // ★ 按 toolCallId 锚定消息：多 running 消息时避免在错误消息中落空导致 tokenUsage 丢失
            ? convMsgs.find(m => (m.toolCalls as any[] | undefined)?.some(tc => tc.id === toolCallId))
            : convMsgs.find(m => (m.toolCalls as any[] | undefined)?.some(
                tc => tc.name === 'agent' && tc.status === 'running')))
    const agentTool = findAgentCall(msg?.toolCalls as any, (event as any).toolCallId)
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

/** 无 toolCallId 时回退定位父 agent 工具：仅当「running 且无 taskId」唯一时返回；多候选跳过避免错配 */
function locateUniqueRunningAgentTool(convMsgs: Array<Record<string, any>>, taskId: string) {
    const candidates = convMsgs.flatMap(m => (m.toolCalls as any[] | undefined)?.filter(
        tc => tc.name === 'agent' && tc.status === 'running' && !tc.taskId) ?? [])
    if (candidates.length === 1) return candidates[0]
    if (candidates.length > 1) {
        console.warn('[subagent_progress] 无 toolCallId 且存在多个 running agent 工具，跳过 taskId 补写以避免错配', taskId)
    }
    return undefined
}

export function handleSubagentProgress(ctx: StreamCtx) {
    const {get, convId, isAgentAborted, event} = ctx
    if (isAgentAborted) return
    if (!event.taskId || !event.progress) return
    const convState = get().convAgentStates[convId] || createDefaultConvData()
    const convStore = useConversationStore.getState()
    const convMsgs = convStore.messagesMap[convId] || []
    // ★ 后台会话守卫：streamingMessageId 可能缺失 / agentState 被归 idle
    //   （渠道/调度器/cron 发起、窗口刷新后），此处不再整事件丢弃，
    //   改为「尽量定位父 agent 工具再决定」：确无运行迹象才 return
    const hasSignal = !!convState.streamingMessageId
        || convState.agentState.status !== 'idle'
        || hasRunningAgentTool(convMsgs)
    if (!hasSignal) return

    // ★ 内联子 Agent（agentTool.ts 不产生 subagent_start，subagent_progress 无 toolCallId）：
    //   用「无 taskId 的 running agent 工具」回退定位父工具，补写 taskId（运行中即可跳转子会话）
    const progressToolCallId = (event as any).toolCallId
    const parentAgentTool = findAgentCall(
        convMsgs.find(m => m.id === convState.streamingMessageId)?.toolCalls,
        progressToolCallId,
        true,
    ) ?? (progressToolCallId
        ? (hasRunningAgentTool(convMsgs)
            ? findAgentCall(
                convMsgs.find(m => (m.toolCalls as any[] | undefined)?.some(tc => tc.id === progressToolCallId))?.toolCalls,
                progressToolCallId,
                true,
            )
            : undefined)
        : (hasRunningAgentTool(convMsgs)
            // ★ 与 subagent_start 防错配策略对齐（单 agent 内联场景仍唯一命中，行为不变）
            ? locateUniqueRunningAgentTool(convMsgs, event.taskId)
            : undefined))
    if (parentAgentTool) {
        ensureAgentToolTaskId(convId, parentAgentTool.id, event.taskId)
    }

    // B1：仅更新渲染层内存态 llmStats（UI 实时展示）；不再写回 messages.llm_stats 列
    // （repository 写侧已剥离，否则与 llm_usage 双源重复统计）
    const subLlmEvent = (event as any).subAgentStreamEvent
    if (subLlmEvent?.type === 'llm_call_done' && subLlmEvent.inputTokens !== undefined && convState.streamingMessageId) {
        // ★ 此分支不再整体 return：无 streamingMessageId 时仅跳过 llmStats 落库，
        //   后续 progressLog / subAgentStream 追加照常执行
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

    // ★ ensureAgentToolTaskId 内部经 updateMessageForConv 不可变写入了 taskId，
    //   进入函数时的 convMsgs 快照已过期（msgForSub 可能查不到），重读最新消息再定位
    const convMsgsForSub = useConversationStore.getState().messagesMap[convId] || []
    // ★ 消息定位：优先流式消息；后台会话 streamingMessageId 缺失时，
    //   按 taskId / toolCallId 回退查找包含对应 agent 工具的消息
    const msgForSub = convMsgsForSub.find(m => m.id === convState.streamingMessageId)
        ?? convMsgsForSub.find(m => (m.toolCalls as any[] | undefined)?.some(tc =>
            tc.name === 'agent'
            && (tc.taskId === event.taskId || ((event as any).toolCallId && tc.id === (event as any).toolCallId))))
    const agentTool = findSubToolCall(msgForSub?.toolCalls, event.taskId)
    // ★ 迟到 progress 守卫：subagent_done 清理 sub-<taskId> 运行时 key 后、父工具仍
    //   running 的窗口期内，同 taskId 的迟到 progress 会经 appendProgressLog /
    //   appendSubAgentStream 对不存在的 key 自动重建 running 态，使已完成子工具在
    //   UI 复燃。此处按消息内子工具终态拦截运行时状态写入（llmStats 落库在上文，
    //   不受影响；数据不丢，仅阻止状态复燃）。正常流中子工具必为 running，守卫放行。
    const subIsTerminal = agentTool?.status === 'success' || agentTool?.status === 'error'
    if (agentTool && !subIsTerminal) {
        useToolCallsStore.getState().appendProgressLog(agentTool.id, event.progress)
    }
    const parentTool = findAgentCall(msgForSub?.toolCalls, (event as any).toolCallId, true)
    if (parentTool && agentTool && !subIsTerminal) {
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
    if (agentTool && raw && !subIsTerminal) {
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
    const convStore = useConversationStore.getState()
    const convMsgs = convStore.messagesMap[convId] || []

    // ★ 后台会话守卫：不再因 streamingMessageId 缺失整批丢弃 subagent_start
    //   （渠道/调度器/cron 发起、窗口刷新后 convAgentStates 可能缺失/归 idle）。
    //   改为「尽量定位父 agent 工具再决定」：
    //   a) 优先在流式消息中按 toolCallId 定位；
    //   b) 回退在整个会话消息中按 toolCallId / running agent 工具定位；
    //   确实找不到运行迹象才 return。
    let msg = convState.streamingMessageId
        ? convMsgs.find(m => m.id === convState.streamingMessageId)
        : undefined
    let agentTool = findAgentCall(msg?.toolCalls, (event as any).toolCallId)
    if (!agentTool) {
        if ((event as any).toolCallId) {
            const candidate = convMsgs.find(m => (m.toolCalls as any[] | undefined)?.some(tc => tc.id === (event as any).toolCallId))
            agentTool = findAgentCall(candidate?.toolCalls, (event as any).toolCallId)
            if (agentTool && candidate) msg = candidate
        } else {
            // 无 toolCallId 回退（内联子 Agent 场景，真实 start 事件均携带 toolCallId）：
            // 仅当全会话唯一存在「running 且无 taskId」的 agent 工具时才补写；
            // 并发多 agent 时 taskId 无法区分，跳过补写避免错配到错误的父工具。
            const candidates = convMsgs.flatMap(m => (m.toolCalls as any[] | undefined)?.filter(
                tc => tc.name === 'agent' && tc.status === 'running' && !tc.taskId) ?? [])
            if (candidates.length === 1) {
                const candidateMsg = convMsgs.find(m => (m.toolCalls as any[] | undefined)?.includes(candidates[0]))
                if (candidateMsg) {
                    msg = candidateMsg
                    agentTool = candidates[0]
                }
            } else if (candidates.length > 1) {
                console.warn('[subagent_start] 无 toolCallId 且存在多个 running agent 工具，跳过 taskId 补写以避免错配', event.taskId)
            }
        }
    }
    if (!agentTool || !msg) return
    const streamingMsgId = msg.id
    // ★ 立即给父 agent 工具补写 taskId（taskId === childConvId，运行中即可跳转子会话）。
    //   agentTool.ts 在子会话创建成功瞬间即推送 subagent_start（携带 toolCallId），
    //   此处精确按 toolCallId 定位父工具并幂等补写，无需等 subagent_progress。
    ensureAgentToolTaskId(convId, agentTool.id, event.taskId)

    // ★ 守卫加严：父工具已是终态（迟到/重复事件）时仅保留 taskId 补写，
    //   不注册新的 running 子 toolCall（避免对已完成工具产生脏状态）
    if (agentTool.status === 'success' || agentTool.status === 'error') return

    const subToolCallId = `sub-${event.taskId}`

    // ★ 重新从 store 读取最新消息：ensureAgentToolTaskId 内部经 updateMessageForConv
    //   不可变写入了 taskId，旧快照 msg.toolCalls 若整体覆盖写回会把 taskId 回滚
    const freshMsg = useConversationStore.getState().messagesMap[convId]?.find(m => m.id === streamingMsgId)
    if (!freshMsg) return

    // 防御性检查（基于最新消息）：避免重复 subagent_start 导致 toolCalls 中创建重复条目
    const alreadyExists = freshMsg.toolCalls?.some(tc => tc.id === subToolCallId)
    if (!alreadyExists) {
        useToolCallsStore.getState().registerToolCall(subToolCallId, {
            status: 'running',
            progress: '子 Agent 启动中...',
        }, convId)
        useToolCallsStore.getState().appendProgressLog(subToolCallId, '启动中...')
        if (agentTool.id !== subToolCallId) {
            useToolCallsStore.getState().appendProgressLog(agentTool.id, `启动子 Agent: ${event.description.slice(0, 60)}`)
        }
        const existing = freshMsg.toolCalls || []
        useConversationStore.getState().updateMessageForConv(convId, streamingMsgId, {
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

export function handleSubagentDone(ctx: StreamCtx) {
    const {get, convId, isAgentAborted, event} = ctx
    if (isAgentAborted) return
    if (!event.taskId) return
    const convState = get().convAgentStates[convId] || createDefaultConvData()
    const convStore = useConversationStore.getState()

    const convMsgs = convStore.messagesMap[convId] || []
    // ★ 消息定位：优先流式消息；后台会话 streamingMessageId 缺失时，与 start 对称地
    //   按 taskId 回退查找包含对应 agent 工具的消息（否则子 toolCall 永远停在 running）
    const msg = (convState.streamingMessageId
        ? convMsgs.find(m => m.id === convState.streamingMessageId)
        : undefined)
        ?? convMsgs.find(m => (m.toolCalls as any[] | undefined)?.some(
            tc => tc.name === 'agent' && tc.taskId === event.taskId))
    const subTool = findSubToolCall(msg?.toolCalls, event.taskId)
    if (!subTool) return
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
