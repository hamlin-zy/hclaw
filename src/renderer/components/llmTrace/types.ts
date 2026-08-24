/**
 * LLM 调用轨迹 renderer 镜像类型
 *
 * TimelineNode / SummaryGroup / TokenSummary 与主进程投影输出
 * （src/main/utils/llmLogProjection.ts）字段一一对应；
 * LlmCallRecord 直接复用 shared 定义（index.jsonl envelope）。
 */
import type {LlmCallRecord, LlmTraceStatus, LlmTraceContextKind} from '@shared/types/llmTrace'

export type {LlmCallRecord, LlmTraceStatus, LlmTraceContextKind}

/** 时间线节点：conversation → turn → call 三层（foldRecords 输出） */
export interface TimelineNode {
    kind: 'conversation' | 'turn' | 'call'
    title?: string
    turn?: number
    record?: LlmCallRecord
    children?: TimelineNode[]
}

/** 按 provider||model 聚合的调用统计 */
export interface SummaryGroup {
    provider: string; model: string
    calls: number; errors: number; aborts: number; retries: number
    avgTotalMs: number; p95TotalMs: number; avgFirstByteMs: number
}

/** res.raw 现场解析出的 token 汇总（按 provider||model） */
export interface TokenSummary {
    provider: string; model: string
    inputTokens: number; outputTokens: number
    cacheReadTokens: number; cacheWriteTokens: number
}

/** llm-trace:get-projection 返回结构 */
export interface LlmTraceProjection {
    timeline: TimelineNode[]
    summary: SummaryGroup[]
    summaryTokens: TokenSummary[]
}

/** 时间线过滤条件（过滤条状态 chips + 两个下拉） */
export interface TraceFilter {
    status: 'all' | 'failed' | 'retries'
    /** '' = 全部模型 */
    model: string
    /** '' = 全部会话 */
    conversationId: string
}
