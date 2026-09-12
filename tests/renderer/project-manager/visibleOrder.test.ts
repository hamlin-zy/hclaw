import {describe, expect, it} from 'vitest'
import {menuSendPaths, sortByVisibleOrder} from '../../../src/renderer/project-manager/lib/visibleOrder'

const order = ['a', 'b', 'c', 'd']

describe('sortByVisibleOrder', () => {
  it('按显示顺序排列（入参顺序无关）', () => {
    expect(sortByVisibleOrder(new Set(['c', 'a', 'd']), order)).toEqual(['a', 'c', 'd'])
  })

  it('不可见项（不在显示顺序中）排末尾，且不丢成员', () => {
    expect(sortByVisibleOrder(['x', 'b', 'y', 'a'], order)).toEqual(['a', 'b', 'x', 'y'])
  })

  it('空集合 → 空数组', () => {
    expect(sortByVisibleOrder([], order)).toEqual([])
  })
})

describe('menuSendPaths', () => {
  it('有选中集合 → 按显示顺序全发', () => {
    expect(menuSendPaths(new Set(['d', 'b']), order, 'b')).toEqual(['b', 'd'])
  })

  it('选中集合为空 → 退回右键命中项', () => {
    expect(menuSendPaths(new Set(), order, 'c')).toEqual(['c'])
  })
})
