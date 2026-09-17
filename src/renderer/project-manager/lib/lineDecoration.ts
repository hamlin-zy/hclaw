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

/**
 * 「定位到某一行」的整行高亮（工单 06）——与按行选中**完全独立的第二条通道**。
 *
 * 为什么另起一套：定位高亮是**瞬时的**（1.5s 后硬清除）且由编辑器外部发起，
 * 选中行是**持续的**且由用户操作驱动。共用一套字段 / 装饰类时，任一方变化都会重算
 * （并可能清掉）另一方，于是出现「定位把用户选中的行抹了」这类串味。
 * 这里用独立的 StateEffect + StateField + 装饰类，两者的字段互不写入，可同时命中同一行。
 *
 * 值语义：`number` = 正在点亮的行号；`null` = 无高亮。清除就是派发 `setLocatedLine.of(null)`。
 */
export const setLocatedLine = StateEffect.define<number | null>()

const locatedLineField = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setLocatedLine)) return effect.value
    return value
  },
})

const locatedLineDecoration = Decoration.line({class: 'cm-line-located'})

/** 定位行的整行装饰。行号越界（文档变短）时静默跳过，不抛错——高亮只是视觉，不该中断交互。 */
export const locateLineDecorations = [
  locatedLineField,
  EditorView.decorations.compute([locatedLineField], state => {
    const line = state.field(locatedLineField)
    if (line === null || line < 1 || line > state.doc.lines) return Decoration.set([])
    return Decoration.set([locatedLineDecoration.range(state.doc.line(line).from)])
  }),
]
