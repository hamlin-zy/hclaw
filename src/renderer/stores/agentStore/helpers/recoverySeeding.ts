// ── 崩溃恢复播种决策（统一恢复路径，spec §4） ──────────────────
//
// recoverSessions 的纯决策层：以主进程流快照为唯一事实源。
// 快照 v2 携带全部流式状态（正文/思考/工具进度/子 Agent 流/阻塞双态），
// 渲染端只需「播种基线」，后续事件统一走 streamCore 的增量叠加入口——
// 不再有独立的恢复特判（recoveredStreaming 标记已删除）。

import type {Message, ToolCall} from '@shared/types'
import type {ProgressEntry, SubAgentStreamEntry} from '../../toolCallsStore'

/** toolCall 进度态（与主进程 manager.types.ToolProgressState 同构） */
export interface ToolProgressState {
    progress?: string
    progressPercent?: number
    eta?: number
    detailStatus?: 'queued' | 'running' | 'completed' | 'failed'
}

/** 主进程 agent-stream-snapshot 返回的快照结构 v2（镜像 manager.accumulator.ts StreamSnapshot，逐字段对齐） */
export interface StreamSnapshot {
    streamingMessageId: string
    /** 跨段累积全文（主进程 #mergeAndPersist 保险丝同源） */
    content: string
    thinkContent: string | null
    toolCalls: ToolCall[]
    /** DB 中该消息已有的 text 块数，恢复时作为 recordTextBlock 的块 id 序号基线 */
    dbTextBlockCount: number
    /** toolCall 进度态（progress/percent/eta/detailStatus），键为 toolCallId */
    toolStates: Record<string, ToolProgressState>
    /** 工具进度时间轴，键为 toolCallId（主进程条目 {time,text} → 渲染层映射为 {timestamp,text}） */
    progressLog: Record<string, ProgressEntry[]>
    /** 子 Agent 流缓冲，键为 taskId（主进程条目 {type,text,ts} → 渲染层映射为 {type,content,timestamp}） */
    subAgentStream: Record<string, SubAgentStreamEntry[]>
    /** ask_user 阻塞态（null = 无；丢失会导致 agent 卡死等输入） */
    pendingQuestion: ConvPendingQuestion | null
    /** permission_confirm 阻塞态（null = 无） */
    pendingPermissionConfirm: ConvPendingPermission | null
    /** 运行中工具数（主进程由 toolCalls.status==='running' 派生） */
    runningToolCount: number
    /** 工具执行区提示文案：主进程恒 null，渲染端播种时亦置 null（UI 文案不跨进程） */
    executingToolsMessage: null
}

export interface ConvPendingQuestion {
    question: string
    options?: string[]
    multiSelect?: boolean
    requestId?: string
}

export interface ConvPendingPermission {
    question: string
    requestId?: string
}

export interface RecoveryPlan {
    /** DB 中 running/pending 但快照不含的工具（结果在崩溃窗口丢失，标记取消） */
    staleToolIds: string[]
}

const isStale = (tc: {status?: string}) => tc.status === 'running' || tc.status === 'pending'

/**
 * 计算单个会话的 stale 工具对账清单（D7 决策保留）。
 *
 * @param snapshot 主进程流快照；null 表示 pending 未建立（首 token 前崩溃窗口）
 * @param msgs 已加载的会话消息（取最后一条 assistant 的工具状态做 stale 对账）
 */
export function planRecovery(snapshot: StreamSnapshot | null, msgs: Message[]): RecoveryPlan {
    const lastAssistantMsg = [...(msgs || [])].reverse().find(m => m.role === 'assistant')
    const dbTools = lastAssistantMsg?.toolCalls ?? []
    const snapToolIds = new Set(snapshot?.toolCalls.map(t => t.id) ?? [])

    const staleToolIds: string[] = []
    for (const tc of dbTools) {
        if (isStale(tc) && !snapToolIds.has(tc.id)) {
            staleToolIds.push(tc.id)
        }
    }
    return {staleToolIds}
}
