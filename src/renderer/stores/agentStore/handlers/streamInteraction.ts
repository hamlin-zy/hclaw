// ── 交互/生命周期事件处理器 ────────────────────────
// done, error, ask_user, warning, permission-rules-updated, permission_confirm

import type {StreamCtx} from './streamContext'
import type {ConvAgentData} from '../types'
import {IDLE_STATE, makeAgentState, createDefaultConvData} from '../defaultState'
import {useConversationStore} from '../../conversationStore'
import {useAgentStore} from '..'
import {
    flushTextBatch,
    clearTextBatch,
} from '../batching/textBatch'
import {
    flushToolResultBatch,
    clearToolResultBatchData,
    getToolResultBatchMap,
} from '../batching/toolResultBatch'
import {parseCommands} from '../helpers/misc'
import {saveCurrentConversation} from '../helpers/convHelpers'

export async function handleDone(ctx: StreamCtx) {
    const {get, convId, event} = ctx
    const doneConvData = get().convAgentStates[convId] || createDefaultConvData()
    const convStore = useConversationStore.getState()
    flushTextBatch(convId, doneConvData.streamingMessageId)
    clearTextBatch(convId)

    if (doneConvData.streamingMessageId) {
        const endedAt = Date.now()
        convStore.updateMessageForConv(convId, doneConvData.streamingMessageId, {endedAt})

        if (doneConvData.thinkingContent) {
            convStore.updateMessageForConv(convId, doneConvData.streamingMessageId, {
                thinkBlock: {
                    id: `think-${doneConvData.streamingMessageId}`,
                    content: doneConvData.thinkingContent,
                    status: 'complete',
                    timestamp: endedAt,
                },
            })
        }

        const trBatch = getToolResultBatchMap()[convId]
        if (trBatch && trBatch.size > 0) {
            flushToolResultBatch(convId)
        }
        clearToolResultBatchData(convId)

        const streamBlocks = doneConvData.streamBlocks
        const fullText = doneConvData.streamBuffer
        if (streamBlocks.length > 0) {
            const convMsgs = convStore.messagesMap[convId] || []
            const currentMsg = convMsgs.find(m => m.id === doneConvData.streamingMessageId)
            const toolCallMap = new Map<string, import('@shared/types').ToolCall>()
            if (currentMsg?.toolCalls) {
                for (const tc of currentMsg.toolCalls) {
                    toolCallMap.set(tc.id, tc)
                }
            }
            const assembled: import('@shared/types').ContentBlock[] = []
            let lastOffset = 0
            const sortedBlocks = [...streamBlocks].sort((a, b) => a.textOffset - b.textOffset)
            for (const sb of sortedBlocks) {
                if (sb.textOffset > lastOffset) {
                    const textSlice = fullText.slice(lastOffset, sb.textOffset)
                    if (textSlice) assembled.push({id: `text-${crypto.randomUUID()}`, type: 'text', text: textSlice})
                }
                if (sb.type === 'think') {
                    assembled.push({
                        id: sb.id, type: 'think',
                        thinkBlock: {
                            id: sb.id, content: sb.thinkContent || '', status: 'complete', timestamp: endedAt,
                            ...(sb.thinkSignature ? {signature: sb.thinkSignature} : {}),
                        },
                    })
                } else if (sb.type === 'tool_use' && sb.toolCall) {
                    const latestTc = toolCallMap.get(sb.toolCall.id) || sb.toolCall
                    assembled.push({id: sb.id, type: 'tool_use', toolCall: latestTc})
                }
                if (sb.textOffset > lastOffset) lastOffset = sb.textOffset
            }
            if (lastOffset < fullText.length) {
                const remainingText = fullText.slice(lastOffset)
                if (remainingText) assembled.push({id: `text-${crypto.randomUUID()}`, type: 'text', text: remainingText})
            }
            if (assembled.length > 0) {
                convStore.updateMessageForConv(convId, doneConvData.streamingMessageId!, {contentBlocks: assembled})
            }
        }

        const cmdMsg = (convStore.messagesMap[convId] || []).find(m => m.id === doneConvData.streamingMessageId)
        if (cmdMsg?.commandExecution) {
            convStore.updateMessageForConv(convId, doneConvData.streamingMessageId, {
                commandExecution: {...cmdMsg.commandExecution, status: 'done', endTime: endedAt},
            })
        }
    }

    get().updateConvData(convId, {
        agentState: {
            ...doneConvData.agentState,
            ...IDLE_STATE,
            currentModelName: undefined,
            currentModelProvider: undefined,
        },
        streamBuffer: '',
        thinkingContent: null,
        streamBlocks: [],
        streamingMessageId: null,
        isThinkingAfterTools: false,
        runningToolCount: 0,
        // 如果刚发生过 error，保留 errorMessage 不清理
        ...(doneConvData.agentState.status !== 'error' ? {errorMessage: null} : {}),
        executingToolsMessage: null,
    })

    if (event.reason !== 'aborted') {
        const pendingMsgs = get().convAgentStates[convId]?.pendingMessages
        if (pendingMsgs && pendingMsgs.length > 0) {
            const [firstMsg, ...remainingMsgs] = pendingMsgs
            get().updateConvData(convId, {pendingMessages: remainingMsgs})
            get().startAgent({
                conversationId: convId,
                message: firstMsg.content,
                messageAttachments: firstMsg.attachments?.map(f => ({path: f.path, name: f.name})),
                messageMetadata: firstMsg.metadata,
            })
        }
    }
}

export function handleError(ctx: StreamCtx) {
    const {get, set, convId, event} = ctx
    const errorMessage = event.error || '未知错误'
    const errorConvData = get().convAgentStates[convId] || createDefaultConvData()
    flushTextBatch(convId, errorConvData.streamingMessageId)
    clearTextBatch(convId)

    if (!errorConvData.streamingMessageId) {
        const newId = crypto.randomUUID()
        useConversationStore.getState().addMessageToConv(convId, {id: newId, role: 'assistant', content: ''})
        get().updateConvData(convId, {streamingMessageId: newId})
    }

    // 同时设置 per-conversation 和顶层 errorMessage，防御性 fallback
    get().updateConvData(convId, {
        agentState: {...errorConvData.agentState, ...makeAgentState('error', 'idle')},
        errorMessage,
        executingToolsMessage: null, // 清除重试状态消息，让 errorMessage 显示
        isThinkingAfterTools: false,
        runningToolCount: 0,
        streamingMessageId: null,
    })
    set((state: any) => ({
        errorMessage: state.errorMessage || errorMessage,
        agentState: {...state.agentState, status: 'error'},
    }))
}

export async function handleAskUser(ctx: StreamCtx) {
    const {convId, isAgentAborted, event} = ctx
    if (isAgentAborted) return
    const {question = '', requestId, options, multiSelect = false} = event as any
    const questionText = `\n\n> 🤔 **待确认**: ${question}`
    const updateContent = (convState: ConvAgentData) => ({
        content: convState.streamBuffer + questionText,
    })
    await handleConvEvent({
        eventConversationId: convId,
        pendingKey: 'pendingQuestion',
        pendingValue: {question, options, multiSelect, requestId},
        onActiveUpdate: (convStore, convState) =>
            convStore.updateMessage(convState.streamingMessageId!, updateContent(convState)),
        onInactiveUpdate: (convStore, convState) =>
            convStore.updateMessageForConv(convId, convState.streamingMessageId!, updateContent(convState)),
    })
}

export function handleWarning(ctx: StreamCtx) {
    const {get, set, convId, event} = ctx
    const msg = event.message || ''
    console.warn(`[Agent] 警告: ${msg}`)

    // ── 重试通知：来自 #retryBackoff 的重试进度消息 ──
    // 显示在左下角状态指示器（带 spinner），不打断 agent 运行状态
    const retryMatch = msg.match(/^retry\s+(\d+)\/(\d+)[：:]\s*(.*)/)
    if (retryMatch) {
        const [, attempt, total, errorDetail] = retryMatch
        const retryLabel = `重试 ${attempt}/${total}：${errorDetail}`
        get().updateConvData(convId, {
            executingToolsMessage: retryLabel,
            // 保持 agentState 不变（仍在 running），不清除 streamingMessageId
        })
        return
    }

    // HTTP 非 200 响应（如 429 额度超限、401 认证失败、400 参数错误等）
    // 不写入消息内容，而是显示在左下角状态栏，避免干扰对话
    const httpErrorMatch = msg.match(/(\d{3})\s+(Too Many Requests|Unauthorized|Forbidden|Bad Request|Not Found|Service Unavailable|Internal Server Error|exceeded|expired|invalid|failed)/i)
    if (httpErrorMatch || /\[(429|401|403|400|404|500|502|503)\]/.test(msg)) {
        const errorConvData = get().convAgentStates[convId] || createDefaultConvData()
        get().updateConvData(convId, {
            agentState: {...errorConvData.agentState, ...makeAgentState('error', 'idle')},
            errorMessage: msg,
            isThinkingAfterTools: false,
            runningToolCount: 0,
            streamingMessageId: null,
        })
        return
    }

    const convMsgState = get().convAgentStates[convId]
    const convMsgId = convMsgState?.streamingMessageId
    if (convMsgId) {
        const msgs = useConversationStore.getState().messagesMap[convId] || []
        const currentMsg = msgs.find(m => m.id === convMsgId)
        useConversationStore.getState().updateMessageForConv(convId, convMsgId, {
            metadata: {
                ...(currentMsg as any)?.metadata,
                warning: msg,
            },
        } as any)
    } else if (get().streamingMessageId) {
        // 兜底：fallback 到顶层 streamingMessageId（兼容旧会话）
        useConversationStore.getState().updateMessage(get().streamingMessageId!, {
            metadata: {
                ...(useConversationStore.getState().loadedMessages.find(m => m.id === get().streamingMessageId) as any)?.metadata,
                warning: msg,
            },
        } as any)
    } else {
        const id = crypto.randomUUID()
        useConversationStore.getState().addMessage({
            id,
            role: 'assistant',
            content: `> ⚠️ **配置警告**\n> ${msg}`,
        })
        set({streamingMessageId: id})
    }
}

export async function handlePermissionRulesUpdated(ctx: StreamCtx) {
    const {get} = ctx
    await get().fetchPermissionRules()
}

export async function handlePermissionConfirm(ctx: StreamCtx) {
    const {convId, isAgentAborted, event} = ctx
    if (isAgentAborted) return
    const question = event.question || ''
    const requestId = event.requestId || `perm-${Date.now()}`
    const commands = parseCommands(question)

    const permissionConfirm = {
        requestId,
        question,
        commands: commands.length > 0 ? commands : undefined,
        status: 'pending' as const,
        createdAt: Date.now(),
    }

    await handleConvEvent({
        eventConversationId: convId,
        pendingKey: 'pendingPermissionConfirm',
        pendingValue: {question, requestId},
        onActiveUpdate: async (convStore, convState) => {
            convStore.updateMessage(convState.streamingMessageId!, {permissionConfirm})
            const currentMsg = convStore.loadedMessages.find(m => m.id === convState.streamingMessageId)
            if (currentMsg?.content) {
                const cleanedContent = currentMsg.content
                    .replace(/\n\n> ⚠️ \*\*权限确认\*\*:[^\n]*/g, '')
                    .replace(/\n\n⚠️ 权限确认[^\n]*/g, '')
                    .replace(/\n\n⚠️ 命令确认[^\n]*\n[\s\S]*$/g, '')
                    .replace(/\n\n> ⚠️ 命令确认[^\n]*/g, '')
                    .trim()
                if (cleanedContent !== currentMsg.content) {
                    convStore.updateMessage(convState.streamingMessageId!, {content: cleanedContent})
                }
            }
        },
        onInactiveUpdate: (convStore, convState) => {
            convStore.updateMessageForConv(convId, convState.streamingMessageId!, {permissionConfirm})
            const inactiveMsgs = convStore.messagesMap[convId] || []
            const currentMsg = inactiveMsgs.find(m => m.id === convState.streamingMessageId)
            if (currentMsg?.content) {
                const cleanedContent = currentMsg.content
                    .replace(/\n\n> ⚠️ \*\*权限确认\*\*:[^\n]*/g, '')
                    .replace(/\n\n⚠️ 权限确认[^\n]*/g, '')
                    .replace(/\n\n⚠️ 命令确认[^\n]*\n[\s\S]*$/g, '')
                    .replace(/\n\n> ⚠️ 命令确认[^\n]*/g, '')
                    .trim()
                if (cleanedContent !== currentMsg.content) {
                    convStore.updateMessageForConv(convId, convState.streamingMessageId!, {content: cleanedContent})
                }
            }
        },
    })
}

// ── 多会话事件处理辅助 ──────────────────────────────

interface ConvEventHandlerParams {
    eventConversationId: string
    pendingKey: 'pendingQuestion' | 'pendingPermissionConfirm'
    pendingValue: any
    onTopLevelUpdate?: () => void
    onActiveUpdate: (convStore: ReturnType<typeof useConversationStore.getState>, convState: ConvAgentData) => void | Promise<void>
    onInactiveUpdate?: (convStore: ReturnType<typeof useConversationStore.getState>, convState: ConvAgentData) => void
}

/**
 * 用户消息注入：结束当前 assistant 消息流，准备开启新消息
 *
 * 当用户在 agent 运行中插入新消息时触发。需要：
 * 1. 刷新当前消息的文本缓冲区
 * 2. 重置 streamingMessageId，让后续 text/tool_use 事件创建新 assistant 消息
 */
export function handleUserMessageInjected(ctx: StreamCtx) {
    const {get, convId} = ctx
    const convState = get().convAgentStates[convId] || createDefaultConvData()

    // 刷新缓冲区，确保当前消息内容已完整写入
    if (convState.streamingMessageId) {
        flushTextBatch(convId, convState.streamingMessageId)
        clearTextBatch(convId)

        const trBatch = getToolResultBatchMap()[convId]
        if (trBatch && trBatch.size > 0) {
            flushToolResultBatch(convId)
        }
        clearToolResultBatchData(convId)
    }

    // 重置流式状态——清除累加器，避免新消息带入旧内容
    get().updateConvData(convId, {
        streamingMessageId: null,
        streamBuffer: '',
        thinkingContent: null,
        streamBlocks: [],
        isThinkingAfterTools: false,
        runningToolCount: 0,
        executingToolsMessage: null,
    })
}

async function handleConvEvent(params: ConvEventHandlerParams) {
    const {eventConversationId, pendingKey, pendingValue, onTopLevelUpdate, onActiveUpdate, onInactiveUpdate} = params
    const localConvStore = useConversationStore.getState()
    const isActiveConv = eventConversationId === localConvStore.activeConversationId
    const convState = useAgentStore.getState().convAgentStates[eventConversationId] || createDefaultConvData()

    useAgentStore.getState().updateConvData(eventConversationId, {
        [pendingKey]: pendingValue,
        agentState: {...convState.agentState, status: 'paused'},
    } as any)

    if (isActiveConv) onTopLevelUpdate?.()

    const updatedConvState = useAgentStore.getState().convAgentStates[eventConversationId] || createDefaultConvData()
    if (updatedConvState.streamingMessageId) {
        if (isActiveConv) {
            await onActiveUpdate(localConvStore, updatedConvState)
        } else {
            onInactiveUpdate?.(localConvStore, updatedConvState)
        }
    }

    if (isActiveConv) await saveCurrentConversation()
}
