import {describe, expect, it} from 'vitest'
import {
    DEFAULT_HANDOFF_THRESHOLD_TOKENS,
    MIN_HANDOFF_THRESHOLD_TOKENS,
    resolveHandoffThresholdTokens,
} from '@shared/handoffThreshold'

/**
 * 交接阈值统一解析单测：
 * - ratio 模式 → 窗口 × 比例
 * - tokens 模式 → 固定 token（下限 50K 兜底）
 * - ratio=0 为跨模式全局关闭哨兵 → 返回 0
 */
describe('resolveHandoffThresholdTokens', () => {
    it('默认（无配置）按比例 0.5 × 窗口', () => {
        expect(resolveHandoffThresholdTokens(undefined, 1_000_000)).toBe(500_000)
    })

    it('按比例模式：阈值 = ratio × windowTokens', () => {
        const agent = {handoffThresholdRatio: 0.3, handoffThresholdMode: 'ratio' as const}
        expect(resolveHandoffThresholdTokens(agent, 1_000_000)).toBe(300_000)
    })

    it('ratio=0 → 0（关闭，无视模式）', () => {
        expect(resolveHandoffThresholdTokens({handoffThresholdRatio: 0, handoffThresholdMode: 'ratio'}, 1_000_000)).toBe(0)
        expect(resolveHandoffThresholdTokens({handoffThresholdRatio: 0, handoffThresholdMode: 'tokens', handoffThresholdTokens: 200_000}, 1_000_000)).toBe(0)
    })

    it('按窗口大小模式：直接返回配置的 token 值（与窗口无关）', () => {
        const agent = {handoffThresholdRatio: 0.5, handoffThresholdMode: 'tokens' as const, handoffThresholdTokens: 120_000}
        expect(resolveHandoffThresholdTokens(agent, 1_000_000)).toBe(120_000)
        expect(resolveHandoffThresholdTokens(agent, 200_000)).toBe(120_000)
    })

    it('按窗口大小模式：未配置 token 值 → 默认 200K', () => {
        const agent = {handoffThresholdRatio: 0.5, handoffThresholdMode: 'tokens' as const}
        expect(resolveHandoffThresholdTokens(agent, 1_000_000)).toBe(DEFAULT_HANDOFF_THRESHOLD_TOKENS)
    })

    it('按窗口大小模式：低于 50K 下限 → 兜底为 50K', () => {
        const agent = {handoffThresholdRatio: 0.5, handoffThresholdMode: 'tokens' as const, handoffThresholdTokens: 10_000}
        expect(resolveHandoffThresholdTokens(agent, 1_000_000)).toBe(MIN_HANDOFF_THRESHOLD_TOKENS)
    })

    it('按窗口大小模式：配置为 0 → 0（关闭）', () => {
        const agent = {handoffThresholdRatio: 0.5, handoffThresholdMode: 'tokens' as const, handoffThresholdTokens: 0}
        expect(resolveHandoffThresholdTokens(agent, 1_000_000)).toBe(0)
    })

    it('按比例模式：windowTokens=0 → 0', () => {
        expect(resolveHandoffThresholdTokens({handoffThresholdRatio: 0.5, handoffThresholdMode: 'ratio'}, 0)).toBe(0)
    })
})
