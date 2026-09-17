// @vitest-environment jsdom
import {describe, it, expect} from 'vitest'
import {EditorState} from '@codemirror/state'
import {EditorView} from '@codemirror/view'
import {lineSelectionDecorations, locateLineDecorations, setLocatedLine, setSelectedLines} from '../../../src/renderer/project-manager/lib/lineDecoration'

/**
 * 行级选中装饰（lib/lineDecoration.ts）的**真实验证**（不 mock CodeMirror）：
 * 选中空行时选区 range 折叠、CodeMirror 不绘制选区背景，因此必须靠 `Decoration.line`
 * 打整行背景——这里断言「空行被选中也会产生行装饰」，这正是 jsdom 能证明、实机才需要
 * 复核可聚焦性的部分（装饰计算是纯 state 逻辑，与布局无关）。
 */
function decoratedLines(state: EditorState): number[] {
  const sets = state.facet(EditorView.decorations)
  const lines: number[] = []
  for (const set of sets) {
    if (typeof set === 'function') continue
    const iter = set.iter()
    while (iter.value) {
      lines.push(state.doc.lineAt(iter.from).number)
      iter.next()
    }
  }
  return lines.sort((a, b) => a - b)
}

const makeState = (doc: string) => EditorState.create({doc, extensions: [lineSelectionDecorations]})

describe('按行选中的整行装饰', () => {
  it('默认（未派发选中）无任何行装饰', () => {
    expect(decoratedLines(makeState('aa\nbbb\ncccc'))).toEqual([])
  })

  it('派发选中行 → 对应行被打上行装饰', () => {
    const tr = makeState('aa\nbbb\ncccc').update({effects: setSelectedLines.of([1, 3])})
    expect(decoratedLines(tr.state)).toEqual([1, 3])
  })

  it('选中空行同样产生行装饰（闭合选区无背景的病灶）', () => {
    const tr = makeState('aa\n\ncccc').update({effects: setSelectedLines.of([2])})
    expect(decoratedLines(tr.state)).toEqual([2])
  })

  it('清空选中（effects 传空数组）→ 装饰随之清空', () => {
    const tr = makeState('aa\nbbb\ncccc')
      .update({effects: setSelectedLines.of([1, 2])})
      .state
      .update({effects: setSelectedLines.of([])})
    expect(decoratedLines(tr.state)).toEqual([])
  })
})

/**
 * 定位高亮（工单 06）：与选中行**两条独立通道**。
 * 用装饰类的不同（`.cm-line-selected` / `.cm-line-located`）把两条通道分开断言——
 * 「互不干扰」是外部可观察的结果，不需要知道内部字段怎么存。
 */
function linesWithClass(state: EditorState, className: string): number[] {
  const lines: number[] = []
  for (const set of state.facet(EditorView.decorations)) {
    if (typeof set === 'function') continue
    const iter = set.iter()
    while (iter.value) {
      if ((iter.value.spec as {class?: string}).class === className) {
        lines.push(state.doc.lineAt(iter.from).number)
      }
      iter.next()
    }
  }
  return lines.sort((a, b) => a - b)
}

const SELECTED = 'cm-line-selected'
const LOCATED = 'cm-line-located'
const makeBothState = (doc: string) =>
  EditorState.create({doc, extensions: [...lineSelectionDecorations, ...locateLineDecorations]})

describe('定位高亮的整行装饰（与选中行互不干扰）', () => {
  it('默认无定位装饰', () => {
    expect(linesWithClass(makeBothState('aa\nbbb\ncccc'), LOCATED)).toEqual([])
  })

  it('派发定位行 → 该行被打上 .cm-line-located', () => {
    const tr = makeBothState('aa\nbbb\ncccc').update({effects: setLocatedLine.of(3)})
    expect(linesWithClass(tr.state, LOCATED)).toEqual([3])
  })

  it('派发 null → 定位装饰清空', () => {
    const tr = makeBothState('aa\nbbb\ncccc')
      .update({effects: setLocatedLine.of(2)})
      .state
      .update({effects: setLocatedLine.of(null)})
    expect(linesWithClass(tr.state, LOCATED)).toEqual([])
  })

  it('两条通道可同时命中同一行（不互相覆盖）', () => {
    const tr = makeBothState('aa\nbbb\ncccc')
      .update({effects: setSelectedLines.of([2])})
      .state
      .update({effects: setLocatedLine.of(2)})
    expect(linesWithClass(tr.state, SELECTED)).toEqual([2])
    expect(linesWithClass(tr.state, LOCATED)).toEqual([2])
  })

  it('任一通道变化都不清除另一条通道', () => {
    const base = makeBothState('aa\nbbb\ncccc')
      .update({effects: setSelectedLines.of([1])})
      .state
      .update({effects: setLocatedLine.of(3)})
      .state
    expect(linesWithClass(base, SELECTED)).toEqual([1])
    expect(linesWithClass(base, LOCATED)).toEqual([3])

    // 清定位 → 选中仍在
    const clearedLocate = base.update({effects: setLocatedLine.of(null)}).state
    expect(linesWithClass(clearedLocate, SELECTED)).toEqual([1])
    expect(linesWithClass(clearedLocate, LOCATED)).toEqual([])

    // 再定位 → 选中仍在（清选中的方向同理：见上一条用例）
    const reLocated = clearedLocate.update({effects: setLocatedLine.of(2)}).state
    expect(linesWithClass(reLocated, SELECTED)).toEqual([1])
    expect(linesWithClass(reLocated, LOCATED)).toEqual([2])

    const clearedSelection = reLocated.update({effects: setSelectedLines.of([])}).state
    expect(linesWithClass(clearedSelection, LOCATED)).toEqual([2])
    expect(linesWithClass(clearedSelection, SELECTED)).toEqual([])
  })

  it('行号越界（文档变短）时静默跳过，不抛错也不产生装饰', () => {
    const tr = makeBothState('aa\nbbb').update({effects: setLocatedLine.of(99)})
    expect(linesWithClass(tr.state, LOCATED)).toEqual([])
  })
})
