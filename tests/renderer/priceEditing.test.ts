import {describe, expect, it} from 'vitest'
import {perMtoToken, tokenToPerM, type Currency, type ModelPricing} from '@shared/pricing'
import {
  commitRow,
  displayEnteredCell,
  displayPrice,
  formatPrice,
  parsePriceInput,
  reverseHintPrice,
  type PriceEdits,
} from '@/renderer/lib/priceEditing'

/** 宽容比较（浮点容差） */
function close(a: number | undefined, b: number | undefined, eps = 1e-15): boolean {
  if (a === undefined || b === undefined) return a === b
  return Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b))
}

describe('displayPrice', () => {
  it('空 / undefined → 空串', () => {
    expect(displayPrice(undefined, 'USD', 7.2)).toBe('')
    expect(displayPrice(undefined, 'CNY', 7.2)).toBe('')
  })

  it('USD：USD/token → $/1M，去尾零', () => {
    expect(displayPrice(perMtoToken(15), 'USD', 7.2)).toBe('15')
    expect(displayPrice(perMtoToken(108), 'USD', 1)).toBe('108')
    expect(displayPrice(perMtoToken(18.031234567), 'USD', 1)).toBe('18.03123457')
    expect(displayPrice(0, 'USD', 7.2)).toBe('0')
  })

  it('CNY：$ /1M × 汇率，rate=7.2：perMtoToken(15) → 108', () => {
    expect(displayPrice(perMtoToken(15), 'CNY', 7.2)).toBe('108')
    expect(displayPrice(perMtoToken(1), 'CNY', 1)).toBe('1')
  })
})

describe('parsePriceInput', () => {
  it('空串 / 非法 → undefined', () => {
    expect(parsePriceInput('', 'USD', 7.2)).toBeUndefined()
    expect(parsePriceInput('  ', 'CNY', 7.2)).toBeUndefined()
    expect(parsePriceInput('abc', 'USD', 7.2)).toBeUndefined()
    expect(parsePriceInput('-1', 'USD', 7.2)).toBeUndefined()
  })

  it('USD：$/1M → USD/token', () => {
    expect(close(parsePriceInput('15', 'USD', 7.2)!, perMtoToken(15))).toBe(true)
  })

  it('CNY ÷ 汇率再 perMtoToken：parsePriceInput("108","CNY",7.2) ≈ perMtoToken(15)', () => {
    expect(close(parsePriceInput('108', 'CNY', 7.2)!, perMtoToken(15))).toBe(true)
  })
})

describe('commitRow（落盘边界）', () => {
  const original = {
    input: perMtoToken(15),
    output: perMtoToken(108),
    cacheRead: perMtoToken(1.25),
    cacheWrite: perMtoToken(2.75),
  }

  it('纯切换浏览（edits 为空）→ 存储值原样透传（不折算、不漂移）', () => {
    const r = commitRow(original, undefined, 'CNY', 7.2)
    expect(r).toEqual(original)
  })

  it('USD 录入 → 切￥ → 切回 $，未编辑单元格与初始存储一致', () => {
    // 用户只在 USD 下编辑了 input=20，切到 CNY 再切回 USD（无新编辑）
    const edits: PriceEdits['row1'] = {input: '20'}
    const r = commitRow(original, edits, 'USD', 7.2)
    expect(close(r!.input!, perMtoToken(20))).toBe(true)
    // 其余三个未编辑单元格：原值透传
    expect(close(r!.output!, original.output)).toBe(true)
    expect(close(r!.cacheRead!, original.cacheRead)).toBe(true)
    expect(close(r!.cacheWrite!, original.cacheWrite)).toBe(true)
  })

  it('CNY 录入落盘 = 输入值 ÷ 汇率 再 perMtoToken（rate=7.2）', () => {
    const edits: PriceEdits['row1'] = {output: '108'}
    const r = commitRow(original, edits, 'CNY', 7.2)
    expect(close(r!.output!, perMtoToken(15))).toBe(true)
    // 未编辑的 input 原值透传，不受 CNY 展示影响
    expect(close(r!.input!, original.input)).toBe(true)
  })

  it('8 位小数输入往返容差：commitRow(parse 回写) 与原值一致（USD 与 CNY 双向）', () => {
    const v = perMtoToken(18.031234567)
    const shown = displayPrice(v, 'USD', 1)
    const roundTrip = parsePriceInput(shown, 'USD', 1)!
    expect(Math.abs(roundTrip - v)).toBeLessThan(1e-13)

    const edits: PriceEdits['row1'] = {cacheRead: shown}
    const r = commitRow(original, edits, 'USD', 1)
    expect(Math.abs(r!.cacheRead! - roundTrip)).toBeLessThan(1e-15)

    // CNY 侧：展示 8 位 → 解析回写
    const shownCny = displayPrice(v, 'CNY', 7.2)
    const rtCny = parsePriceInput(shownCny, 'CNY', 7.2)!
    expect(Math.abs(rtCny - v)).toBeLessThan(1e-13)
  })

  it('部分字段 undefined 原值 + 编辑值合成；非法编辑 → 该字段 undefined', () => {
    const partial = {input: perMtoToken(15), output: perMtoToken(108), cacheWrite: undefined}
    const edits: PriceEdits['row1'] = {input: 'abc'}
    const r = commitRow(partial, edits, 'USD', 7.2)
    expect(r!.input).toBeUndefined()
    expect(close(r!.output!, perMtoToken(108))).toBe(true)
    expect(r!.cacheRead).toBeUndefined()
    expect(r!.cacheWrite).toBeUndefined()
  })

  it('全空（原值全空 + 无编辑）→ undefined', () => {
    expect(commitRow(undefined, undefined, 'USD', 7.2)).toBeUndefined()
    expect(commitRow({}, {}, 'CNY', 7.2)).toBeUndefined()
  })
})

describe('tokenToPerM 往返一致性', () => {
  it('perMtoToken/tokenToPerM 往返', () => {
    expect(close(tokenToPerM(perMtoToken(42)), 42)).toBe(true)
  })
})

describe('formatPrice（公用格式化）', () => {
  it('8 位小数去尾零', () => {
    expect(formatPrice(0.1)).toBe('0.1')
    expect(formatPrice(1)).toBe('1')
    expect(formatPrice(18.031234567)).toBe('18.03123457')
    expect(formatPrice(0)).toBe('0')
  })
})

describe('录入即真（entered，回归：保存/重开汇率不同不再漂移）', () => {
  /** 模拟「保存 → 重开」全链路：commit 落盘（saveRate）→ 回显（reopenRate） */
  function saveAndReopen(
    pricing: ModelPricing | undefined,
    edits: PriceEdits[string] | undefined,
    cur: Currency,
    saveRate: number,
    reopenRate: number,
  ): {pricing: ModelPricing | undefined; echo: string} {
    const saved = commitRow(pricing, edits, cur, saveRate)
    // 重开回显：input 列（回显不依赖编辑串，直接读落盘 pricing）
    const echo = displayEnteredCell(saved, 'input', cur, reopenRate)
    return {pricing: saved, echo}
  }

  it('a) CNY 录入 0.1 → commit → 不同汇率下回显 === "0.1"（漂移回归用例）', () => {
    // 保存时 rate=6.713，重开时 rate=6.71301544（旧实现会折算出 0.10000023）
    const {pricing, echo} = saveAndReopen(undefined, {input: '0.1'}, 'CNY', 6.713, 6.71301544)
    expect(echo).toBe('0.1')
    // entered 真相落盘
    expect(pricing!.entered).toEqual({currency: 'CNY', values: {input: 0.1}})
    // USD/token 快照按保存时汇率固化（用量成本语义不变，不随重开汇率变）
    expect(close(pricing!.input!, perMtoToken(0.1 / 6.713))).toBe(true)
    // 美元价 = 录入值 ÷ 实时汇率（回显时另算，不依赖快照）
    expect(reverseHintPrice(pricing, 'input', 'CNY', 6.71301544, undefined)!.value)
      .toBe(formatPrice(0.1 / 6.71301544))
  })

  it('b) USD 录入 0.1 → commit → 不同汇率下回显 === "0.1"；CNY = 0.1 × rate', () => {
    const {pricing, echo} = saveAndReopen(undefined, {input: '0.1'}, 'USD', 6.713, 6.9)
    expect(echo).toBe('0.1')
    expect(pricing!.entered).toEqual({currency: 'USD', values: {input: 0.1}})
    expect(close(pricing!.input!, perMtoToken(0.1))).toBe(true)
    expect(reverseHintPrice(pricing, 'input', 'USD', 6.9, undefined)!.value).toBe(formatPrice(0.1 * 6.9))
  })

  it('c) entered 录入值与另一币种互算正确（CNY→USD 除 rate，USD→CNY 乘 rate）', () => {
    const cnyRow: ModelPricing = {input: perMtoToken(1), entered: {currency: 'CNY', values: {input: 7.2}}}
    expect(reverseHintPrice(cnyRow, 'input', 'CNY', 7.2, undefined)).toEqual({value: '1', currency: 'USD'})
    const usdRow: ModelPricing = {input: perMtoToken(1), entered: {currency: 'USD', values: {input: 1}}}
    expect(reverseHintPrice(usdRow, 'input', 'USD', 7.2, undefined)).toEqual({value: '7.2', currency: 'CNY'})
    // 工具栏切到另一币种：仍按 entered 币种回显录入值
    expect(displayEnteredCell(cnyRow, 'input', 'USD', 7.2)).toBe('7.2')
  })

  it('d) 旧数据（无 entered）向后兼容：回显沿汇率折算行为不变', () => {
    const legacy: ModelPricing = {input: perMtoToken(15)}
    expect(displayEnteredCell(legacy, 'input', 'CNY', 7.2)).toBe('108')
    expect(displayEnteredCell(legacy, 'input', 'USD', 7.2)).toBe('15')
    expect(reverseHintPrice(legacy, 'input', 'CNY', 7.2, undefined)!.value).toBe('15')
    // 旧数据 commit（无编辑）→ 不产生 entered
    expect(commitRow(legacy, undefined, 'CNY', 7.2)!.entered).toBeUndefined()
  })

  it('e) commitRow 未编辑单元格透传（含 entered）；编辑单元格更新 entered', () => {
    const original: ModelPricing = {
      input: perMtoToken(15),
      output: perMtoToken(108),
      entered: {currency: 'CNY', values: {input: 108.3, output: 766.44}},
    }
    // 只编辑 output（CNY 工具栏）：input 透传、input 的 entered 透传
    const r = commitRow(original, {output: '800'}, 'CNY', 7.2)
    expect(close(r!.input!, original.input)).toBe(true)
    expect(close(r!.output!, perMtoToken(800 / 7.2))).toBe(true)
    expect(r!.entered!.currency).toBe('CNY')
    expect(r!.entered!.values.input).toBe(108.3)
    expect(r!.entered!.values.output).toBe(800)
    // 未编辑透传：displayEnteredCell 对 input 逐字回显
    expect(displayEnteredCell(r, 'input', 'CNY', 99)).toBe('108.3')
  })

  it('f) 编辑串为非法输入 → 该字段 USD/token 与录入值均丢弃（未配置）', () => {
    const r = commitRow(undefined, {input: 'abc'}, 'CNY', 7.2)
    expect(r).toBeUndefined()
  })

  it('g) 重录口径：entered(CNY) 下工具栏切 USD 后编辑任一格 → 整行按 USD 重计价', () => {
    const RATE = 6.713
    const pricing: ModelPricing = {
      input: perMtoToken(0.1 / RATE),
      entered: {currency: 'CNY', values: {input: 0.1}},
    }
    // a) 对 output 输入 "1"（想表达 1 USD）→ 不得落成 1 CNY
    const r = commitRow(pricing, {output: '1'}, 'USD', RATE)
    expect(r!.entered!.currency).toBe('USD')
    expect(close(r!.entered!.values.output!, 1)).toBe(true)
    // 旧 input 录入值换算到 USD
    expect(close(r!.entered!.values.input!, 0.1 / RATE)).toBe(true)
    // USD/token：output 固化为 1 USD；input 透传（本就是 USD/token）
    expect(close(r!.output!, perMtoToken(1))).toBe(true)
    expect(close(r!.input!, pricing.input)).toBe(true)

    // b) 同格重录：对 input 输入 "2" → entered 变为 {USD, input:2}，旧 0.1 CNY 不影响解析
    const r2 = commitRow(pricing, {input: '2'}, 'USD', RATE)
    expect(r2!.entered).toEqual({currency: 'USD', values: {input: 2}})
    expect(close(r2!.input!, perMtoToken(2))).toBe(true)

    // c) 回显一致性：落盘后 reopen（不同汇率）逐字回显
    expect(displayEnteredCell(r, 'output', 'USD', 6.9)).toBe('1')
    expect(displayEnteredCell(r, 'input', 'USD', 6.9)).toBe(formatPrice(0.1 / RATE))
    expect(displayEnteredCell(r2, 'input', 'USD', 6.9)).toBe('2')
  })
})
