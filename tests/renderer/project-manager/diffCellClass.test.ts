import {describe, it, expect} from 'vitest'
import {
  CELL_ADDED,
  CELL_BLANK,
  CELL_REMOVED,
  inlineCellClass,
  sbsCellClass,
} from '../../../src/renderer/project-manager/lib/diffCellClass'
import type {DiffRowLike} from '../../../src/renderer/project-manager/lib/diffCellClass'

/**
 * 行修饰类的真值表（锁的是重构前的现状，重构后必须逐字符不变）。
 * 断言一律用 toBe 精确相等：`''` 不能被写成 undefined，前导空格不能被吞。
 */
describe('diffCellClass', () => {
  describe('修饰类字面量', () => {
    it('前导空格是类名拼接的一部分，不能丢', () => {
      expect(CELL_ADDED).toBe(' is-added')
      expect(CELL_REMOVED).toBe(' is-removed')
      expect(CELL_BLANK).toBe(' is-blank')
    })
  })

  describe('sbsCellClass — left（删/改侧）', () => {
    const left = (row: DiffRowLike) => sbsCellClass(row, 'left')

    it('本侧无内容（left === undefined）→ is-blank，与 kind 无关', () => {
      expect(left({kind: 'add', right: 'b'})).toBe(' is-blank')
      // 理论行（buildRows 不会产出，但纯函数须按规则判定）：change/context 缺左侧同样是空槽
      expect(left({kind: 'change', right: 'b'})).toBe(' is-blank')
      expect(left({kind: 'context', right: 'b'})).toBe(' is-blank')
    })

    it('kind=del 且有内容 → is-removed', () => {
      expect(left({kind: 'del', left: 'a'})).toBe(' is-removed')
    })

    it('kind=change 且两侧都有内容 → is-removed', () => {
      expect(left({kind: 'change', left: 'a', right: 'b'})).toBe(' is-removed')
    })

    it('kind=context → 中性（空字符串）', () => {
      expect(left({kind: 'context', left: 'a', right: 'a'})).toBe('')
    })

    it('kind=add 但左侧有内容 → 不加删除色（不对称点）', () => {
      expect(left({kind: 'add', left: 'a', right: 'b'})).toBe('')
    })
  })

  describe('sbsCellClass — right（增/改侧）', () => {
    const right = (row: DiffRowLike) => sbsCellClass(row, 'right')

    it('本侧无内容（right === undefined）→ is-blank，与 kind 无关', () => {
      expect(right({kind: 'del', left: 'a'})).toBe(' is-blank')
      expect(right({kind: 'change', left: 'a'})).toBe(' is-blank')
      expect(right({kind: 'context', left: 'a'})).toBe(' is-blank')
    })

    it('kind=add 且有内容 → is-added', () => {
      expect(right({kind: 'add', right: 'b'})).toBe(' is-added')
    })

    it('kind=change 且两侧都有内容 → is-added', () => {
      expect(right({kind: 'change', left: 'a', right: 'b'})).toBe(' is-added')
    })

    it('kind=context → 中性（空字符串）', () => {
      expect(right({kind: 'context', left: 'a', right: 'a'})).toBe('')
    })

    it('kind=del 但右侧有内容 → 不加新增色（不对称点）', () => {
      expect(right({kind: 'del', left: 'a', right: 'b'})).toBe('')
    })
  })

  describe('sbsCellClass — 左右不对称', () => {
    it('同一 change 行：左 is-removed、右 is-added', () => {
      const row: DiffRowLike = {kind: 'change', left: 'a', right: 'b'}
      expect(sbsCellClass(row, 'left')).toBe(' is-removed')
      expect(sbsCellClass(row, 'right')).toBe(' is-added')
    })

    it('del 行：左 is-removed、右 is-blank（空槽不是空字符串）', () => {
      const row: DiffRowLike = {kind: 'del', left: 'a'}
      expect(sbsCellClass(row, 'left')).toBe(' is-removed')
      expect(sbsCellClass(row, 'right')).toBe(' is-blank')
    })

    it('add 行：左 is-blank、右 is-added', () => {
      const row: DiffRowLike = {kind: 'add', right: 'b'}
      expect(sbsCellClass(row, 'left')).toBe(' is-blank')
      expect(sbsCellClass(row, 'right')).toBe(' is-added')
    })
  })

  describe('inlineCellClass', () => {
    it('add → is-added', () => {
      expect(inlineCellClass('add')).toBe(' is-added')
    })

    it('del → is-removed', () => {
      expect(inlineCellClass('del')).toBe(' is-removed')
    })

    it('context → 空字符串（inline 没有 is-blank）', () => {
      expect(inlineCellClass('context')).toBe('')
    })
  })
})
