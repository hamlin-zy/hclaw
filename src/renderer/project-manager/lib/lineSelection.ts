/**
 * 按行选中（IDEA 风格）交互控制器。
 *
 * 与 CodeMirror 解耦：控制器只依赖一个最小视图接口（posAtCoords / state.doc / dispatch），
 * 选区以「行号集合」为唯一事实源，再折算成 CodeMirror 的多个 SelectionRange。
 * 这样做的原因：CodeMirror 自身的字符/词级选区语义与产品要求的整行语义冲突，
 * 必须完全接管鼠标/键盘入口，同时保留可单测的纯逻辑。
 *
 * 契约（与 DiffViewer 的行选中语义一致）：
 * - 单击 → 选中该行（替换）
 * - 拖动 → 起点行到当前行连续扩选（替换）
 * - Ctrl/Cmd + 单击 → 切换单行（支持非连续多行）
 * - Shift + 单击 → 锚点行到目标行的区间选（替换）
 * - 双击 → 仍按整行处理，不产生词级选区
 * - Ctrl/Cmd+A → 全选；Esc → 清除；Ctrl/Cmd+C → 复制所选行原文（\n 连接）
 *
 * **键盘接管的落点差异（勿互换）**：
 * - CodeEditor 走 `EditorView.domEventHandlers`，监听器挂在 **contentDOM** 上，因此必须保证
 *   contentDOM 可聚焦（`EditorView.contentAttributes.of({tabindex: '0'})` + 接管 mousedown 命中后
 *   `view.focus()`）；否则 `editable=false` 下 contentDOM 无 tabindex、点击后焦点留在 body，
 *   键盘事件根本到不了这里（实测 Ctrl+C / Ctrl+A / Esc 全部失效）。
 * - DiffViewer 是纯 DOM 组件、无 contenteditable，键盘走 **document 级** keydown 监听，本就可用。
 *   两者只是「事件挂在哪个元素上」不同，语义（按行选中）保持一致。
 */

/** 一行的文档信息（CodeMirror `Line` 的结构子集） */
export interface LineInfo {
  from: number
  to: number
  number: number
  text: string
}

/** 文档的最小接口（CodeMirror `Text` 的结构子集） */
export interface LineDoc {
  lines: number
  line(n: number): LineInfo
  lineAt(pos: number): LineInfo
}

/** 视图的最小接口（CodeMirror `EditorView` 的结构子集） */
export interface LineSelectionView {
  state: {doc: LineDoc}
  posAtCoords(coords: {x: number, y: number}): number | null
  dispatch(spec: unknown): void
  /** 聚焦内容区（真实 EditorView 的 contentDOM 已补 tabindex；测试桩可省略） */
  focus?(): void
}

/** 把若干文档区间折算成 CodeMirror 选区（由调用方注入，避免 lib 依赖 @codemirror/state） */
export type SelectionFactory = (ranges: {from: number, to: number}[]) => unknown

export interface ClipboardLike {
  writeText(text: string): Promise<void> | void
}

export interface LineSelectionOptions {
  createSelection: SelectionFactory
  /**
   * 额外的 dispatch 载荷（如行级装饰的 StateEffect）——由调用方注入，lib 不依赖 @codemirror。
   * 与 selection 同一次事务派发，避免视觉与语义分两帧。
   */
  createEffects?: (lines: number[]) => unknown
  /** 挂拖动监听的 document（默认取全局 document；测试可注入） */
  ownerDocument?: Document
  /** 剪贴板实现（默认 navigator.clipboard；环境不支持时静默容错） */
  clipboard?: ClipboardLike
  /** 选区变化外发（null 表示无选区）；行号升序，空数组不外发 */
  onChange?: (sel: {lineNumbers: number[]} | null) => void
}

/**
 * 把文本写入系统剪贴板。环境不支持 / 权限被拒时 `console.warn` 一次并静默容错，
 * 不抛出中断编辑器交互；但也**不静默吞掉**，排查时至少能看到一条线索。
 */
export function writeClipboard(text: string, clipboard?: ClipboardLike): void {
  const impl = clipboard
    ?? (typeof navigator !== 'undefined' ? (navigator as Navigator & {clipboard?: ClipboardLike}).clipboard : undefined)
  try {
    const result = impl?.writeText?.(text)
    if (result && typeof result.catch === 'function') {
      result.catch((err: unknown) => console.warn('[lineSelection] 写入剪贴板失败:', err))
    }
  } catch (err) {
    console.warn('[lineSelection] 剪贴板不可用:', err)
  }
}

/** 生成 [a, b] 闭区间内的全部行号（升序） */
export function rangeLines(a: number, b: number): number[] {
  const lo = Math.min(a, b)
  const hi = Math.max(a, b)
  const out: number[] = []
  for (let i = lo; i <= hi; i++) out.push(i)
  return out
}

/** 切换单行的选中态（加选/减选），返回升序行号 */
export function toggleLine(lines: number[], line: number): number[] {
  const set = new Set(lines)
  if (set.has(line)) set.delete(line)
  else set.add(line)
  return [...set].sort((a, b) => a - b)
}

/**
 * 行号集合 → 文档区间。**相邻行合并为一个区间**（CodeMirror 要求区间不重叠，
 * 合并也顺便减少选区数量）；非连续行各自成区间，配合 allowMultipleSelections 渲染多个高亮块。
 */
export function mergeRanges(doc: LineDoc, lines: number[]): {from: number, to: number}[] {
  const sorted = [...lines].sort((a, b) => a - b)
  const ranges: {from: number, to: number}[] = []
  for (const n of sorted) {
    const line = doc.line(n)
    const last = ranges[ranges.length - 1]
    // 相邻行的 from 恰好等于上一行 to + 1（中间夹着换行符）→ 用 +1 判定"相邻"并合并
    if (last && line.from <= last.to + 1) last.to = Math.max(last.to, line.to)
    else ranges.push({from: line.from, to: line.to})
  }
  return ranges
}

/** 所选行的原文：按行序、`\n` 连接、不含行号（非连续行之间不补空行） */
export function selectionText(doc: LineDoc, lines: number[]): string {
  return [...lines].sort((a, b) => a - b).map(n => doc.line(n).text).join('\n')
}

/**
 * 事件控制器。方法签名刻意与 CodeMirror `domEventHandlers` 的 `(event, view) => boolean`
 * 对齐，返回 `true` 表示已接管、阻止编辑器自身的选区处理。
 */
export class LineSelectionController {
  private readonly opts: LineSelectionOptions
  private view: LineSelectionView | null = null
  /** 已选行号（升序，唯一事实源） */
  private selected: number[] = []
  /** Shift 区间的锚点行 */
  private anchorLine: number | null = null
  /** 拖动起点行 */
  private dragStartLine: number | null = null
  private dragging = false
  private dragMove: ((e: MouseEvent) => void) | null = null
  private dragUp: (() => void) | null = null

  constructor(opts: LineSelectionOptions) {
    this.opts = opts
  }

  private get doc(): LineDoc | null {
    return this.view ? this.view.state.doc : null
  }

  private get ownerDocument(): Document | null {
    if (this.opts.ownerDocument) return this.opts.ownerDocument
    return typeof document !== 'undefined' ? document : null
  }

  /** 把当前行号集合派发成编辑器选区（并附带外部注入的行装饰 effect） */
  private apply(): void {
    const doc = this.doc
    if (!doc || !this.view) return
    const ranges = mergeRanges(doc, this.selected)
    const spec: Record<string, unknown> = {
      // 空选区 → 折叠光标：CodeMirror 不允许空区间数组（EditorSelection.create 会抛 RangeError）
      selection: this.opts.createSelection(ranges.length ? ranges : []),
    }
    // 行级视觉装饰由外部注入（StateEffect）：装饰只负责「空行也可视 / 铺满整行宽」的视觉，
    // 语义事实源始终是 EditorSelection，lib 不依赖 @codemirror。
    const effects = this.opts.createEffects?.(this.selected)
    if (effects !== undefined) spec.effects = effects
    this.view.dispatch(spec)
    this.opts.onChange?.(this.selected.length ? {lineNumbers: [...this.selected]} : null)
  }

  private lineAtPos(pos: number | null): number | null {
    const doc = this.doc
    if (doc === null || pos === null || pos === undefined) return null
    return doc.lineAt(pos).number
  }

  mousedown = (event: MouseEvent, view: LineSelectionView): boolean => {
    if (event.button !== 0) return false
    this.view = view
    const line = this.lineAtPos(view.posAtCoords({x: event.clientX, y: event.clientY}))
    if (line === null) return false
    // contentDOM 的 tabindex 使其可聚焦：键盘监听器挂在 contentDOM 上，
    // 不聚焦的话点击后焦点留在 body，Ctrl+C/A、Esc 永远送不到 keydown 处理器。
    view.focus?.()
    const mod = event.ctrlKey || event.metaKey
    if (mod) {
      this.selected = toggleLine(this.selected, line)
      this.anchorLine = line
      this.apply()
      return true
    }
    if (event.shiftKey && this.anchorLine !== null) {
      this.selected = rangeLines(this.anchorLine, line)
      this.apply()
      return true
    }
    this.selected = [line]
    this.anchorLine = line
    this.startDrag(line)
    this.apply()
    return true
  }

  /** 当前已选行号（升序副本） */
  getSelected(): number[] {
    return [...this.selected]
  }

  /** 双击必须仍按整行处理：返回 true 阻止 CodeMirror 的词级选区 */
  dblclick = (event: MouseEvent, view: LineSelectionView): boolean => {
    this.view = view
    const line = this.lineAtPos(view.posAtCoords({x: event.clientX, y: event.clientY}))
    if (line !== null) {
      this.selected = [line]
      this.anchorLine = line
      this.apply()
    }
    // 即使无法定位（无布局）也要吞掉事件，避免回落到词级选区
    return true
  }

  keydown = (event: KeyboardEvent, view: LineSelectionView): boolean => {
    this.view = view
    const mod = event.ctrlKey || event.metaKey
    if (mod && (event.key === 'a' || event.key === 'A')) {
      const doc = this.doc
      if (doc) {
        this.selected = rangeLines(1, doc.lines)
        this.anchorLine = 1
        this.apply()
      }
      event.preventDefault?.()
      return true
    }
    if (event.key === 'Escape') {
      // 无选区时放行：让 @codemirror/search 的 closeSearchPanel（search-panel scope）接手，
      // 否则焦点位于编辑器时搜索面板永远关不掉（本控制器用 Prec.highest，会先于它执行）。
      if (this.selected.length === 0) return false
      this.selected = []
      // Esc 一并清锚点：语义与 DiffViewer 对齐，之后 Shift+单击从新位置重锚。
      this.anchorLine = null
      this.apply()
      return true
    }
    if (mod && (event.key === 'c' || event.key === 'C')) {
      // 无选区时放行：编辑器里可能仍有原生选区（Alt-l selectLine、Shift+方向键等路径未被接管），
      // 无条件 preventDefault 会让用户看着原生高亮却复制不了。
      if (this.selected.length === 0) return false
      this.copy()
      event.preventDefault?.()
      return true
    }
    return false
  }

  private copy(): void {
    const doc = this.doc
    if (!doc || this.selected.length === 0) return
    writeClipboard(selectionText(doc, this.selected), this.opts.clipboard)
  }

  private startDrag(startLine: number): void {
    const doc = this.ownerDocument
    if (!doc || this.dragging) return
    this.dragging = true
    this.dragStartLine = startLine
    this.dragMove = (e: MouseEvent) => {
      if (!this.view) return
      const line = this.lineAtPos(this.view.posAtCoords({x: e.clientX, y: e.clientY}))
      if (line === null || this.dragStartLine === null) return
      this.selected = rangeLines(this.dragStartLine, line)
      this.apply()
    }
    this.dragUp = () => this.stopDrag()
    doc.addEventListener('mousemove', this.dragMove)
    doc.addEventListener('mouseup', this.dragUp)
  }

  private stopDrag(): void {
    const doc = this.ownerDocument
    if (doc && this.dragMove) doc.removeEventListener('mousemove', this.dragMove)
    if (doc && this.dragUp) doc.removeEventListener('mouseup', this.dragUp)
    this.dragMove = null
    this.dragUp = null
    this.dragStartLine = null
    this.dragging = false
  }

  /** 卸载时注销所有 document 监听并清空状态（本仓库对监听器泄漏有严格审查） */
  destroy(): void {
    this.stopDrag()
    // 清干净可控状态：避免复用同一控制器实例时残留旧选区 / 陈旧锚点
    this.selected = []
    this.anchorLine = null
    this.view = null
    // 外发 null：编辑器重建 / 卸载时上一次选区必须失效，否则父级会拿着陈旧行号
    this.opts.onChange?.(null)
  }
}
