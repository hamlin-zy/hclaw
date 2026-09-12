// @vitest-environment jsdom
import {describe, it, expect} from 'vitest'
import {EditorState} from '@codemirror/state'
import {EditorView} from '@codemirror/view'
import {lineSelectionDecorations, setSelectedLines} from '../../../src/renderer/project-manager/lib/lineDecoration'

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
