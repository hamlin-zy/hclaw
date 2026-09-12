import {describe, expect, it} from 'vitest'
import {formatLineRanges} from '../../../src/renderer/project-manager/lib/lineRanges'

describe('formatLineRanges', () => {
  it('空数组返回空串', () => {
    expect(formatLineRanges([])).toBe('')
  })
  it('单值不加横杠', () => {
    expect(formatLineRanges([12])).toBe('12')
  })
  it('连续区间压缩为 start-end', () => {
    expect(formatLineRanges([12, 13, 14])).toBe('12-14')
  })
  it('两段用逗号连接', () => {
    expect(formatLineRanges([12, 13, 14, 18])).toBe('12-14,18')
  })
  it('乱序与重复先去重排序', () => {
    expect(formatLineRanges([18, 12, 13, 12, 14])).toBe('12-14,18')
  })
  it('0 与负数原样保留', () => {
    expect(formatLineRanges([0, -2, 3])).toBe('-2,0,3')
  })
  it('非整数被丢弃', () => {
    expect(formatLineRanges([1.5, 2, NaN, 3])).toBe('2-3')
  })
})
