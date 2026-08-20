import {describe, expect, it} from 'vitest'
import {DEFAULT_USD_CNY_RATE, getRate, parseExchangeRates, type ExchangeRateData} from '@shared/exchangeRate'

/** 构造 currency-api usd.min.json 响应 */
function usdResponse(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    date: '2026-08-20',
    usd: {cny: 6.725761, eur: 0.85606296, jpy: 158.35607009},
    ...overrides,
  })
}

describe('parseExchangeRates（usd.min.json 解析）', () => {
  it('正常解析：提取 date + cny 等汇率', () => {
    const data = parseExchangeRates(usdResponse())
    expect(data).not.toBeNull()
    expect(data!.date).toBe('2026-08-20')
    expect(data!.rates.cny).toBe(6.725761)
    expect(data!.rates.eur).toBe(0.85606296)
    expect(data!.rates.jpy).toBe(158.35607009)
  })

  it('非法 JSON → null', () => {
    expect(parseExchangeRates('not json')).toBeNull()
    expect(parseExchangeRates('')).toBeNull()
  })

  it('缺 date / date 非字符串 → null', () => {
    expect(parseExchangeRates(usdResponse({date: undefined}))).toBeNull()
    expect(parseExchangeRates(usdResponse({date: 20260820}))).toBeNull()
  })

  it('缺 usd 表 / usd 非对象 → null', () => {
    expect(parseExchangeRates(usdResponse({usd: undefined}))).toBeNull()
    expect(parseExchangeRates(usdResponse({usd: []}))).toBeNull()
    expect(parseExchangeRates(usdResponse({usd: '6.7'}))).toBeNull()
  })

  it('无 cny（无法换算）→ null', () => {
    expect(parseExchangeRates(usdResponse({usd: {eur: 0.85}}))).toBeNull()
  })

  it('坏字段逐条跳过：NaN / 负数 / 非数字被过滤，正常字段保留', () => {
    const data = parseExchangeRates(usdResponse({usd: {cny: 6.7, eur: '0.85', bad1: -1, bad2: 'abc', bad3: NaN}}))
    expect(data).not.toBeNull()
    expect(data!.rates.cny).toBe(6.7)
    expect(data!.rates.eur).toBe(0.85)
    expect(data!.rates.bad1).toBeUndefined()
    expect(data!.rates.bad2).toBeUndefined()
    expect(data!.rates.bad3).toBeUndefined()
  })

  it('顶层非对象（数组 / 标量）→ null', () => {
    expect(parseExchangeRates('[1,2,3]')).toBeNull()
    expect(parseExchangeRates('42')).toBeNull()
  })
})

describe('getRate（取值助手）', () => {
  const data: ExchangeRateData = {date: '2026-08-20', rates: {cny: 6.725761}}

  it('命中返回汇率', () => {
    expect(getRate(data, 'cny')).toBe(6.725761)
  })

  it('未命中 / 非法值 → 0', () => {
    expect(getRate(data, 'eur')).toBe(0)
    expect(getRate(data, '')).toBe(0)
    expect(getRate({date: '2026-08-20', rates: {cny: 0}}, 'cny')).toBe(0)
    expect(getRate({date: '2026-08-20', rates: {cny: -3}}, 'cny')).toBe(0)
  })
})

describe('DEFAULT_USD_CNY_RATE（兜底默认值）', () => {
  it('离线 / 未同步时使用 7.2', () => {
    expect(DEFAULT_USD_CNY_RATE).toBe(7.2)
  })
})
