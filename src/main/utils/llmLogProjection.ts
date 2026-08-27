import type {LlmCallRecord} from '@shared/types/llmTrace'
import {extractUsage, extractToolCallCount} from '@shared/utils/llmUsageParser'

export {extractUsage} from '@shared/utils/llmUsageParser'
export type {TokenUsage} from '@shared/utils/llmUsageParser'

export interface TimelineNode {
    kind: 'conversation' | 'turn' | 'call'
    title?: string; turn?: number
    record?: LlmCallRecord; children?: TimelineNode[]
}
export interface SummaryGroup {
    provider: string; model: string
    calls: number; errors: number; aborts: number; retries: number
    avgTotalMs: number; p95TotalMs: number; avgFirstByteMs: number
}
export interface TokenSummary {
    provider: string; model: string
    inputTokens: number; outputTokens: number
    cacheReadTokens: number; cacheWriteTokens: number
    /** 本次响应中解析出的工具调用次数（解析失败/无 resFile 记 0） */
    toolsCount: number
}


// ── foldRecords：仅用 index 字段 ──
export function foldRecords(records: LlmCallRecord[]): {timeline: TimelineNode[]; summary: SummaryGroup[]} {
    const byConv = new Map<string, LlmCallRecord[]>()
    for (const r of [...records].sort((a, b) => a.ts - b.ts)) {
        const list = byConv.get(r.conversationId) ?? []
        list.push(r); byConv.set(r.conversationId, list)
    }
    const timeline: TimelineNode[] = []
    for (const [convId, list] of byConv) {
        const turns = new Map<number, TimelineNode>()
        for (const r of list) {
            if (!turns.has(r.turn)) turns.set(r.turn, {kind: 'turn', turn: r.turn, children: []})
            turns.get(r.turn)!.children!.push({kind: 'call', record: r})
        }
        timeline.push({kind: 'conversation', title: convId,
            children: [...turns.values()].sort((a, b) => b.turn! - a.turn!)})
    }
    // 会话按组内最新记录 ts 降序（最新会话在前）
    const lastTs = new Map<string, number>()
    for (const [convId, list] of byConv) lastTs.set(convId, Math.max(...list.map(r => r.ts)))
    timeline.sort((a, b) => (lastTs.get(b.title ?? '') ?? 0) - (lastTs.get(a.title ?? '') ?? 0))

    const groups = new Map<string, LlmCallRecord[]>()
    for (const r of records) {
        const k = `${r.provider}||${r.model}`
        const l = groups.get(k) ?? []; l.push(r); groups.set(k, l)
    }
    const summary = [...groups.entries()].map(([k, list]) => {
        const [provider, model] = k.split('||')
        const totals = list.map(r => r.totalMs)
        const sorted = [...totals].sort((a, b) => a - b)
        return {
            provider, model,
            calls: list.length,
            errors: list.filter(r => r.status === 'error').length,
            aborts: list.filter(r => r.status === 'aborted').length,
            retries: list.filter(r => r.attempt > 0).length,
            avgTotalMs: Math.round(totals.reduce((a, b) => a + b, 0) / list.length),
            p95TotalMs: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0,
            avgFirstByteMs: Math.round(list.reduce((a, r) => a + r.firstByteMs, 0) / list.length),
        }
    })
    return {timeline, summary}
}

// ── computeTokens：读 res.raw 现场解析（loadResRaw 由 IPC 层注入）──
export async function computeTokens(
    records: LlmCallRecord[],
    loadResRaw: (r: LlmCallRecord) => Promise<string | null>,
): Promise<TokenSummary[]> {
    const acc = new Map<string, Required<Pick<TokenSummary, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'toolsCount'>>>()
    for (const r of records) {
        if (r.status !== 'ok' || !r.resFile) continue
        const raw = await loadResRaw(r)
        const u = raw ? extractUsage(r.apiStyle, raw) : null
        const toolCount = raw ? (extractToolCallCount(r.apiStyle, raw) ?? 0) : 0
        if (!u && toolCount === 0) continue
        const k = `${r.provider}||${r.model}`
        const cur = acc.get(k) ?? {inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, toolsCount: 0}
        cur.inputTokens += u?.inputTokens ?? 0
        cur.outputTokens += u?.outputTokens ?? 0
        cur.cacheReadTokens += u?.cacheReadTokens ?? 0
        cur.cacheWriteTokens += u?.cacheWriteTokens ?? 0
        cur.toolsCount += toolCount
        acc.set(k, cur)
    }
    return [...acc.entries()].map(([k, v]) => {
        const [provider, model] = k.split('||')
        return {provider, model, ...v}
    })
}