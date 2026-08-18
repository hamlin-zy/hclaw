// ── 核心流式事件处理器 ──────────────────────────────
// begin, agent_start, text, thinking

import type {StreamCtx} from './streamContext'
import {STREAMING_STATE, makeAgentState, createDefaultConvData} from '../defaultState'
import {useConversationStore, recordTextBlock} from '../../conversationStore'
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
        // ★ 块级增量：第一条 text 也需切块落库（纯文本回复/无工具调用的首个段永远不走 else 分支）。
        //   后续 text 经 textBatch → flushTextBatch → recordTextBlock 切块，此处直接为第一条切块。
        recordTextBlock(convId, id, textContent)
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
        msgId = (event.messageId as string | undefined) || crypto.randomUUID()
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
