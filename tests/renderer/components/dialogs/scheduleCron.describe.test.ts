/**
 * describeCron — 列表行内使用的频率摘要（ui-06；custom 回显表达式为 2026-09-19 用户拍板）
 *
 * 断言五种形态：daily / weekly / monthly / interval / custom。
 * custom 必须回显 cron 表达式原文（空表达式除外）。
 */
import {describe, it, expect} from 'vitest'
import {configToCron, cronToConfig, describeCron} from '../../../../src/renderer/components/dialogs/scheduleCron'

describe('describeCron', () => {
    it('每天', () => {
        expect(describeCron('0 9 * * *')).toBe('每天 09:00')
        expect(describeCron('30 18 * * *')).toBe('每天 18:30')
    })

    it('每周', () => {
        expect(describeCron('30 8 * * 1,3')).toBe('每周一、周三 08:30')
    })

    it('每月', () => {
        expect(describeCron('0 8 1 * *')).toBe('每月 1 日 08:00')
    })

    it('间隔', () => {
        expect(describeCron('*/20 * * * *')).toBe('每 20 分钟')
        expect(describeCron('0 */2 * * *')).toBe('每 2 小时')
    })

    it('无法归类时回显表达式原文（用户拍板：高级模式直接看到表达式）', () => {
        expect(describeCron('0 9 1,15 * *')).toBe('自定义 0 9 1,15 * *')
    })

    it('非五段表达式同样回显原文', () => {
        expect(describeCron('not-a-cron')).toBe('自定义 not-a-cron')
    })
})

// 步长为 0 的表达式不得被归入 interval（块注释里不能写出正斜杠加星号，故用行注释）。
//
// 步长 0 在后端（`cron-parser`，与 SchedulerEngine 同一库）抛
// `Constraint error, cannot repeat at every 0 time` —— 任务**永不触发**。
// 旧实现 `/^\*\/\d+$/` 把它读成 intervalValue=0，于是列表行会渲染出「每 0 分钟」
// 这种具体而荒谬的频率（与 I-3 修掉的谎报同类，且 ui-06 后已可见于行内）。
describe('步长为 0：落高级模式并告警，不谎报频率（ui-06 复核）', () => {
    const ZERO_STEP = ['*/0 * * * *', '0 */0 * * *', '*/00 * * * *', '0 */00 * * *']

    it.each(ZERO_STEP)('%s → custom / not-writable，customExpr 逐字节保留', (expr) => {
        const c = cronToConfig(expr)
        expect(c.mode).toBe('custom')
        expect(c.unrecognized).toBe(true)
        expect(c.customReason).toBe('not-writable')
        expect(c.customExpr).toBe(expr)
        // 归一化/往返都不得把它改写成别的频率
        expect(configToCron(c)).toBe(expr)
    })

    it.each(ZERO_STEP)('%s → describeCron 回显原文，不得含「0 分钟」「0 小时」', (expr) => {
        const out = describeCron(expr)
        expect(out).toBe(`自定义 ${expr}`)
        expect(out).not.toContain('0 分钟')
        expect(out).not.toContain('0 小时')
    })

    it('对照组：步长 ≥1 仍归 interval', () => {
        expect(cronToConfig('*/1 * * * *')).toMatchObject({mode: 'interval', intervalValue: 1, intervalUnit: 'minutes'})
        expect(cronToConfig('*/30 * * * *')).toMatchObject({mode: 'interval', intervalValue: 30, intervalUnit: 'minutes'})
        // `*/60` 在 cron-parser 下合法（每小时第 0 分），只拒 0，不得顺手判非法
        expect(cronToConfig('*/60 * * * *')).toMatchObject({mode: 'interval', intervalValue: 60, intervalUnit: 'minutes'})
        expect(cronToConfig('0 */6 * * *')).toMatchObject({mode: 'interval', intervalValue: 6, intervalUnit: 'hours'})
        expect(describeCron('*/1 * * * *')).toBe('每 1 分钟')
        expect(describeCron('*/60 * * * *')).toBe('每 60 分钟')
        expect(describeCron('0 */6 * * *')).toBe('每 6 小时')
    })

    it('configToCron 不会因解析而产生 `*/0`：落 custom 者原样写回，interval 步长恒 ≥1', () => {
        // 步长 0 的表达式根本不进 interval 分支，故不存在「插值出 */0」的路径
        for (const expr of ZERO_STEP) {
            expect(cronToConfig(expr).mode).toBe('custom')
            expect(configToCron(cronToConfig(expr))).toBe(expr)
        }
        // 固化不变量：凡是 interval 候选，步长必 ≥1，写回不含 `*/0`
        for (const expr of ['*/1 * * * *', '*/30 * * * *', '*/60 * * * *', '0 */6 * * *']) {
            const c = cronToConfig(expr)
            expect(c.mode).toBe('interval')
            expect(c.intervalValue).toBeGreaterThanOrEqual(1)
            expect(configToCron(c)).not.toMatch(/\*\/0+(\s|$)/)
        }
    })
})
