// ── 崩溃恢复播种决策（P1-改动3） ──────────────────────────────
//
// recoverSessions 的纯决策层：以主进程流快照为唯一事实源，决定如何重建
// 渲染端流式状态。抽成纯函数以便单测（recoverSessions 本体依赖 electronAPI）。
//
// 缺陷背景：旧实现用 DB 最后一条 assistant 消息的 metadata.content 播种。
// assistant 正文不存 metadata（只在 blocks）→ streamBuffer 恒为空 → 空白
// 幽灵气泡；当前轮消息行未落库时会错位选中上一条历史消息。

import type {Message, ToolCall} from '@shared/types'

/** 主进程 agent-stream-snapshot 返回的快照结构（见 manager.accumulator.buildStreamSnapshot） */
export interface StreamSnapshot {
    streamingMessageId: string
    content: string
    thinkContent: string | null
    toolCalls: ToolCall[]
    /** DB 中该消息已有的 text 块数，恢复时作为 recordTextBlock 的块 id 序号基线 */
    dbTextBlockCount: number
}

export interface RecoverySeed {
    streamingMessageId: string
    streamBuffer: string
    thinkingContent: string | null
}

export interface RecoveryPlan {
    /** 非null：按此播种流式状态；null：worker 在跑但尚无累积，仅置运行态 */
    seed: RecoverySeed | null
    /** 快照中 status=running 的工具（真实在跑，保持运行态注册） */
    liveToolIds: string[]
    /** DB 中 running/pending 但快照不含的工具（结果在崩溃窗口丢失，标记取消） */
    staleToolIds: string[]
}

const isStale = (tc: {status?: string}) => tc.status === 'running' || tc.status === 'pending'

/**
 * 计算单个会话的恢复计划。
 *
 * @param snapshot 主进程流快照；null 表示 pending 未建立（首 token 前崩溃窗口）
 * @param msgs 已加载的会话消息（取最后一条 assistant 的工具状态做 stale 对账）
 */
export function planRecovery(snapshot: StreamSnapshot | null, msgs: Message[]): RecoveryPlan {
    const lastAssistantMsg = [...(msgs || [])].reverse().find(m => m.role === 'assistant')
    const dbTools = lastAssistantMsg?.toolCalls ?? []
    const snapToolIds = new Set(snapshot?.toolCalls.map(t => t.id) ?? [])

    const plan: RecoveryPlan = {
        seed: null,
        liveToolIds: [],
        staleToolIds: [],
    }

    if (snapshot) {
        // 快照是权威事实源：即使内容为空也播种 id，保证后续事件按 messageId 挂靠
        plan.seed = {
            streamingMessageId: snapshot.streamingMessageId,
            streamBuffer: snapshot.content,
            thinkingContent: snapshot.thinkContent,
        }
        for (const tc of snapshot.toolCalls) {
            if (isStale(tc)) plan.liveToolIds.push(tc.id)
        }
    }

    for (const tc of dbTools) {
        if (isStale(tc) && !snapToolIds.has(tc.id)) {
            plan.staleToolIds.push(tc.id)
        }
    }
    return plan
}
