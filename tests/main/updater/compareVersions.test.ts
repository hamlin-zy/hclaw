import { describe, it, expect } from 'vitest'
import { compareVersions } from '../../../src/main/updater/compareVersions'

describe('compareVersions', () => {
  it('major 版本更大 → 正数', () => {
    expect(compareVersions('1.0.0', '0.9.9')).toBeGreaterThan(0)
  })

  it('minor 版本更大 → 正数', () => {
    expect(compareVersions('0.2.0', '0.1.99')).toBeGreaterThan(0)
  })

  it('patch 版本更大 → 正数', () => {
    expect(compareVersions('0.2.88', '0.2.87')).toBeGreaterThan(0)
  })

  it('a === b → 0', () => {
    expect(compareVersions('0.2.87', '0.2.87')).toBe(0)
  })

  it('a < b → 负数', () => {
    expect(compareVersions('0.2.86', '0.2.87')).toBeLessThan(0)
  })

  it('支持 v 前缀（GitHub tag 形式）', () => {
    expect(compareVersions('v0.2.88', '0.2.87')).toBeGreaterThan(0)
    expect(compareVersions('v0.2.87', 'v0.2.87')).toBe(0)
  })

  it('忽略 build metadata（+xxx）', () => {
    expect(compareVersions('0.2.87+sha.abc', '0.2.87')).toBe(0)
    expect(compareVersions('0.2.87+sha.abc', '0.2.88+sha.def')).toBeLessThan(0)
  })

  it('字典序陷阱：0.10.0 > 0.2.0（数值比较而非字符串比较）', () => {
    expect(compareVersions('0.10.0', '0.2.0')).toBeGreaterThan(0)
  })

  it('a 是无效版本 → null', () => {
    expect(compareVersions('garbage', '0.2.87')).toBeNull()
  })

  it('b 是无效版本 → null', () => {
    expect(compareVersions('0.2.87', 'not-a-version')).toBeNull()
  })

  it('段数不足（如 1.0）→ null', () => {
    expect(compareVersions('1.0', '0.2.87')).toBeNull()
    expect(compareVersions('0.2.87', '1')).toBeNull()
  })

  it('段数过多（如 1.0.0.0）→ null', () => {
    expect(compareVersions('1.0.0.0', '0.2.87')).toBeNull()
  })

  it('负数段 → null（非法 semver）', () => {
    expect(compareVersions('-1.0.0', '0.2.87')).toBeNull()
  })

  it('空字符串 → null', () => {
    expect(compareVersions('', '0.2.87')).toBeNull()
    expect(compareVersions('0.2.87', '')).toBeNull()
  })

  it('混合前缀：v 与无前缀混合比较', () => {
    expect(compareVersions('v0.2.88', '0.2.87')).toBeGreaterThan(0)
    expect(compareVersions('0.2.88', 'v0.2.87')).toBeGreaterThan(0)
  })
})