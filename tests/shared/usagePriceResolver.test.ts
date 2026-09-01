import {describe, it, expect} from 'vitest'
import {resolveCustomPrice, pricingToPriceSource, resolvePriceSource, type CustomPriceEntry} from '@shared/usagePriceResolver'

const entries: CustomPriceEntry[] = [
  {providerId: 'p1', providerName: 'Alpha', model: 'gpt-4o', pricing: {input: 1e-6}},
  {providerId: 'p2', providerName: 'Beta', model: 'gpt-4o', pricing: {input: 2e-6}},
  {providerId: 'p1', providerName: 'Alpha', model: 'claude-3', pricing: {output: 3e-6}},
]

describe('resolveCustomPrice 归属链', () => {
  it('(providerId, model) 精确命中——同模型多服务商不串价', () => {
    expect(resolveCustomPrice(entries, {model: 'gpt-4o', providerId: 'p2'})?.input).toBe(2e-6)
    expect(resolveCustomPrice(entries, {model: 'gpt-4o', providerId: 'p1'})?.input).toBe(1e-6)
  })
  it('缺 provider_id → 按 providerName 首命中（重名取确定性首个，局限注释见实现）', () => {
    expect(resolveCustomPrice(entries, {model: 'gpt-4o', providerName: 'Alpha'})?.input).toBe(1e-6)
  })
  it('providerId 与 providerName 冲突时 providerId 优先', () => {
    expect(resolveCustomPrice(entries, {model: 'gpt-4o', providerId: 'p2', providerName: 'Alpha'})?.input).toBe(2e-6)
  })
  it('全未命中 → null（调用方回退 OpenRouter 全局价目表）', () => {
    expect(resolveCustomPrice(entries, {model: 'gpt-4o'})).toBeNull()
    expect(resolveCustomPrice(entries, {model: 'unknown-model', providerId: 'p9'})).toBeNull()
  })
})

describe('pricingToPriceSource', () => {
  it('缺省维度补 0，cacheWrite 缺省 → 0', () => {
    expect(pricingToPriceSource({input: 1e-6})).toEqual({
      inputPrice: 1e-6, outputPrice: 0, cacheReadPrice: 0, cacheWritePrice: 0,
    })
  })
})

describe('resolvePriceSource（行级取价，shared/主进程共用）', () => {
  const getMeta = (model: string) => ({inputPrice: 3e-6, outputPrice: 15e-6, cacheReadPrice: 0.3e-6, cacheWritePrice: 0})
  const entries: CustomPriceEntry[] = [
    {providerId: 'p1', providerName: 'Alpha', model: 'm1', pricing: {input: 2e-6}},
  ]

  it('自定义价命中 → pricingToPriceSource（缺失维度补 0）', () => {
    expect(resolvePriceSource('m1', 'p1', 'Alpha', getMeta, entries)).toEqual({
      inputPrice: 2e-6, outputPrice: 0, cacheReadPrice: 0, cacheWritePrice: 0,
    })
  })
  it('未命中（model/provider 均不匹配）→ getMeta 兜底', () => {
    expect(resolvePriceSource('m1', 'p9', 'Other', getMeta, entries)).toEqual(getMeta('m1'))
    expect(resolvePriceSource('unknown', 'p1', 'Alpha', getMeta, entries)).toEqual(getMeta('unknown'))
  })
  it('customPrices 缺省 / 空数组 → getMeta 兜底', () => {
    expect(resolvePriceSource('m1', 'p1', 'Alpha', getMeta)).toEqual(getMeta('m1'))
    expect(resolvePriceSource('m1', 'p1', 'Alpha', getMeta, [])).toEqual(getMeta('m1'))
  })
  it('getMeta 兜底时原样返回（不补维度，保持既有路径不变）', () => {
    const partial = {inputPrice: 1e-6, outputPrice: 2e-6, cacheReadPrice: 3e-6}
    expect(resolvePriceSource('m1', null, null, () => partial as any, entries)).toBe(partial)
  })
})
