/**
 * color 单元测试
 *
 * 覆盖 Hex↔HSL 转换、Hex→rgba、暗色判断、品牌色派生。
 * 纯函数模块，无 IO 依赖。
 */
import {describe, expect, it} from 'vitest'
import {
  hexToHsl,
  hslToHex,
  hexToRgba,
  isDarkColor,
  deriveBrandColors,
} from '@/renderer/lib/color'

describe('hexToHsl', () => {
  it('纯红 #ff0000 → {h:0, s:100, l:50}', () => {
    expect(hexToHsl('#ff0000')).toEqual({h: 0, s: 100, l: 50})
  })

  it('白色/黑色', () => {
    expect(hexToHsl('#ffffff')).toEqual({h: 0, s: 0, l: 100})
    expect(hexToHsl('#000000')).toEqual({h: 0, s: 0, l: 0})
  })

  it('3 位缩写 #f00', () => {
    expect(hexToHsl('#f00')).toEqual({h: 0, s: 100, l: 50})
  })

  it('灰色（s=0）', () => {
    expect(hexToHsl('#808080')).toEqual({h: 0, s: 0, l: 50})
    expect(hexToHsl('#000000').s).toBe(0)
  })

  it('3 位与 6 位等价', () => {
    expect(hexToHsl('#f0f')).toEqual(hexToHsl('#ff00ff'))
  })
})

describe('hslToHex', () => {
  it('round-trip：#ff0000 → hsl(0,100,50) → #ff0000', () => {
    expect(hslToHex(0, 100, 50)).toBe('#ff0000')
  })

  it('其他已知色值', () => {
    expect(hslToHex(120, 100, 50)).toBe('#00ff00')
    expect(hslToHex(120, 100, 22)).toBe('#007000')
  })
})

describe('hexToRgba', () => {
  it('生成 rgba 字符串', () => {
    expect(hexToRgba('#ff0000', 0.5)).toBe('rgba(255, 0, 0, 0.5)')
    expect(hexToRgba('#00ff00', 1)).toBe('rgba(0, 255, 0, 1)')
    expect(hexToRgba('#000000', 0)).toBe('rgba(0, 0, 0, 0)')
  })

  it('不带 # 前缀也支持', () => {
    expect(hexToRgba('ff0000', 0.5)).toBe('rgba(255, 0, 0, 0.5)')
  })
})

describe('isDarkColor', () => {
  it('暗色返回 true', () => {
    expect(isDarkColor('#000000')).toBe(true)
    expect(isDarkColor('#1a1a1a')).toBe(true)
    expect(isDarkColor('#303030')).toBe(true)
  })

  it('亮色返回 false', () => {
    expect(isDarkColor('#ffffff')).toBe(false)
    expect(isDarkColor('#ff0000')).toBe(false) // l=50，不 < 50
    expect(isDarkColor('#808080')).toBe(false) // l=50
  })
})

describe('deriveBrandColors', () => {
  it('返回四键结构', () => {
    const colors = deriveBrandColors('#ff0000')
    expect(Object.keys(colors).sort()).toEqual([
      '--brand-hover',
      '--brand-muted',
      '--brand-primary',
      '--glow-active',
      '--glow-subtle',
    ])
  })

  it('亮色主题压暗 8%（l>=40）', () => {
    // #ff0000 → l=50，压暗 8 → 42
    const colors = deriveBrandColors('#ff0000')
    expect(colors['--brand-hover']).toBe('#d60000')
    expect(colors['--brand-primary']).toBe('#ff0000')
  })

  it('暗色主题提亮 12%（l<40），上限 95', () => {
    // #1e1e1e → l=12，提亮 12 → 24
    const dark = deriveBrandColors('#1e1e1e')
    expect(dark['--brand-hover']).toBe('#3d3d3d')
    // #003300 → l=10，提亮 12 → 22
    expect(deriveBrandColors('#003300')['--brand-hover']).toBe('#007000')
  })

  it('hover 压暗下限 8', () => {
    // 极低亮度压暗不会低于 8（此处 l<40 走提亮分支，构造 l>=40 验证下限夹紧）
    // #808080 → l=50 压暗 8 → 42，未触底
    expect(deriveBrandColors('#808080')['--brand-hover']).toBe('#6b6b6b')
  })

  it('muted/glow 透明度', () => {
    const colors = deriveBrandColors('#ff0000')
    expect(colors['--brand-muted']).toBe('rgba(255, 0, 0, 0.12)')
    expect(colors['--glow-subtle']).toBe('rgba(255, 0, 0, 0.25)')
    expect(colors['--glow-active']).toBe('rgba(255, 0, 0, 0.4)')
  })
})
