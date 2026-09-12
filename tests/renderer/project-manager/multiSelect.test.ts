import {describe, expect, it} from 'vitest'
import {applyMultiSelect, type MultiSelectState} from '../../../src/renderer/project-manager/lib/multiSelect'

const S = (selected: string[], anchor: string | null): MultiSelectState =>
  ({selected: new Set(selected), anchor})
const order = ['a', 'b', 'c', 'd', 'e']

describe('applyMultiSelect', () => {
  it('普通单击替换为单元素，anchor 与 main 均为该项', () => {
    const r = applyMultiSelect(S(['a', 'b'], 'a'), 'c', order, {})
    expect([...r.selected]).toEqual(['c'])
    expect(r.anchor).toBe('c')
    expect(r.main).toBe('c')
  })

  it('Ctrl 点击未选中项 → 加入并成为主选', () => {
    const r = applyMultiSelect(S(['a'], 'a'), 'c', order, {ctrl: true})
    expect([...r.selected].sort()).toEqual(['a', 'c'])
    expect(r.anchor).toBe('c')
    expect(r.main).toBe('c')
  })

  it('Ctrl 取消主选 → main 回退到 anchor（anchor 仍在集合内）', () => {
    const r = applyMultiSelect(S(['a', 'c'], 'c'), 'c', order, {ctrl: true})
    expect([...r.selected]).toEqual(['a'])
    expect(r.main).toBe('a')
  })

  it('Ctrl 取消唯一选中项 → main 为 null', () => {
    const r = applyMultiSelect(S(['c'], 'c'), 'c', order, {ctrl: true})
    expect([...r.selected]).toEqual([])
    expect(r.main).toBeNull()
  })

  it('Shift 从 anchor 取闭区间，anchor 不变，main 为点击项', () => {
    const r = applyMultiSelect(S(['b'], 'b'), 'e', order, {shift: true})
    expect([...r.selected].sort()).toEqual(['b', 'c', 'd', 'e'])
    expect(r.anchor).toBe('b')
    expect(r.main).toBe('e')
  })

  it('Shift 反向区间同样成立', () => {
    const r = applyMultiSelect(S(['d'], 'd'), 'a', order, {shift: true})
    expect([...r.selected].sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('Shift 无 anchor → 回退为普通替换', () => {
    const r = applyMultiSelect(S([], null), 'c', order, {shift: true})
    expect([...r.selected]).toEqual(['c'])
    expect(r.anchor).toBe('c')
  })

  it('Shift 但 anchor 不在 order 中 → 回退为普通替换', () => {
    const r = applyMultiSelect(S(['x'], 'x'), 'c', order, {shift: true})
    expect([...r.selected]).toEqual(['c'])
  })
})
