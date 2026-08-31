// ── 交互/生命周期事件处理器 ────────────────────────
// done, error, ask_user, warning, permission-rules-updated, permission_confirm

import type {StreamCtx} from './streamContext'
import type {ConvAgentData} from '../types'
import {IDLE_STATE, makeAgentState, createDefaultConvData} from '../defaultState'
import {useConversationStore} from '../../conversationStore'
import {textBlockId} from '../contentBlocks'
import {useAgentStore} from '..'
import {
    flushTextBatch,
    clearTextBatch,
} from '../batching/textBatch'
import {
    flushThinkingBatch,
    clearThinkingBatch,
} from '../batching/thinkingBatch'
import {flushToolResultBatch} from '../batching/toolResultBatch'
import {parseCommands} from '../helpers/misc'
import {clearConversationRuntimeState} from '../helpers/convHelpers'
import {ensureStreamingMessage} from './streamCore'

/**
 * 冲刷并清空该会话残留的流式批数据（text + thinking）。
 * 结束/错误事件必须把微任务合并的最后一段内容写入 store，
 * 否则缓冲区内未刷出的 chunk 会丢失。
 */
function flushPendingStreamBatches(convId: string, streamingMessageId: string | null) {
    flushTextBatch(convId, streamingMessageId)
    clearTextBatch(convId)
    flushThinkingBatch(convId)
    clearThinkingBatch(convId)
}

export async function handleDone(ctx: StreamCtx) {
    const {get, convId, event} = ctx
    const convStore = useConversationStore.getState()

    // ★ 先冲刷残留批数据，再取收尾快照：
    //   批处理化后 thinking 内容可能仍滞留在微任务缓冲区（abort/紧邻 done 等时序），
    //   若先取快照再 flush，后续 thinkBlock / contentBlocks 收尾会用缺最后一段的
    //   旧快照覆盖 flush 刚写入的完整内容。正常路径下 flush 无操作，快照内容一致，
    //   行为不变。
    const streamingMessageId = get().convAgentStates[convId]?.streamingMessageId ?? null
    flushPendingStreamBatches(convId, streamingMessageId)
    const doneConvData = get().convAgentStates[convId] || createDefaultConvData()

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

        // ★ 收尾前同步冲刷 rAF 延迟的 tool_result 批：tool_result 经
        //   scheduleToolResultUpdate 排队等 requestAnimationFrame，若 done 与工具结果
        //   同事件循环到达，rAF 尚未触发 → 直接 flush 读到空批，tool_result 延后到
        //   下一帧才进 dirty map，而 finalizeMessageDelta（end 块）同步先进 → 两次 IPC
        //   落库使 DB 块序变成 text → end → tool_result（跨 turn 缓存断裂根因）。
        //   flush 对空批为无操作，可直接调用。
        flushToolResultBatch(convId)

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
                    if (textSlice) assembled.push({id: textBlockId(doneConvData.streamingMessageId, lastOffset), type: 'text', text: textSlice})
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
                if (remainingText) assembled.push({id: textBlockId(doneConvData.streamingMessageId, lastOffset), type: 'text', text: remainingText})
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

        // ★ ledger 补充：think 块 status 置 complete 的落库职责已由主进程承担（Phase 3）。
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
        // ★ 方案 2：本用户 turn 结束，清除 turnIndex（下一用户 turn 首轮 agent_start 从 0 重新计数）
        currentTurnIndex: undefined,
        streamBlocks: [],
        streamingMessageId: null,
        isThinkingAfterTools: false,
        runningToolCount: 0,
        // 如果刚发生过 error，保留 errorMessage 不清理
        ...(doneConvData.agentState.status !== 'error' ? {errorMessage: null} : {}),
        executingToolsMessage: null,
        // ★ 收尾即清循环警告条（含 loop_detected 路径，与 aborted 同款收尾）
        loopWarning: undefined,
    })

    // ★ 段边界落库（done 收尾 flush）已随渲染端落库退出（Phase 3）删除。

    // loop_detected 与 aborted 走同款收尾（不触发 pendingMessages 续跑）；UI 文案 Task 5 完善
    if (event.reason !== 'aborted' && event.reason !== 'loop_detected') {
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

    // ★ 即时清理：本轮结束即释放段边界状态与残留的运行时工具状态
    //   （正常工具已完成时已逐个 clearToolCall；此处兜底异常残留，如断连/漏事件）
    clearConversationRuntimeState(convId)
}

export function handleError(ctx: StreamCtx) {
    const {get, set, convId, event} = ctx
    const errorMessage = event.error || '未知错误'
    const errorConvData = get().convAgentStates[convId] || createDefaultConvData()
    // ★ 与 done/injected 对称：先取进入 error 前的流式消息快照再冲刷。
    //   （末尾 updateConvData 会把 streamingMessageId 置 null，必须先捕获，
    //    才能在 flush 前补 endedAt，防无 endedAt 快照覆盖主进程 final 写）
    const errorMsgId = errorConvData.streamingMessageId
    flushPendingStreamBatches(convId, errorMsgId)

    // 无流式消息时创建占位气泡，使错误提示有气泡可挂载（ensureStreamingMessage 内部幂等）
    ensureStreamingMessage(get, convId)

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

    // ★ 与 done/injected 对称：flush 前先补 endedAt（防无 endedAt 快照覆盖主进程 final 写）。
    //   无流式消息的 error 此分支自然跳过，flush 仍执行。
    if (errorMsgId) {
        useConversationStore.getState().updateMessageForConv(convId, errorMsgId, {
            endedAt: Date.now(),
        })
        // ★ 收尾前同步冲刷 rAF tool_result 批（与 handleDone 同因：确保
        //   tool_result 先于 end 进入 dirty map 同批落库）
        flushToolResultBatch(convId)
        // ★ 块级增量收尾（error finalize）已随渲染端落库退出（Phase 3）删除。
    }
    // ★ 即时清理：error 收尾即清（与 handleDone 对称）
    clearConversationRuntimeState(convId)
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

// ── LLM 循环检测警告条（loop_suspected / loop_escalated） ──
// notify 档：主进程检测门报告疑似循环，写入 convAgentStates[convId].loopWarning
// 供 LoopWarningBanner 渲染；任务继续运行（pause 档走 ask_user 路径，不经此 handler）
export function handleLoopSuspected(ctx: StreamCtx) {
    const {get, convId, event} = ctx
    const e = event as any
    if (!e.fingerprint) return
    get().updateConvData(convId, {
        loopWarning: {
            fingerprint: e.fingerprint,
            // shared events.ts 用 loopKind 命名，main stream.ts 用 kind——双读兼容
            kind: e.loopKind ?? e.kind,
            repeatCount: e.repeatCount ?? 0,
            threshold: e.threshold ?? 0,
            detail: e.loopDetail ?? e.detail ?? [],
            escalated: event.type === 'loop_escalated',
        },
    })
}

/** 升级轮次与首次报告同构（escalated=true 仅换文案），共用 handler */
export const handleLoopEscalated = handleLoopSuspected

export function handleWarning(ctx: StreamCtx) {
    const {get, set, convId, event} = ctx
    const msg = event.message || ''
    console.warn(`[Agent] 警告: ${msg}`)

    // ── 重试通知：来自 #retryBackoff 的重试进度消息 ──
    // 显示在最后一条助手消息底部（气泡内 statusNote），不打断 agent 运行状态
    const retryMatch = msg.match(/^retry\s+(\d+)\/(\d+)[：:]\s*(.*)/)
    if (retryMatch) {
        const [, attempt, total, errorDetail] = retryMatch
        // ★ 已取消重试：主进程 retryBackoff 在 abort 时发送，明确提示用户等待已终止
        const cancelMatch = msg.match(/^retry\s+(\d+)\/(\d+)[：:]\s*已取消重试/)
        if (cancelMatch) {
            get().updateConvData(convId, {
                executingToolsMessage: {label: '重试已取消', urgent: true},
            })
            return
        }
        // ★ 占位气泡：首次 LLM 调用即失败时（无 text/tool 事件），渲染端还没有
        //   assistant 消息 → 创建空占位并写入 streamingMessageId，使重试提示有
        //   气泡可挂载；后续 text/thinking/tool_start 复用该 ID（handleText 走
        //   else 分支 accumulateTextBatch），避免重复建消息产生幽灵气泡。
        //   （与 handleError 无 errorMsgId 时的占位逻辑对称）
        ensureStreamingMessage(get, convId)
        get().updateConvData(convId, {
            executingToolsMessage: {label: `重试 ${attempt}/${total}：${errorDetail}`, urgent: false},
            // 保持 agentState 不变（仍在 running）
        })
        return
    }

    // 注：max_tokens 截断的 pinned toast 通知已随 hookResults 状态链移除
    // （Task 1: feat/permission-window-hook-cleanup）。
    // 截断提示回落至下方通用警告路径（写入 message metadata.warning）。

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

    // 刷新缓冲区，确保当前消息内容（文本 + 思考）已完整写入
    if (convState.streamingMessageId) {
        // ★ 与 done/error 一致的冲刷序列：thinking 批处理化后，
        //   注入瞬间残留的 thinking batch 若不冲刷，会在下次 flush 时串入新消息
        flushPendingStreamBatches(convId, convState.streamingMessageId)

        // ★ 收尾前同步冲刷 rAF tool_result 批（与 handleDone 同因：确保
        //   tool_result 先于 end 进入 dirty map 同批落库）
        flushToolResultBatch(convId)
        // ★ 竞态防护：先补旧消息 endedAt（主进程 doMergeAndPersist(oldPending,true) 已写 final），
        //   再 flush，避免无 endedAt 快照覆盖
        useConversationStore.getState().updateMessageForConv(convId, convState.streamingMessageId, {
            endedAt: Date.now(),
        })
        // ★ 块级增量收尾（injected finalize）已随渲染端落库退出（Phase 3）删除。
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

    // 渲染端落库已收敛至主进程（Phase 3），原 saveCurrentConversation 调用删除
}
