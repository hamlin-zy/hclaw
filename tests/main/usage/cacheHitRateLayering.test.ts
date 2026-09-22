/**
 * 缓存命中率的「同模型分层 + 首枪（不用平均）」口径回归（组 C · P1-7 · patterns 34）
 *
 * ⚠️ 落地前的勘察结论（实测，勿重复调研）：
 *   `src/**` 中**不存在**名为 prev_model / model_changed / LAG(model) 的显式"剔除切模型样本"
 *   实现（全仓 grep 无命中）；llm_usage 表也没有 user 消息边界字段，无法在 SQL 层还原
 *   "每条 user 消息后的第一次请求"。因此本文件挂载**现有的分层载体**：
 *   `computeMessageTokenStatsByModel`（src/shared/messageTokenStats.ts）按
 *   `providerName ?? provider + model` 分组统计 —— 这正是「prev_model == cur_model」
 *   样本归组的等价物（`llmStatsModelKey`）。
 *
 * 被锁死的口径：
 *   1. 分层隔离：模型 A 的样本只进 A 组，切到 B 的样本绝不混入 A 的累计/当前值；
 *   2. 首枪而非平均：每组的 current* 取该组**最后一次真实请求**的原值（不是组内平均），
 *      切模型后新模型组的首枪值 = 该次请求原值（用户看的就是这一枪的命中率）；
 *   3. 请求计数 = 同模型样本数（不多不少），跨模型切分不会把两侧样本并成一条。
 *
 * 判别力：若分组键退化为「只看 model 不看服务商」→ 同名模型用例红；
 * 若 current* 被改成组内平均 → 首枪用例红；若累计把跨模型样本并入 → 隔离用例红。
 */
import {describe, expect, it} from 'vitest'
import type {Message, LlmStats} from '@shared/types'
import {computeMessageTokenStatsByModel, llmStatsModelKey} from '@shared/messageTokenStats'

/** 构造 assistant 消息（携带 llmStats 序列；timestamp 用于分组排序） */
function assistant(id: string, ts: number, statsList: LlmStats[]): Message {
    return {id, role: 'assistant', content: '', timestamp: ts, llmStats: statsList} as unknown as Message
}

/** 一次 LLM 请求样本：input=未命中输入，cacheRead=命中缓存 */
function sample(model: string, input: number, cacheRead: number, provider = 'anthropic', providerName?: string): LlmStats {
    return {
        inputTokens: input,
        outputTokens: 1,
        provider,
        model,
        duration: 100,
        cacheReadTokens: cacheRead,
        ...(providerName ? {providerName} : {}),
    }
}

describe('缓存命中率分层口径：prev_model == cur_model', () => {
    it('分层隔离：模型 A 的累计不吸收切到 B 的样本，B 组独立成组', () => {
        // 同一会话内：A 两枪 → 切到 B 一枪 → 又回到 A 一枪
        const messages = [
            assistant('m1', 1000, [sample('model-a', 100, 900)]),
            assistant('m2', 2000, [sample('model-a', 50, 950)]),
            assistant('m3', 3000, [sample('model-b', 500, 500)]),
            assistant('m4', 4000, [sample('model-a', 10, 990)]),
        ]
        const groups = computeMessageTokenStatsByModel(messages)
        const a = groups.find(g => g.model === 'model-a')!
        const b = groups.find(g => g.model === 'model-b')!

        // A 组：三枪都是 A（切到 B 那一枪不进 A）
        expect(a.stats.requestCount).toBe(3)
        expect(a.stats.totalInputTokens).toBe(160)
        expect(a.stats.totalCacheReadTokens).toBe(2840)
        // B 组：只有 B 的那一枪
        expect(b.stats.requestCount).toBe(1)
        expect(b.stats.totalInputTokens).toBe(500)
        expect(b.stats.totalCacheReadTokens).toBe(500)
        // 交叉校验：两组之和 = 全部样本之和（无样本丢失、无重复计数）
        expect(a.stats.requestCount + b.stats.requestCount).toBe(4)
        expect(a.stats.totalCacheReadTokens + b.stats.totalCacheReadTokens).toBe(900 + 950 + 500 + 990)
    })

    it('单次原值口径而非平均：每组 current 取该组最近一次请求原值，不等于组内累计平均', () => {
        const messages = [
            assistant('m1', 1000, [
                sample('model-a', 100, 900),   // A 的第一枪
                sample('model-a', 200, 800),
                sample('model-a', 300, 700),   // A 组最近一次
            ]),
            assistant('m2', 2000, [sample('model-b', 800, 200)]),   // 切模型后的第一枪 = B 组首枪
        ]
        const groups = computeMessageTokenStatsByModel(messages)
        const a = groups.find(g => g.model === 'model-a')!
        const b = groups.find(g => g.model === 'model-b')!

        // A 组 current = 最近一次请求原值（300 / 700 → 70%）
        expect(a.stats.currentInputTokens).toBe(300)
        expect(a.stats.currentCacheReadTokens).toBe(700)
        const curRate = a.stats.currentCacheReadTokens / (a.stats.currentInputTokens + a.stats.currentCacheReadTokens)
        expect(Math.round(curRate * 100)).toBe(70)
        // 组内累计平均命中率 = 2400 / 3000 = 80% —— 与 current 口径**不同值**（禁用平均值）
        const avgRate = a.stats.totalCacheReadTokens / (a.stats.totalInputTokens + a.stats.totalCacheReadTokens)
        expect(Math.round(avgRate * 100)).toBe(80)
        expect(Math.round(curRate * 100)).not.toBe(Math.round(avgRate * 100))

        // 切模型后的 B 组首枪原值：input 800 / cacheRead 200 → 命中率 20%（未被 A 的样本稀释）
        expect(b.stats.currentInputTokens).toBe(800)
        expect(b.stats.currentCacheReadTokens).toBe(200)
        const bRate = b.stats.currentCacheReadTokens / (b.stats.currentInputTokens + b.stats.currentCacheReadTokens)
        expect(Math.round(bRate * 100)).toBe(20)
    })

    it('分层键含服务商：同名模型跨服务商必须分属两组（否则命中率被异源样本稀释）', () => {
        const messages = [
            assistant('m1', 1000, [sample('deepseek-v4', 100, 900, 'anthropic', 'Deepseek-ant')]),
            assistant('m2', 2000, [sample('deepseek-v4', 100, 900, 'openai', 'Other-vendor')]),
        ]
        const groups = computeMessageTokenStatsByModel(messages)
        expect(groups).toHaveLength(2)
        expect(groups.map(g => g.providerName).sort()).toEqual(['Deepseek-ant', 'Other-vendor'])
        // 两组各自 requestCount = 1（未被合并成 2）
        for (const g of groups) expect(g.stats.requestCount).toBe(1)
        // 与分组键函数同源（防止将来改键却漏改断言）
        expect(llmStatsModelKey({provider: 'anthropic', providerName: 'Deepseek-ant', model: 'deepseek-v4'}))
            .not.toBe(llmStatsModelKey({provider: 'openai', providerName: 'Other-vendor', model: 'deepseek-v4'}))
    })
})
