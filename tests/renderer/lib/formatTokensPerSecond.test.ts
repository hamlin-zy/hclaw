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
})
