import {describe, it, expect} from 'vitest'
import {detectGrowthTrend} from './growthDetector'

describe('detectGrowthTrend', () => {
    it('平稳序列判为未泄漏', () => {
        // 围绕 10MB 抖动 ±64KB，无趋势
        const samples = Array.from({length: 60}, (_, i) => 10 * 1048576 + Math.sin(i) * 65536)
        const r = detectGrowthTrend(samples)
        expect(r.leaked).toBe(false)
    })

    it('线性增长序列判为泄漏', () => {
        const samples = Array.from({length: 60}, (_, i) => 10 * 1048576 + i * 8192 + Math.sin(i) * 16384)
        const r = detectGrowthTrend(samples)
        expect(r.leaked).toBe(true)
        expect(r.r2).toBeGreaterThan(0.9)
    })

    it('样本数不足时返回未泄漏且 r2=0', () => {
        const r = detectGrowthTrend([1, 2])
        expect(r.leaked).toBe(false)
        expect(r.r2).toBe(0)
    })
})
