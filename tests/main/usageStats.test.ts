import {describe, expect, it} from 'vitest'
import type {ConversationSummary, LlmStats} from '@shared/types'
import {computeConversationUsageStats} from '@/main/usageStats'

/** 构造最小 ConversationSummary */
function conv(id: string, parentConvId?: string): ConversationSummary {
    return {
        id,
        title: id,
        preview: '',
        updatedAt: 0,
        status: 'active',
        ...(parentConvId ? {parentConvId} : {}),
    } as ConversationSummary
}

/** 构造 LlmStats */
function stats(input: number, output: number, cacheRead?: number, cacheWrite?: number): LlmStats {
    return {
        inputTokens: input,
        outputTokens: output,
        provider: 'test',
        model: 'test-model',
        duration: 100,
        ...(cacheRead !== undefined ? {cacheReadTokens: cacheRead} : {}),
        ...(cacheWrite !== undefined ? {cacheWriteTokens: cacheWrite} : {}),
    }
}

describe('computeConversationUsageStats', () => {
    it('单会话聚合：累加 input/output/cacheRead/cacheWrite 与请求数', () => {
        const convs = [conv('root')]
        const llmStats = new Map([
            ['root', [stats(100, 20, 50, 10), stats(200, 40, 30, 5)]],
        ])
        const toolCount = new Map([['root', 3]])

        const result = computeConversationUsageStats(convs, llmStats, toolCount, 'root')

        expect(result.conversationCount).toBe(1)
        expect(result.parentCount).toBe(1)
        expect(result.childCount).toBe(0)
        expect(result.requestCount).toBe(2)
        expect(result.toolCallCount).toBe(3)
        expect(result.totalInputTokens).toBe(300)
        expect(result.totalOutputTokens).toBe(60)
        expect(result.totalCacheReadTokens).toBe(80)
        expect(result.totalCacheWriteTokens).toBe(15)
    })

    it('父+子会话：递归收集后代并汇总（与删除口径一致）', () => {
        const convs = [
            conv('root'),
            conv('c1', 'root'),
            conv('c2', 'root'),
            conv('c1a', 'c1'),  // 嵌套后代
        ]
        const llmStats = new Map([
            ['root', [stats(100, 10)]],
            ['c1', [stats(50, 5)]],
            ['c1a', [stats(25, 3)]],
            // c2 无 llmStats
        ])
        const toolCount = new Map([['c1', 2]])

        const result = computeConversationUsageStats(convs, llmStats, toolCount, 'root')

        expect(result.conversationCount).toBe(4)
        expect(result.parentCount).toBe(1)   // 只有 root 是根
        expect(result.childCount).toBe(3)     // c1, c2, c1a
        expect(result.requestCount).toBe(3)
        expect(result.toolCallCount).toBe(2)
        expect(result.totalInputTokens).toBe(175)
        expect(result.totalOutputTokens).toBe(18)
    })

    it('右击子会话：统计范围 = 自身 + 自己的后代', () => {
        const convs = [
            conv('root'),
            conv('c1', 'root'),
            conv('c1a', 'c1'),
        ]
        const llmStats = new Map([
            ['c1', [stats(10, 1)]],
            ['c1a', [stats(5, 2)]],
            // root 不在范围内
        ])
        const toolCount = new Map()

        const result = computeConversationUsageStats(convs, llmStats, toolCount, 'c1')

        expect(result.conversationCount).toBe(2)   // c1 + c1a
        expect(result.parentCount).toBe(1)         // c1 是范围根
        expect(result.childCount).toBe(1)
        expect(result.totalInputTokens).toBe(15)
        expect(result.totalOutputTokens).toBe(3)
    })

    it('无任何 llmStats：全 0，不崩溃', () => {
        const convs = [conv('root')]
        const result = computeConversationUsageStats(convs, new Map(), new Map(), 'root')

        expect(result.conversationCount).toBe(1)
        expect(result.requestCount).toBe(0)
        expect(result.totalInputTokens).toBe(0)
        expect(result.totalOutputTokens).toBe(0)
        expect(result.totalCacheReadTokens).toBe(0)
        expect(result.totalCacheWriteTokens).toBe(0)
        expect(result.toolCallCount).toBe(0)
    })

    it('孤儿子会话（父已删除）：按范围根计数，不崩溃', () => {
        const orphan = conv('orphan', 'deleted-parent')
        const llmStats = new Map([['orphan', [stats(7, 1)]]])
        const result = computeConversationUsageStats([orphan], llmStats, new Map(), 'orphan')

        expect(result.conversationCount).toBe(1)
        expect(result.parentCount).toBe(1)   // 父不在集合内 → 按根计
        expect(result.childCount).toBe(0)
        expect(result.totalInputTokens).toBe(7)
    })

    it('map 缺 key：会话有 llm_stats 但无 tool 计数（或反之），默认 0', () => {
        const convs = [conv('root'), conv('c1', 'root')]
        const llmStats = new Map([['root', [stats(1, 1)]]])  // c1 无 llm_stats
        const toolCount = new Map([['c1', 5]])               // c1 有 tool 但无 llm_stats

        const result = computeConversationUsageStats(convs, llmStats, toolCount, 'root')

        expect(result.requestCount).toBe(1)
        expect(result.totalInputTokens).toBe(1)
        expect(result.toolCallCount).toBe(5)   // 工具计数独立于 llm_stats
    })
})

// ── breakdown 分组（Task 6） ─────────────────────────────

/** 带 provider/model 的 LlmStats（复用现有 conv()） */
function statWithProvider(input: number, output: number, provider: string, model: string, providerName?: string): LlmStats {
    return {
        inputTokens: input,
        outputTokens: output,
        provider,
        model,
        duration: 100,
        ...(providerName ? {providerName} : {}),
    }
}

describe('computeConversationUsageStats — breakdown 分组', () => {
    it('按模型粒度输出 breakdown（key=model、providerType=服务商、totalTokens 降序）', () => {
        const convs = [conv('root')]
        const llmStats = new Map([
            ['root', [
                statWithProvider(100, 20, 'anthropic', 'claude-sonnet-4'),
                statWithProvider(50, 10, 'anthropic', 'claude-opus-4'),
                statWithProvider(30, 5, 'openai', 'gpt-4o'),
            ]],
        ])
        const result = computeConversationUsageStats(convs, llmStats, new Map(), 'root')

        expect(result.breakdown).toHaveLength(3)
        // key = model（与 UsageBreakdown 类型一致），providerType = 服务商
        expect(result.breakdown[0]!.key).toBe('claude-sonnet-4')
        expect(result.breakdown[0]!.providerType).toBe('anthropic')
        expect(result.breakdown[0]!.totalTokens).toBe(120)
        expect(result.breakdown[2]!.key).toBe('gpt-4o')
        expect(result.breakdown[2]!.providerType).toBe('openai')
        expect(result.breakdown[2]!.requestCount).toBe(1)
        // 总计口径不变（回归）
        expect(result.totalInputTokens).toBe(180)
        expect(result.requestCount).toBe(3)
    })

    it('providerName 透传到 breakdown（无则 undefined）', () => {
        const convs = [conv('root')]
        const llmStats = new Map([
            ['root', [
                statWithProvider(30, 5, 'openai', 'gpt-4o'),
                statWithProvider(10, 1, 'anthropic', 'claude-sonnet-4', 'Deepseek-ant'),
            ]],
        ])
        const result = computeConversationUsageStats(convs, llmStats, new Map(), 'root')

        // totalTokens 降序：gpt-4o(35) > claude-sonnet-4(11)
        expect(result.breakdown[0]!.providerName).toBeUndefined()
        expect(result.breakdown[1]!.providerName).toBe('Deepseek-ant')
    })

    it('同 provider+model 组内 providerName 非 NULL 优先（历史 NULL + 新值 → 取有值者）', () => {
        const convs = [conv('root')]
        const llmStats = new Map([
            ['root', [
                statWithProvider(30, 5, 'anthropic', 'deepseek-v4-flash'),   // 无 providerName（历史）
                statWithProvider(10, 1, 'anthropic', 'deepseek-v4-flash', 'Deepseek-ant'),
            ]],
        ])
        const result = computeConversationUsageStats(convs, llmStats, new Map(), 'root')

        expect(result.breakdown).toHaveLength(1)
        expect(result.breakdown[0]!.providerName).toBe('Deepseek-ant')
        expect(result.breakdown[0]!.requestCount).toBe(2)
    })

    it('同 provider+model 多条 → 合并为一行', () => {
        const convs = [conv('root')]
        const llmStats = new Map([
            ['root', [
                statWithProvider(10, 1, 'anthropic', 'claude-sonnet-4'),
                statWithProvider(20, 2, 'anthropic', 'claude-sonnet-4'),
            ]],
        ])
        const result = computeConversationUsageStats(convs, llmStats, new Map(), 'root')
        expect(result.breakdown).toHaveLength(1)
        expect(result.breakdown[0]!.requestCount).toBe(2)
        expect(result.breakdown[0]!.inputTokens).toBe(30)
    })

    it('无 llmStats → breakdown 空数组（不崩溃）', () => {
        const result = computeConversationUsageStats([conv('root')], new Map(), new Map(), 'root')
        expect(result.breakdown).toEqual([])
    })
})
