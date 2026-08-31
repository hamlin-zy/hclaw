// ── 核心流式事件处理器 ──────────────────────────────
// begin, agent_start, text, thinking

import type {StreamCtx, GetFn} from './streamContext'
import {STREAMING_STATE, makeAgentState, createDefaultConvData} from '../defaultState'
import {useConversationStore} from '../../conversationStore'
import {
    accumulateTextBatch,
    scheduleImmediateTextFlush,
} from '../batching/textBatch'
import {
    accumulateThinkingBatch,
    scheduleImmediateThinkingFlush,
} from '../batching/thinkingBatch'

/**
 * 判定当前 executingToolsMessage 是否为「重试相关」消息。
 * 覆盖两类来源：
 * - warning 对象分支：{label: '重试 1/10：...'} / {label: '重试已取消', urgent: true}
 * - 倒计时对象分支：{label: '重试中，Xs 后重试...', urgent: true}
 * - 兼容遗留字符串分支：'重试 1/10：...'（startsWith('重试 ') 语义保持不变）
 * LLM 成功恢复输出/工具调用时以此清除残留，避免状态栏冻结显示倒计时。
 */
export function isRetryMessage(msg: string | {label: string; urgent: boolean} | null): boolean {
    if (typeof msg === 'string') return msg.startsWith('重试 ')
    return msg ? msg.label.startsWith('重试') : false
}

/**
 * 确保会话存在可挂载流式内容的 assistant 占位消息，返回流式载体消息 id。
 *
 * 统一恢复路径（spec §4.2）：正常路径与崩溃恢复后增量叠加共用此唯一入口，
 * 语义分三步：
 * ① 已有活跃流式消息（无 endedAt）→ 直接复用其 id；
 * ② 吸收原 D5 竞态守卫：内存/DB 中存在未终结的 assistant 消息（首 token 前
 *    崩溃残留，endedAt 为空）→ 收养其 id 作为载体。recoverSessions 播种时
 *    亦已清除 seed 消息的内存 endedAt，故播种 id 同样经由此路径自然复用，
 *    无需 recoveredStreaming 特判标记；
 * ③ 全新占位（preferredId 优先）。
 *
 * abort 残留防御保留：streamingMessageId 指向已结束（endedAt 已写）且内存中
 * 不存在其他未终结 assistant 时，不复用该历史消息，生成新占位——避免新一轮
 * 流式内容挂到带结束时间戳的历史气泡上。
 *
 * @param preferredId 事件携带的目标消息 id（子会话 begin 事件由 agentTool 附带
 *   msg-<ts>-<rand> 累积器固定 id）。存在时以其创建占位，保证渲染端内存流式消息
 *   与主进程 SQLite 增量落库消息同 id —— 子会话首次打开时 switchActiveConversation
 *   按 id 去重合并两轨才不会产生重复气泡。不注册主进程：子会话持久化走 agentTool
 *   累积器路径（不经过主进程 pending 机制），注册了也无人消费。
 */
export function ensureStreamingMessage(get: GetFn, convId: string, preferredId?: string): string | null {
    const convState = get().convAgentStates[convId]
    const msgs = useConversationStore.getState().messagesMap[convId] || []
    if (convState?.streamingMessageId) {
        const existing = msgs.find(m => m.id === convState.streamingMessageId)
        // ① 活跃载体（未终结）直接复用；endedAt 已写（abort 后 done 丢失/竞态延迟
        //    残留）→ 失效，走下方重选，防止内容挂到历史消息上错乱
        if (!existing?.endedAt) return convState.streamingMessageId
        get().updateConvData(convId, {streamingMessageId: null})
    }
    // ② 事件显式携带目标 id（子会话累积器固定 id）时优先——子会话持久化走
    //    agentTool 累积器路径，必须与其 id 对齐，不做孤儿收养
    if (preferredId) {
        const placeholderId = preferredId
        useConversationStore.getState().addMessageToConv(convId, {id: placeholderId, role: 'assistant', content: ''})
        get().updateConvData(convId, {streamingMessageId: placeholderId})
        return placeholderId
    }
    // ③ 孤儿收养（吸收原 D5 竞态守卫）：内存/DB 中存在未终结的 assistant 消息
    //    （首 token 前崩溃残留）→ 复用其 id 作为载体，与主进程 pending 共用同一 id
    //   （done 合并不产生副本；注册链已随 Phase 3 渲染端停写删除）。recoverSessions
    //    播种已清除 seed 消息的内存 endedAt，播种 id 同样经由此路径自然复用，
    //    无需 recoveredStreaming 标记。
    // ★ 守卫：仅收养会话"最后一条消息"。若其后已出现新消息（尤其用户消息），
    //   说明该未终结 assistant 是历史异常残留（如 abort 终态丢失）——收养会把
    //   新响应合并进旧气泡，必须新建占位。
    const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : undefined
    const orphan = lastMsg && lastMsg.role === 'assistant' && !lastMsg.endedAt ? lastMsg : undefined
    if (orphan) {
        get().updateConvData(convId, {streamingMessageId: orphan.id})
        return orphan.id
    }
    // ④ 消息 id 单源（§3.6-1）：主进程 messageId 未到达时不自建占位 id（事件未到
    //    不建占位——begin 与首个内容事件间隔为毫秒级，无感知差异）。孤儿收养的
    //    seed id 来自主进程流快照（pending.id），天然对齐，注册链已随 Phase 3 删除。
    return null
}

export function handleBegin(ctx: StreamCtx) {
    const {get, convId, event} = ctx
    console.log('[handleStreamEvent] begin event, convId:', convId)
    const prevConvState = get().convAgentStates[convId] || createDefaultConvData()
    // ★ 占位气泡：LLM 调用开始（思考中）时若还没有 assistant 消息，创建空占位
    //   并写入 streamingMessageId，使运行状态提示（思考中/响应中）有气泡可挂载
    //   （气泡内 statusNote）；后续 text/tool_use 复用该 ID，避免重复建消息。
    //   事件携带 messageId（子会话 agentTool 附带的 msg-<ts> 累积器固定 id）时
    //   以其创建占位 → 与主进程 SQLite 增量落库消息同 id，切换会话去重合并不重复。
    const placeholderId = ensureStreamingMessage(get, convId, event.messageId)
    get().updateConvData(convId, {
        streamBuffer: prevConvState.streamBuffer,
        thinkingContent: prevConvState.thinkingContent,
        streamBlocks: prevConvState.streamBlocks,
        // ★ 保留已有 streamingMessageId（含占位），防止多轮 LLM 调用（tool → begin 第二轮）
        //   时清空 ID 导致后续 text 事件创建重复消息（幽灵气泡）
        streamingMessageId: placeholderId ?? prevConvState.streamingMessageId,
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

    // ★ 方案 2：每次 agent_start = 一次 LLM 调用轮次，递增 turnIndex 供块落库溯源。
    //   首轮（undefined→0）与后续轮（N→N+1）统一递增；done 收尾归零由 handleDone 处理。
    const prevTurn = agentStartConvState.currentTurnIndex
    const nextTurn = prevTurn === undefined ? 0 : prevTurn + 1
    get().updateConvData(convId, {currentTurnIndex: nextTurn})

    // ── 记录当前模型信息（用于输入框底部展示） ──
    const modelName = event.model
    // ★ 优先使用服务商名称（providers.name，人类可读），旧事件无该字段时回退 api 类型
    const provider = event.providerName ?? event.provider
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
    // 覆盖倒计时对象分支（{label: '重试中...'}）与遗留字符串分支（'重试 ...'）
    if (isRetryMessage(convState.executingToolsMessage)) {
        get().updateConvData(convId, {executingToolsMessage: null})
    }

    if (convState.isThinkingAfterTools) {
        get().updateConvData(convId, {isThinkingAfterTools: false})
    }

    if (!convState.streamingMessageId) {
        // ★ id 单源（§3.6-1）：只使用事件 payload 的 messageId（主进程对所有内容事件
        //   注入 pending.id）；缺失时不自建 id，跳过建消息（正常流程 begin 已下发）
        const id = event.messageId as string | undefined
        if (!id) return
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
    const {get, convId, isAgentAborted, event} = ctx
    if (isAgentAborted) return
    const convState = get().convAgentStates[convId] || createDefaultConvData()
    if (convState.streamingMessageId === null && convState.agentState.status === 'idle') return

    const convStore = useConversationStore.getState()

    // 清除重试状态消息（成功重试后 LLM 开始输出思考内容）
    // 覆盖倒计时对象分支（{label: '重试中...'}）与遗留字符串分支（'重试 ...'）
    if (isRetryMessage(convState.executingToolsMessage)) {
        get().updateConvData(convId, {executingToolsMessage: null})
    }

    const thinkChunk = event.content || ''

    // ★ queueMicrotask 批处理：与 text 对称，每个 thinking chunk 只累积到缓冲区，
    //   同微任务内多个块合并为一次 store 更新 + 一次 contentBlocks 重建。
    //   此前每个 chunk 都走 updateMessageForConv + updateMessageContentBlocks
    //   全量重建链，思考模式下高频 chunk 会持续占用渲染主线程导致 UI 卡死。
    let msgId = convState.streamingMessageId
    if (!msgId) {
        // ★ id 单源（§3.6-1）：只使用事件 payload 的 messageId，缺失时不自建
        msgId = (event.messageId as string | undefined) || null
        if (!msgId) return
        convStore.addMessageToConv(convId, {
            id: msgId,
            role: 'assistant',
            content: '',
        })
        get().updateConvData(convId, {streamingMessageId: msgId})
    }

    const isAfterTools = convState.isThinkingAfterTools
    get().updateConvData(convId, {
        // 先同步更新 agentState（thinking 指示器即时响应），thinkingContent 由批处理合并写入
        isThinkingAfterTools: isAfterTools ? false : convState.isThinkingAfterTools,
        agentState: {...convState.agentState, ...makeAgentState('thinking', isAfterTools ? 'waiting_for_response' : 'streaming')},
    })

    accumulateThinkingBatch(convId, thinkChunk)
    scheduleImmediateThinkingFlush(convId, msgId)

    // 仅活跃会话需要 contentBlocks 重建；批处理 flush 内部已按活跃会话判断执行，
    // 此处不再重复调用 updateMessageContentBlocks。
}
