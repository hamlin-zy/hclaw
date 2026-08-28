import {describe, it, expect} from 'vitest'
import {perMtoToken, tokenToPerM} from '@shared/pricing'

describe('价格单位换算 $/1M ↔ USD/token', () => {
  it('perMtoToken：15 $/M → 0.000015 USD/token', () => {
    expect(perMtoToken(15)).toBeCloseTo(0.000015, 12)
  })
  it('tokenToPerM：0.000015 USD/token → 15 $/M', () => {
    expect(tokenToPerM(0.000015)).toBeCloseTo(15, 9)
  })
  it('往返无损（放大 1e6 比较 + 浮点容差）', () => {
    for (const v of [3.5, 0.000001, 120, 8888.88888888]) {
      expect(tokenToPerM(perMtoToken(v))).toBeCloseTo(v, 9)
    }
  })
})
