// ── 统一播种路径：快照 v2 → 渲染层状态（spec §4.2） ─────────────
//
// buildSeedInstruction：纯函数，把主进程流快照翻译为对渲染层各 store 的
// 一组声明式变更指令（便于属性测试直接驱动，不依赖 zustand 单例）。
// applySeedInstruction：薄执行器，把指令落到 conversationStore /
// toolCallsStore / agentStore。恢复与正常路径自此共用 streamCore 的
// 增量叠加入口，本文件只负责「基线播种」一步。

import type {Message} from '@shared/types'
import {useConversationStore} from '../../conversationStore'
import {useToolCallsStore, type ToolCallState} from '../../toolCallsStore'
import type {ConvAgentData} from '../types'
import {STREAMING_STATE} from '../defaultState'
import {
    planRecovery,
    type ConvPendingPermission,
    type ConvPendingQuestion,
    type StreamSnapshot,
} from './recoverySeeding'

/** 流式载体消息 upsert（DB 无行 → 新增；有行 → 覆盖 content 并清除内存 endedAt） */
export interface SeedMessageUpsert {
    id: string
    content: string
}

/** 消息级补丁（stale 工具在消息 toolCalls 数组内标记取消） */
export interface SeedMessagePatch {
    messageId: string
    patch: Partial<Message>
}

/** toolCallsStore 注册项（快照全量工具 + 进度日志/子 Agent 流缓冲） */
export interface SeedToolRegistration {
    toolCallId: string
    initial: Partial<ToolCallState>
}

/** 一次会话播种的全部声明式变更 */
export interface SeedInstruction {
    seedMessage: SeedMessageUpsert | null
    messagePatches: SeedMessagePatch[]
    toolRegistrations: SeedToolRegistration[]
    convPatch: Partial<ConvAgentData>
}

/**
 * 把快照 v2 翻译为播种指令（纯函数）。
 *
 * @param snapshot 主进程流快照；null 表示 pending 未建立（首 token 前崩溃窗口），
 *   此时仅置运行态 + stale 对账，不指向任何历史消息（防错位幽灵气泡——
 *   孤儿消息收养由 ensureStreamingMessage 的统一语义负责）
 * @param msgs 已加载的会话消息
 */
export function buildSeedInstruction(snapshot: StreamSnapshot | null, msgs: Message[]): SeedInstruction {
    const {staleToolIds} = planRecovery(snapshot, msgs)

    // ── 消息级补丁：stale 工具标记取消（D7 保留），同步 toolCallsStore 回退防御 ──
    const messagePatches: SeedMessagePatch[] = []
    const toolRegistrations: SeedToolRegistration[] = []
    if (staleToolIds.length > 0) {
        const lastAssistantMsg = [...(msgs || [])].reverse().find(m => m.role === 'assistant')
        if (lastAssistantMsg) {
            const staleSet = new Set(staleToolIds)
            for (const tc of lastAssistantMsg.toolCalls || []) {
                if (!staleSet.has(tc.id)) continue
                toolRegistrations.push({
                    toolCallId: tc.id,
                    initial: {status: 'cancelled', progress: tc.progress || '会话中断, 工具已取消'},
                })
                if (tc.name === 'agent' && tc.taskId) {
                    toolRegistrations.push({
                        toolCallId: `sub-${tc.taskId}`,
                        initial: {status: 'cancelled', progress: '会话中断, 子 Agent 已取消'},
                    })
                }
            }
            messagePatches.push({
                messageId: lastAssistantMsg.id,
                patch: {
                    toolCalls: (lastAssistantMsg.toolCalls || []).map(tc =>
                        staleSet.has(tc.id) ? {...tc, status: 'cancelled' as const} : tc
                    ),
                } as Partial<Message>,
            })
        }
    }

    if (!snapshot) {
        return {seedMessage: null, messagePatches, toolRegistrations, convPatch: {agentState: STREAMING_STATE}}
    }

    // ── 快照全量工具注册：进度日志 / 子 Agent 流缓冲 / 进度态一并恢复，
    //    使崩溃前已展开的工具卡片时间轴无缝续显 ──
    for (const tc of snapshot.toolCalls) {
        const state = snapshot.toolStates[tc.id]
        const progressLog = (snapshot.progressLog[tc.id] ?? []).map(e => ({timestamp: e.timestamp, text: e.text}))
        const subAgentStream = (snapshot.subAgentStream[tc.id] ?? []).map(e => ({
            type: e.type,
            timestamp: e.timestamp,
            content: e.content,
        })) as ToolCallState['subAgentStream']
        toolRegistrations.push({
            toolCallId: tc.id,
            initial: {
                status: tc.status,
                ...(tc.progress ? {progress: tc.progress} : {}),
                ...(state?.progress ? {progress: state.progress} : {}),
                ...(state?.progressPercent != null ? {progressPercent: state.progressPercent} : {}),
                ...(state?.eta != null ? {eta: state.eta} : {}),
                ...(state?.detailStatus ? {detailStatus: state.detailStatus} : {}),
                ...(progressLog.length ? {progressLog} : {}),
                ...(subAgentStream?.length ? {subAgentStream} : {}),
            },
        })
    }

    const convPatch: Partial<ConvAgentData> = {
        agentState: STREAMING_STATE,
        streamingMessageId: snapshot.streamingMessageId,
        streamBuffer: snapshot.content,
        thinkingContent: snapshot.thinkContent,
        recoveredTextBlockBase: snapshot.dbTextBlockCount,
        runningToolCount: snapshot.runningToolCount,
        pendingQuestion: snapshot.pendingQuestion,
        pendingPermissionConfirm: snapshot.pendingPermissionConfirm,
        executingToolsMessage: null,
    }

    return {
        seedMessage: {id: snapshot.streamingMessageId, content: snapshot.content},
        messagePatches,
        toolRegistrations,
        convPatch,
    }
}

/**
 * 执行播种指令：把声明式变更落到真实 store。
 * 与 buildSeedInstruction 分离以便纯函数级属性测试。
 */
export function applySeedInstruction(convId: string, ins: SeedInstruction): void {
    const convStore = useConversationStore.getState()
    const toolCallsState = useToolCallsStore.getState()

    if (ins.seedMessage) {
        const exists = !!convStore.messagesMap[convId]?.some(m => m.id === ins.seedMessage!.id)
        if (!exists) {
            // DB 行未建（首 flush 前崩溃）→ 用快照数据占位
            convStore.addMessageToConv(convId, {
                id: ins.seedMessage.id,
                role: 'assistant',
                content: ins.seedMessage.content,
            })
        } else {
            // 已有半成品行 → 快照全文覆盖内存 content；
            // 同时清掉内存 endedAt：pending 仍活跃说明 worker 未终结，
            // endedAt 只可能是崩溃窗口竞态残影，保留会让 ensureStreamingMessage
            // 误判该载体已终结而另起新 id（幽灵气泡）
            convStore.updateMessageForConv(convId, ins.seedMessage.id, {
                content: ins.seedMessage.content,
                endedAt: undefined,
            })
        }
    }

    for (const p of ins.messagePatches) {
        convStore.updateMessageForConv(convId, p.messageId, p.patch)
    }

    for (const r of ins.toolRegistrations) {
        toolCallsState.registerToolCall(r.toolCallId, r.initial)
    }
}
