import {describe, it, expect} from 'vitest'
import {resolveCustomPrice, pricingToPriceSource, type CustomPriceEntry} from '@shared/usagePriceResolver'

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
