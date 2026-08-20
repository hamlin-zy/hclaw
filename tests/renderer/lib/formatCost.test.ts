import {describe, expect, it, afterEach} from 'vitest'
import {formatCost, formatPercent, getUsdCnyRate, setUsdCnyRate} from '../../../src/renderer/lib/format'
import {DEFAULT_USD_CNY_RATE} from '@shared/exchangeRate'

describe('formatCost（成本格式化）', () => {
    it('0 → 破折号（未定价）', () => {
        expect(formatCost(0)).toBe('—')
    })

    it('低于 0.01 阈值 → <$0.01', () => {
        expect(formatCost(0.005)).toBe('<$0.01')
    })

    it('0.01 边界 → $0.01', () => {
        expect(formatCost(0.01)).toBe('$0.01')
    })

    it('四舍五入到分', () => {
        expect(formatCost(10.715)).toBe('$10.72')
        expect(formatCost(10.714)).toBe('$10.71')
    })

    it('整数 → 补两位小数', () => {
        expect(formatCost(1000.5)).toBe('$1000.50')
    })

    it('负数（异常）→ 破折号', () => {
        expect(formatCost(-1)).toBe('—')
    })
})

describe('formatCost（人民币计价）', () => {
    it('CNY 按固定汇率换算并四舍五入到分', () => {
        // 12.88 * 7.2 = 92.736 → 92.74
        expect(formatCost(12.88, 'CNY')).toBe('¥92.74')
        // 10.71 * 7.2 = 77.112 → 77.11
        expect(formatCost(10.71, 'CNY')).toBe('¥77.11')
        // 2.17 * 7.2 = 15.624 → 15.62
        expect(formatCost(2.17, 'CNY')).toBe('¥15.62')
    })

    it('整数 → 补两位小数', () => {
        expect(formatCost(1, 'CNY')).toBe('¥7.20')
    })

    it('未同步时兜底汇率与默认常量一致（7.2）', () => {
        expect(getUsdCnyRate()).toBe(DEFAULT_USD_CNY_RATE)
    })

    it('0 / 负数 → 破折号（未定价，与币种无关）', () => {
        expect(formatCost(0, 'CNY')).toBe('—')
        expect(formatCost(-5, 'CNY')).toBe('—')
    })

    it('低于 USD 0.01 阈值的金额，CNY 不套用该阈值（直接换算）', () => {
        // 0.005 USD 在 USD 口径下是 <$0.01，但 CNY 下应换算为 ¥0.04
        expect(formatCost(0.005, 'CNY')).toBe('¥0.04')
    })

    it('默认参数仍是 USD（向后兼容）', () => {
        expect(formatCost(12.88)).toBe('$12.88')
    })
})

describe('setUsdCnyRate（运行时汇率更新边界）', () => {
    // 模块级全局状态：每个用例后恢复默认，避免污染其他用例（formatCost CNY 依赖当前汇率）
    afterEach(() => {
        setUsdCnyRate(DEFAULT_USD_CNY_RATE)
    })

    it('合法值更新：getUsdCnyRate 返回新值', () => {
        setUsdCnyRate(7.15)
        expect(getUsdCnyRate()).toBe(7.15)
    })

    it('NaN / Infinity → 忽略，保留当前值', () => {
        setUsdCnyRate(7.1)
        setUsdCnyRate(Number.NaN)
        expect(getUsdCnyRate()).toBe(7.1)
        setUsdCnyRate(Number.POSITIVE_INFINITY)
        expect(getUsdCnyRate()).toBe(7.1)
        setUsdCnyRate(Number.NEGATIVE_INFINITY)
        expect(getUsdCnyRate()).toBe(7.1)
    })

    it('0 / 负数 → 忽略，保留当前值', () => {
        setUsdCnyRate(7.1)
        setUsdCnyRate(0)
        expect(getUsdCnyRate()).toBe(7.1)
        setUsdCnyRate(-3)
        expect(getUsdCnyRate()).toBe(7.1)
    })

    it('非 number 类型（字符串 / 对象 / null / undefined）→ 忽略', () => {
        setUsdCnyRate(7.1)
        setUsdCnyRate('6.5' as unknown as number)
        expect(getUsdCnyRate()).toBe(7.1)
        setUsdCnyRate(null as unknown as number)
        expect(getUsdCnyRate()).toBe(7.1)
        setUsdCnyRate(undefined as unknown as number)
        expect(getUsdCnyRate()).toBe(7.1)
        setUsdCnyRate({rate: 6.5} as unknown as number)
        expect(getUsdCnyRate()).toBe(7.1)
    })

    it('更新后 formatCost CNY 按新汇率换算', () => {
        setUsdCnyRate(6.5)
        // 12.88 * 6.5 = 83.72
        expect(formatCost(12.88, 'CNY')).toBe('¥83.72')
    })

    it('非法值后 formatCost 仍用当前有效汇率（不回落默认）', () => {
        setUsdCnyRate(6.5)
        setUsdCnyRate(Number.NaN)
        expect(formatCost(12.88, 'CNY')).toBe('¥83.72')
    })
})

describe('formatPercent（占比格式化）', () => {
    it('0 → 0', () => {
        expect(formatPercent(0)).toBe('0')
    })

    it('0.5 → 50', () => {
        expect(formatPercent(0.5)).toBe('50')
    })

    it('四舍五入到整数', () => {
        expect(formatPercent(0.855)).toBe('86')
    })

    it('1 → 100', () => {
        expect(formatPercent(1)).toBe('100')
    })

    it('负数 / NaN → 0（异常防御）', () => {
        expect(formatPercent(-0.1)).toBe('0')
        expect(formatPercent(Number.NaN)).toBe('0')
    })
})
