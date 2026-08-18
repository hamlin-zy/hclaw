import {describe, it, expect} from 'vitest'
import {resolveMaxContextTokens} from '../../../../src/main/agent/loop/modelMaxContext'

describe('resolveMaxContextTokens', () => {
  it('scheme.maxContextTokens 最优先（用户显式配置）', () => {
    expect(resolveMaxContextTokens({
      provider: 'openai',
      model: 'x',
      modelScheme: {maxContextTokens: 200000},
      modelMetaContextLength: 1000000,
      adapterInfo: {maxContextTokens: 128000},
    })).toBe(200000)
  })

  it('modelMetaContextLength > 0 优先于 adapter（or-models.json 权威）', () => {
    expect(resolveMaxContextTokens({
      provider: 'openai',
      model: 'gpt-4o',
      modelMetaContextLength: 1000000,
      adapterInfo: {maxContextTokens: 128000},
    })).toBe(1000000)
  })

  it('modelMetaContextLength = 0（or-models.json 未命中）→ 回退 adapter 硬编码表', () => {
    expect(resolveMaxContextTokens({
      provider: 'openai',
      model: 'unknown-model',
      modelMetaContextLength: 0,
      adapterInfo: {maxContextTokens: 200000},
    })).toBe(200000)
  })

  it('modelMetaContextLength 负数/NaN → 回退 adapter', () => {
    expect(resolveMaxContextTokens({
      provider: 'openai',
      model: 'x',
      modelMetaContextLength: -1,
      adapterInfo: {maxContextTokens: 128000},
    })).toBe(128000)
  })

  it('全部未命中 → 默认 128K', () => {
    expect(resolveMaxContextTokens({
      provider: 'openai',
      model: 'x',
      modelMetaContextLength: 0,
      adapterInfo: {maxContextTokens: 0},
    })).toBe(128000)
  })

  it('modelMetaContextLength 缺省（undefined）→ 兼容旧行为走 adapter', () => {
    expect(resolveMaxContextTokens({
      provider: 'openai',
      model: 'x',
      adapterInfo: {maxContextTokens: 200000},
    })).toBe(200000)
  })
})
