import {describe, expect, it} from 'vitest'
import {
    formatTokensPerSecond,
    tokensPerSecond,
} from '@/renderer/lib/format'

describe('formatTokensPerSecond（速率展示格式化）', () => {
    it('>=10 取整', () => {
        expect(formatTokensPerSecond(34)).toBe('34')
        expect(formatTokensPerSecond(34.7)).toBe('35')
    })
    it('<10 保留一位小数', () => {
        expect(formatTokensPerSecond(6.8)).toBe('6.8')
        expect(formatTokensPerSecond(0)).toBe('0')
    })
    it('负数 clamp 到 0', () => {
        expect(formatTokensPerSecond(-5)).toBe('0')
    })
})

describe('tokensPerSecond（速率计算）', () => {
    it('output ÷ (duration/1000)', () => {
        expect(tokensPerSecond(200, 5000)).toBe(40)
    })
    it('duration <= 0 返回 null', () => {
        expect(tokensPerSecond(200, 0)).toBeNull()
        expect(tokensPerSecond(200, -1)).toBeNull()
    })
    it('output 非法返回 null', () => {
        expect(tokensPerSecond(-1, 5000)).toBeNull()
    })
    it('output = 0 返回 null', () => {
        expect(tokensPerSecond(0, 5000)).toBeNull()
    })
    it('duration 过短（<500ms）按 500ms 保守下限计算，防 t/s 爆表', () => {
        // 真实案例：decode_ms=1 + output=759 → 理论 759000 t/s → 封顶 1518 t/s
        expect(tokensPerSecond(759, 1)).toBe(1518)
        // 边界：恰好 500ms 正常计算
        expect(tokensPerSecond(200, 500)).toBe(400)
        expect(tokensPerSecond(200, 499)).toBe(400)
    })
})
