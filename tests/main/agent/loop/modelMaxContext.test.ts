import {describe, it, expect} from 'vitest'
import {resolveMaxContextTokens} from '../../../../src/main/agent/loop/modelMaxContext'

describe('resolveMaxContextTokens', () => {
  it('modelMetaContextLength > 0 → 使用 meta 权威窗口', () => {
    expect(
      resolveMaxContextTokens({
        modelMetaContextLength: 200000,
      }),
    ).toBe(200000)
  })
  it('modelMetaContextLength = 0（未命中）→ 默认 1M', () => {
    expect(
      resolveMaxContextTokens({
        modelMetaContextLength: 0,
      }),
    ).toBe(1000000)
  })
})
