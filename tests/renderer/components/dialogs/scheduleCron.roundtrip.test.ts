// @vitest-environment node
/**
 * 频率保真往返性质测试（ui-08）
 *
 * 断言一条可独立于 UI 的性质：**任何表达式读出再写回必须完全等价**——
 * `configToCron(cronToConfig(e)) === e`。语料覆盖四种说法、高级模式兜底，
 * 以及旧实现会静默丢条件的样本（月份段、日列表、日+周并存、反向周区间）。
 */
import {describe, it, expect} from 'vitest'
import {
    configToCron,
    cronToConfig,
    cronToHuman,
    extractCronFields,
    makeDefaultConfig,
    MONTHLY_DATES,
    normalizeCron,
    seedFromCustomExpr,
} from '../../../../src/renderer/components/dialogs/scheduleCron'

/** 票面指定的往返语料（含坏输入）。 */
const CORPUS = [
    '0 9 * * *',
    '*/30 * * * *',
    '*/7 * * * *',
    '0 */2 * * *',
    '0 */6 * * *',
    '30 8 * * 1-5',
    '0 9 * * 1,3',
    '0 9 * * 3,1',
    '5 4 * * 0',
    '0 9 1 * *',
    '0 9 15 * *',
    '0 9 29 * *',
    '0 9 31 * *',
    '0 9 1,15 * *',
    '0 9 1 * 1',
    '0 0 29 2 *',
    '0 9 * 3 *',
    '0 9 * * 6-0',
    '0 9 * * 7-1',
    '0 9 * * 7-6',
    '0 9 * * 7-0',
    '0 9 * * 1-5,0',
    '0 9 * *',
    'not a cron',
    '',
]

describe('cronToConfig / configToCron 往返保真', () => {
    it('语料逐条：configToCron(cronToConfig(e)) === e', () => {
        for (const e of CORPUS) {
            expect(configToCron(cronToConfig(e)), `往返失真: ${e}`).toBe(e)
        }
    })

    it('语料逐条：无法归类者落入高级模式（custom）', () => {
        const customSamples: Array<[string, boolean]> = [
            // [表达式, 是否应落 custom]
            ['0 9 * * *', false],
            ['*/30 * * * *', false],
            ['0 */2 * * *', false],
            ['30 8 * * 1-5', false],
            ['0 9 15 * *', false],
            ['5 4 * * 0', false],
            ['0 9 1,15 * *', true],   // 日列表：四种说法无对应
            ['0 9 1 * 1', true],      // 日 + 周并存
            ['0 0 29 2 *', true],     // 丢弃月份段会失真
            ['0 9 * 3 *', true],      // 指定月份
            ['0 9 * * 3,1', true],    // 乱序周，写不回原字面量
            ['0 9 * * 6-0', true],    // 反向周区间
            ['0 9 * * 7-1', true],    // 反向周区间（含非法端点 7）
            ['0 9 * * 7-6', true],    // 反向周区间（含非法端点 7）
            ['0 9 * * 1-5,0', true],  // 复合周
            ['0 9 * *', true],        // 段数不足
            ['not a cron', true],     // 非表达式
            ['', true],               // 空表达式（II-5）
        ]
        for (const [e, isCustom] of customSamples) {
            expect(cronToConfig(e).mode === 'custom', `模式判定: ${e}`).toBe(isCustom)
        }
    })

    it('可归类者读到正确的 config 字段', () => {
        expect(cronToConfig('0 9 * * *')).toMatchObject({mode: 'daily', dailyHour: 9, dailyMin: 0})
        // 回归：旧实现用 `parseInt(x) || 9`，把 0 点吞成 9 点
        expect(cronToConfig('0 0 * * *')).toMatchObject({mode: 'daily', dailyHour: 0, dailyMin: 0})
        expect(cronToConfig('*/30 * * * *')).toMatchObject({mode: 'interval', intervalValue: 30, intervalUnit: 'minutes'})
        expect(cronToConfig('*/7 * * * *')).toMatchObject({mode: 'interval', intervalValue: 7, intervalUnit: 'minutes'})
        expect(cronToConfig('0 */2 * * *')).toMatchObject({mode: 'interval', intervalValue: 2, intervalUnit: 'hours'})
        expect(cronToConfig('30 8 * * 1-5')).toMatchObject({
            mode: 'weekly',
            weeklyHour: 8, weeklyMin: 30,
            weeklyDays: [false, true, true, true, true, true, false],
        })
        expect(cronToConfig('0 9 15 * *')).toMatchObject({mode: 'monthly', monthlyDate: 15, monthlyHour: 9, monthlyMin: 0})
        expect(cronToConfig('5 4 * * 0')).toMatchObject({mode: 'weekly', weeklyDays: [true, false, false, false, false, false, false]})
    })

    it('兜底 custom 保留原文，且被标为「无法识别」', () => {
        const c = cronToConfig('0 9 1,15 * *')
        expect(c.mode).toBe('custom')
        expect(c.customExpr).toBe('0 9 1,15 * *')
        expect(c.unrecognized).toBe(true)
    })

    it('可归类者不被标为「无法识别」', () => {
        expect(cronToConfig('0 9 * * *').unrecognized).toBe(false)
        expect(cronToConfig('30 8 * * 1-5').unrecognized).toBe(false)
    })

    it('MONTHLY_DATES 覆盖 1..31（每月可直接点到 31 号）', () => {
        expect(MONTHLY_DATES[0]).toBe(1)
        expect(MONTHLY_DATES[MONTHLY_DATES.length - 1]).toBe(31)
        expect(MONTHLY_DATES).toHaveLength(31)
    })

    it('31 号往返仍等价', () => {
        expect(configToCron(cronToConfig('0 9 31 * *'))).toBe('0 9 31 * *')
    })
})

describe('往返性质：确定性穷举（不依赖外部随机源）', () => {
    const MINS = ['0', '5', '30', '*/10', '*/7', '1,15', '7']
    const HOURS = ['0', '9', '23', '*/2', '*/6', '8']
    const DAYS = ['*', '1', '15', '31', '1,15', '29']
    const MONTHS = ['*', '2', '3']
    const WEEKS = ['*', '0', '1-5', '1,3', '3,1', '6-0', '1-5,0']

    it('全组合的 configToCron(cronToConfig(e)) === e', () => {
        let checked = 0
        for (const mi of MINS) for (const h of HOURS) for (const d of DAYS)
            for (const mo of MONTHS) for (const w of WEEKS) {
                const e = `${mi} ${h} ${d} ${mo} ${w}`
                expect(configToCron(cronToConfig(e)), `往返失真: ${e}`).toBe(e)
                checked++
            }
        expect(checked).toBe(MINS.length * HOURS.length * DAYS.length * MONTHS.length * WEEKS.length)
    })
})

describe('cronToHuman 只出人话、不复述表达式', () => {
    it('每天 / 每周 / 每月 / 间隔', () => {
        expect(cronToHuman(cronToConfig('0 9 * * *'))).toBe('每天 09:00')
        expect(cronToHuman(cronToConfig('30 8 * * 1-5'))).toBe('每工作日 08:30')
        expect(cronToHuman(cronToConfig('0 9 * * 1,3'))).toBe('每周一、周三 09:00')
        expect(cronToHuman(cronToConfig('0 9 15 * *'))).toBe('每月 15 日 09:00')
        expect(cronToHuman(cronToConfig('*/30 * * * *'))).toBe('每 30 分钟')
        expect(cronToHuman(cronToConfig('0 */6 * * *'))).toBe('每 6 小时')
    })

    it('高级模式摘要不含原始表达式', () => {
        const human = cronToHuman(cronToConfig('0 9 1,15 * *'))
        expect(human).not.toContain('0 9')
        expect(human).toContain('高级')
    })

    it('默认 config 的人话摘要可用', () => {
        expect(cronToHuman(makeDefaultConfig())).toBe('每天 09:00')
    })
})

describe('I-3：归一化后再判「可归类」', () => {
    it('周字段 `7` 等价 `0`：`0 9 * * 7` 是每周日 9:00，不是「无法套用」', () => {
        const c = cronToConfig('0 9 * * 7')
        expect(c.mode).toBe('weekly')
        expect(c.weeklyDays).toEqual([true, false, false, false, false, false, false])
        expect(c.weeklyHour).toBe(9)
        expect(c.weeklyMin).toBe(0)
        expect(c.unrecognized).toBe(false)
        expect(c.customReason).toBeNull()
    })

    it('命名星期（大小写不敏感）同样可归类', () => {
        const samples: Array<[string, number]> = [['0 9 * * MON', 1], ['0 9 * * sun', 0], ['0 9 * * Fri', 5]]
        for (const [expr, day] of samples) {
            const c = cronToConfig(expr)
            expect(c.mode, expr).toBe('weekly')
            expect(c.weeklyDays?.[day], expr).toBe(true)
            expect(c.unrecognized, expr).toBe(false)
        }
    })

    it('字段间多余空白不影响归类', () => {
        expect(cronToConfig('0  9  *  *  *')).toMatchObject({mode: 'daily', dailyHour: 9, dailyMin: 0, unrecognized: false})
        expect(cronToConfig('  0 9 * * *\t')).toMatchObject({mode: 'daily', unrecognized: false})
    })

    it('归一化只动「写法」不动原文：customExpr 仍逐字节保留', () => {
        expect(normalizeCron('0 9 * * 7')).toBe('0 9 * * 0')
        expect(normalizeCron('0  9\t* * MON')).toBe('0 9 * * 1')
        expect(cronToConfig('0 9 1,15 * *').customExpr).toBe('0 9 1,15 * *')
    })

    it('「真的不像四种说法」(unparsed) 与「写法写不回」(not-writable) 分开标注', () => {
        expect(cronToConfig('not a cron').customReason).toBe('unparsed')
        expect(cronToConfig('0 9 * *').customReason).toBe('unparsed')
        expect(cronToConfig('').customReason).toBe('unparsed')
        expect(cronToConfig('0 9 1,15 * *').customReason).toBe('not-writable')
        expect(cronToConfig('0 9 * * 3,1').customReason).toBe('not-writable')
        expect(cronToConfig('0 9 * 3 *').customReason).toBe('not-writable')
        expect(cronToConfig('0 9 * * *').customReason).toBeNull()
    })
})

describe('回归：周区间端点不做 `7→0`，非法区间不得被判成「可归类」', () => {
    /**
     * `7-1` 在后端（cron-parser）是 `min(7) > max(1)` 的非法区间，该 cron 永不触发。
     * 若归一化把端点 `7` 也映射成 `0`，它会变成合法升序区间 `0-1` 并通过反向自检，
     * 于是被静默改写：`7-1` → `0-1`（开始按周日/周一触发）、`7-6` → `0-6`（变成每天触发）。
     */
    const ILLEGAL_RANGES = ['0 9 * * 7-1', '0 9 * * 7-6']

    it('非法周区间不被归一化改写（端点保持原样）', () => {
        expect(normalizeCron('0 9 * * 7-1')).toBe('0 9 * * 7-1')
        expect(normalizeCron('0 9 * * 7-6')).toBe('0 9 * * 7-6')
        // 单值 `7` 仍等价 `0`（I-3 的行为不受影响）
        expect(normalizeCron('0 9 * * 7')).toBe('0 9 * * 0')
        // 命名星期区间仍可归一
        expect(normalizeCron('0 9 * * MON-FRI')).toBe('0 9 * * 1-5')
    })

    it.each(ILLEGAL_RANGES)('%s 落 custom / not-writable，不假装可归类', (expr) => {
        const c = cronToConfig(expr)
        expect(c.mode).toBe('custom')
        expect(c.unrecognized).toBe(true)
        expect(c.customReason).toBe('not-writable')
        expect(c.customExpr).toBe(expr)          // 原文逐字节保留
        expect(configToCron(c)).toBe(expr)       // 写回不被改写成 0-1 / 0-6
    })

    it.each(ILLEGAL_RANGES)('%s 读出再写回逐字节不变', (expr) => {
        expect(configToCron(cronToConfig(expr))).toBe(expr)
        expect(cronToConfig(expr).customExpr).toBe(expr)
    })

    it('对照组：`0 9 * * 7-7` 不因「端点含 7」被静默改写', () => {
        // 端点相等不是降序区间；`7-7` 归一后仍是 `7-7`，写不回字面量 → 诚实落高级
        expect(configToCron(cronToConfig('0 9 * * 7-7'))).toBe('0 9 * * 7-7')
    })
})

describe('I-1：从自由表达式尽力抽取字段（切走时播种用）', () => {
    it('抽出 分/时/日集/周集', () => {
        expect(extractCronFields('30 14 1,15 * *')).toMatchObject({minute: 30, hour: 14, dates: [1, 15]})
        expect(extractCronFields('0 9 * * 1,3').weekdays).toEqual([false, true, false, true, false, false, false])
        expect(extractCronFields('*/30 * * * *')).toMatchObject({minute: null, hour: null})
        expect(extractCronFields('not a cron')).toMatchObject({minute: null, hour: null, dates: null, weekdays: null})
    })

    it('切到「每天」：时/分从原表达式派生，不再恒为 9:00', () => {
        const seed = seedFromCustomExpr('30 14 1,15 * *', 'daily')
        expect(seed).toEqual({dailyHour: 14, dailyMin: 30})
        expect(configToCron({...makeDefaultConfig(), ...seed, mode: 'daily'})).toBe('30 14 * * *')
    })

    it('切到「每周」：星期集从原表达式派生', () => {
        const seed = seedFromCustomExpr('0 9 1 * 1,3', 'weekly')
        expect(seed.weeklyDays).toEqual([false, true, false, true, false, false, false])
        expect(configToCron({...makeDefaultConfig(), ...seed, mode: 'weekly'})).toBe('0 9 * * 1,3')
    })

    it('切到「每月」：几号从原表达式派生', () => {
        expect(seedFromCustomExpr('15 2 20 * *', 'monthly')).toMatchObject({monthlyDate: 20, monthlyHour: 2, monthlyMin: 15})
    })

    it('切到「间隔」：*/N 派生为间隔值', () => {
        expect(seedFromCustomExpr('*/15 * * * *', 'interval')).toEqual({intervalUnit: 'minutes', intervalValue: 15})
        expect(seedFromCustomExpr('0 */6 * * *', 'interval')).toEqual({intervalUnit: 'hours', intervalValue: 6})
    })

    it('抽不出时返回空 patch（保留目标模式既有值，而非凭空生成）', () => {
        expect(seedFromCustomExpr('not a cron', 'daily')).toEqual({})
        expect(seedFromCustomExpr('0 9 * *', 'daily')).toEqual({})
    })
})
