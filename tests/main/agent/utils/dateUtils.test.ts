/**
 * 日期工具测试
 *
 * 保护：formatYmd 必须用本地时区字段（getFullYear/getMonth/getDate），
 * 禁用 toISOString()——UTC 时间在中国时区（UTC+8）晚 20 点后会跨天。
 */
import {describe, expect, it} from 'vitest'
import {formatYmd, isCacheStale} from '../../../../src/main/agent/utils/dateUtils'

describe('formatYmd（本地时区 yyyy-MM-dd）', () => {
    it('月份/日期补零', () => {
        expect(formatYmd(new Date(2026, 0, 5))).toBe('2026-01-05')
        expect(formatYmd(new Date(2026, 7, 6))).toBe('2026-08-06')
    })

    it('跨月/跨年边界', () => {
        expect(formatYmd(new Date(2025, 11, 31))).toBe('2025-12-31')
        expect(formatYmd(new Date(2026, 0, 1))).toBe('2026-01-01')
    })

    it('深夜 23:59 仍属当天（本地字段，不随 UTC 跨天）', () => {
        expect(formatYmd(new Date(2026, 7, 6, 23, 59, 59))).toBe('2026-08-06')
    })

    it('无参调用返回当天，格式为 yyyy-MM-dd', () => {
        expect(formatYmd()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    })
})

describe('isCacheStale（缓存跨天失效）', () => {
    it('无构建日期 → 过期（旧缓存需重建）', () => {
        expect(isCacheStale(undefined, '2026-08-06')).toBe(true)
    })

    it('构建日期是今天 → 复用缓存', () => {
        expect(isCacheStale('2026-08-06', '2026-08-06')).toBe(false)
    })

    it('构建日期是昨天 → 跨天需重建', () => {
        expect(isCacheStale('2026-08-05', '2026-08-06')).toBe(true)
    })
})
