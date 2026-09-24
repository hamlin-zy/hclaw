/**
 * getRelativeTime 相对时间格式化测试（会话列表口径）
 *
 * 保护：侧栏会话列表的时间文案不带「前」字：
 * - 低于一分钟 → 刚刚
 * - 低于一小时 → n分钟（不是「n分钟前」）
 * - 低于一天 → n小时
 * - 低于七天 → n天
 * - 七天及以上 → 绝对日期（zh-CN）
 *
 * 说明：本文件只覆盖会话列表消费的 getRelativeTime（src/renderer/lib/format.ts）；
 * 会话管理弹窗 / 备忘录用的 formatRelativeTime（src/renderer/lib/relativeTime.ts）
 * 是另一份实现、口径不同，不在本用例范围内。
 */
import {describe, expect, it} from 'vitest'
import {getRelativeTime} from '../../../src/renderer/lib/format'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** 以「n 毫秒之前」构造时间戳；额外多减 1 秒，保证 diff 落在区间的安全侧（防边界抖动） */
const ago = (n: number) => Date.now() - n - 1_000

describe('getRelativeTime（会话列表相对时间，不带「前」）', () => {
    it('低于一分钟 → 刚刚', () => {
        expect(getRelativeTime(Date.now())).toBe('刚刚')
        expect(getRelativeTime(ago(30_000))).toBe('刚刚')
    })

    it('分钟档 → n分钟（无「前」字）', () => {
        expect(getRelativeTime(ago(5 * MIN))).toBe('5分钟')
        expect(getRelativeTime(ago(59 * MIN))).toBe('59分钟')
    })

    it('小时档 → n小时（无「前」字）', () => {
        expect(getRelativeTime(ago(HOUR))).toBe('1小时')
        expect(getRelativeTime(ago(23 * HOUR))).toBe('23小时')
    })

    it('天档 → n天（无「前」字）', () => {
        expect(getRelativeTime(ago(DAY))).toBe('1天')
        expect(getRelativeTime(ago(6 * DAY))).toBe('6天')
    })

    it('七天及以上 → 绝对日期（zh-CN，不带相对文案）', () => {
        const ts = ago(7 * DAY)
        expect(getRelativeTime(ts)).toBe(new Date(ts).toLocaleDateString('zh-CN'))
        expect(getRelativeTime(ts)).not.toContain('天')
    })

    it('相对文案一律不含「前」字（改前为「5分钟前」等）', () => {
        const samples = [ago(5 * MIN), ago(3 * HOUR), ago(2 * DAY)]
        for (const ts of samples) {
            expect(getRelativeTime(ts)).not.toContain('前')
        }
    })
})
