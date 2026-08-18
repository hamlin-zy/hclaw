/**
 * 会话用量统计聚合（主进程）
 *
 * 纯函数：不接触 DB / IPC，输入由调用方（conversation.ts IPC handler）
 * 从 SQLite 组装后传入，保证可独立单元测试。
 */
import type {ConversationSummary, ConversationUsageStats, LlmStats, UsageBreakdown} from '@shared/types'
import {collectDescendants} from '@shared/utils/conversationTree'

/**
 * 计算起点会话及其全部后代（递归）的用量聚合。
 *
 * @param conversations 工作区内全部会话 meta（用于建立父子关系）
 * @param llmStatsByConv 会话 id → 该会话全部消息的 llmStats 扁平列表
 * @param toolCallCountByConv 会话 id → 该会话 tool_use 块总数
 * @param startConvId 右键点击的起点会话
 */
export function computeConversationUsageStats(
    conversations: ConversationSummary[],
    llmStatsByConv: Map<string, LlmStats[]>,
    toolCallCountByConv: Map<string, number>,
    startConvId: string,
): ConversationUsageStats {
    const convIds = collectDescendants(conversations, [startConvId])
    const idSet = new Set(convIds)

    let parentCount = 0
    let childCount = 0
    for (const c of conversations) {
        if (!idSet.has(c.id)) continue
        // 根：无父级，或父级不在统计集合内（孤儿子会话按根计，与侧边栏分组逻辑一致）
        if (!c.parentConvId || !idSet.has(c.parentConvId)) {
            parentCount++
        } else {
            childCount++
        }
    }
    // 起点会话本身一定在集合内；若 conversations 中找不到（数据异常），兜底计 1
    if (parentCount === 0 && childCount === 0) parentCount = 1

    let requestCount = 0
    let toolCallCount = 0
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let totalCacheReadTokens = 0
    let totalCacheWriteTokens = 0
    // 分组：模型粒度（key = `${provider}|${model}`，转 UsageBreakdown 时拆出），totalTokens 最后排序
    const groupMap = new Map<string, UsageBreakdown>()

    for (const convId of convIds) {
        toolCallCount += toolCallCountByConv.get(convId) ?? 0
        for (const s of llmStatsByConv.get(convId) ?? []) {
            requestCount++
            totalInputTokens += s.inputTokens || 0
            totalOutputTokens += s.outputTokens || 0
            totalCacheReadTokens += s.cacheReadTokens || 0
            totalCacheWriteTokens += s.cacheWriteTokens || 0
            const provider = s.provider || 'unknown'
            const model = s.model || 'unknown'
            const mapKey = `${provider}\u0000${model}`   // \u0000 分隔，避免 model 含 '|' 时分裂
            const g = groupMap.get(mapKey) ?? {
                key: model,               // UsageBreakdown.key = model（UI 按模型显示 / 按服务商聚合）
                providerType: provider,   // UsageBreakdown.providerType = 服务商
                providerName: undefined,  // providers 表服务商名（组内非 NULL 优先，见下方累加）
                requestCount: 0,
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                totalTokens: 0,
                costUsd: 0,
            }
            // providerName 组内非 NULL 优先：历史行（无 name）不覆盖新值
            if (!g.providerName && s.providerName) g.providerName = s.providerName
            g.requestCount++
            g.inputTokens += s.inputTokens || 0
            g.outputTokens += s.outputTokens || 0
            g.cacheReadTokens += s.cacheReadTokens || 0
            g.cacheWriteTokens += s.cacheWriteTokens || 0
            g.totalTokens = g.inputTokens + g.outputTokens + g.cacheReadTokens + g.cacheWriteTokens
            groupMap.set(mapKey, g)
        }
    }

    const breakdown = [...groupMap.values()].sort((a, b) => b.totalTokens - a.totalTokens)

    return {
        conversationCount: convIds.length,
        parentCount,
        childCount,
        requestCount,
        toolCallCount,
        totalInputTokens,
        totalOutputTokens,
        totalCacheReadTokens,
        totalCacheWriteTokens,
        breakdown,
    }
}
