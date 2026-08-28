import {describe, expect, it} from 'vitest'
import {perMtoToken, tokenToPerM} from '@shared/pricing'
import {commitRow, displayPrice, parsePriceInput, type PriceEdits} from '@/renderer/lib/priceEditing'

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
