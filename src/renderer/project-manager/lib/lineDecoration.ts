import {StateEffect, StateField} from '@codemirror/state'
import {Decoration, EditorView} from '@codemirror/view'

/**
 * 按行选中的「整行背景」视觉层（IDEA 风格）。
 *
 * 为什么需要它：选中**空行**时选区 range 折叠（from === to），CodeMirror 不绘制选区背景，
 * 用户看「点了没反应」；且字符级选区背景只有文本那么宽，不像 IDEA 的整行高亮。
 * 这里用 `Decoration.line()` 给选中行打整行背景：空行同样可见，且铺满整行宽度。
 *
 * 职责边界：**装饰只负责视觉**，语义事实源始终是 `EditorSelection`（由 LineSelectionController
 * 派发）。两者通过同一次事务一起下发（见 lib/lineSelection.ts 的 createEffects）。
 */
export const setSelectedLines = StateEffect.define<number[]>()

const selectedLinesField = StateField.define<number[]>({
  create: () => [],
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setSelectedLines)) return effect.value
    return value
  },
})

const selectedLineDecoration = Decoration.line({class: 'cm-line-selected'})

/** 选中行的整行装饰。行号按升序折算成 Position，满足 Decoration.set 的有序要求。 */
export const lineSelectionDecorations = [
  // 字段必须随扩展一起启用：`decorations.compute([field])` 只声明依赖顺序，不会自动把字段加进 state
  selectedLinesField,
  EditorView.decorations.compute([selectedLinesField], state => {
    const lines = [...state.field(selectedLinesField)].sort((a, b) => a - b)
    const ranges = lines.map(n => selectedLineDecoration.range(state.doc.line(n).from))
    return Decoration.set(ranges, true)
  }),
]
