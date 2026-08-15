/**
 * displayMode 单元测试
 *
 * 覆盖三种显示模式 × 三种判断函数。
 * 纯函数模块，无 IO 依赖。
 */
import {describe, expect, it} from 'vitest'
import {
  isCompactMode,
  isUltraCompactMode,
  isDetailedMode,
} from '@/renderer/lib/displayMode'

describe('displayMode 判断', () => {
  it('detailed：仅 isDetailedMode 为 true', () => {
    expect(isDetailedMode('detailed')).toBe(true)
    expect(isCompactMode('detailed')).toBe(false)
    expect(isUltraCompactMode('detailed')).toBe(false)
  })

  it('compact：isCompactMode 为 true，其余 false', () => {
    expect(isCompactMode('compact')).toBe(true)
    expect(isDetailedMode('compact')).toBe(false)
    expect(isUltraCompactMode('compact')).toBe(false)
  })

  it('ultra-compact：compact 与 ultra-compact 均为 true', () => {
    expect(isCompactMode('ultra-compact')).toBe(true)
    expect(isUltraCompactMode('ultra-compact')).toBe(true)
    expect(isDetailedMode('ultra-compact')).toBe(false)
  })
})
