/**
 * formatDuration 耗时分级格式化测试
 *
 * 保护：消息底部耗时按分级显示：
 * - 低于一分钟 → n秒
 * - 低于一小时 → m分n秒
 * - 达到一小时 → x小时m分n秒
 */
import {describe, expect, it} from 'vitest'
import {formatDuration} from '../../../src/renderer/lib/format'

describe('formatDuration（耗时分级格式化）', () => {
    it('低于一分钟 → n秒', () => {
        expect(formatDuration(0)).toBe('0秒')
        expect(formatDuration(999)).toBe('1秒')
        expect(formatDuration(1_500)).toBe('2秒')
        expect(formatDuration(59_400)).toBe('59秒')
    })

    it('整分钟边界：60秒 → 1分0秒', () => {
        expect(formatDuration(60_000)).toBe('1分0秒')
    })

    it('低于一小时 → m分n秒', () => {
        expect(formatDuration(61_000)).toBe('1分1秒')
        expect(formatDuration(5 * 60_000 + 37_000)).toBe('5分37秒')
        expect(formatDuration(59 * 60_000 + 59_000)).toBe('59分59秒')
    })

    it('整小时边界：3600秒 → 1小时0分0秒', () => {
        expect(formatDuration(3_600_000)).toBe('1小时0分0秒')
    })

    it('达到一小时 → x小时m分n秒', () => {
        expect(formatDuration(2 * 3_600_000 + 15 * 60_000 + 42_000)).toBe('2小时15分42秒')
        expect(formatDuration(23 * 3_600_000 + 59 * 60_000 + 59_000)).toBe('23小时59分59秒')
        expect(formatDuration(25 * 3_600_000)).toBe('25小时0分0秒')
    })

    it('负数（时间戳异常）→ 按 0 处理', () => {
        expect(formatDuration(-5_000)).toBe('0秒')
    })

    it('毫秒四舍五入', () => {
        expect(formatDuration(59_500)).toBe('1分0秒')
        expect(formatDuration(500)).toBe('1秒')
    })
})
