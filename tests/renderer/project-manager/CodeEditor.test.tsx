// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {render} from '@testing-library/react'
import {EditorState} from '@codemirror/state'
import {syntaxHighlighting} from '@codemirror/language'
import {CodeEditor} from '../../../src/renderer/project-manager/components/CodeEditor'
import {
  LineSelectionController,
  mergeRanges,
  rangeLines,
  selectionText,
  toggleLine,
} from '../../../src/renderer/project-manager/lib/lineSelection'

// 记录 EditorView 创建/销毁次数，用于断言无泄漏视图
let created = 0
let destroyed = 0

// 手动控制动态 import('codemirror') 的 resolve 时机，以复现竞态
const gate = vi.hoisted(() => {
  let resolve!: (v: symbol) => void
  const basicSetup = new Promise<symbol>((r) => { resolve = r }).then((s) => s)
  return {basicSetup, resolve}
})

// basicSetup 内部自带的浅色默认着色源——实现里不得再显式声明它（spec §11.1 + 修正 1）
const sentinel = vi.hoisted(() => ({
  defaultHighlightStyle: {__sentinel: 'defaultHighlightStyle'},
}))

// 记录 domEventHandlers 调用，用于断言按行选中接管是否安装
const domHandlers = vi.hoisted(() => ({specs: [] as Array<Record<string, unknown>>}))

// 捕获 EditorView.theme 的入参规格：搜索面板的四主题接管是否到位只能从这里断言
// （真实 StyleModule 需要 CSSOM，jsdom 不做样式计算）
const themeSpecs = vi.hoisted(() => ({specs: [] as Array<Record<string, Record<string, unknown>>>}))

vi.mock('@codemirror/view', () => {
  class EditorView {
    static lineWrapping = Symbol('lineWrapping')
    static editable = {of: vi.fn((v: unknown) => v)}
    static theme = (spec: Record<string, Record<string, unknown>>) => { themeSpecs.specs.push(spec); return spec }
    // 按行选中接管：mock 成恒等并记录入参
    static domEventHandlers = (spec: Record<string, unknown>) => { domHandlers.specs.push(spec); return spec }
    // contentDOM 可聚焦性配置（P0）：记录入参供断言
    static contentAttributes = {of: vi.fn((v: unknown) => v)}
    // 行级装饰：compute 是配置入口，mock 成恒等（真实装饰计算在 Chromium 中生效）
    static decorations = {compute: vi.fn(() => ({}))}
    constructor(_opts: unknown) { created++ }
    // CodeEditor 会在视图上派发事务（定位高亮的设置/清除）：替身必须接受 dispatch，
    // 否则「控制器销毁 → onChange(null) → 清高亮」这条真实路径会因替身缺方法而炸。
    dispatch(_spec?: unknown) {}
    destroy() { destroyed++ }
  }
  return {
    EditorView,
    Decoration: {line: vi.fn((spec: unknown) => spec), set: vi.fn((ranges: unknown) => ranges)},
    keymap: {of: (v: unknown) => v},
    highlightActiveLine: () => ({}),
    highlightActiveLineGutter: () => ({}),
  }
})
vi.mock('@codemirror/state', () => ({
  EditorState: {
    create: vi.fn((cfg: unknown) => cfg),
    allowMultipleSelections: {of: (v: unknown) => v},
    phrases: {of: (v: unknown) => v},
  },
  EditorSelection: {
    create: (ranges: unknown) => ranges,
    range: (from: number, to: number) => ({from, to}),
    single: (pos: number) => ({from: pos, to: pos}),
  },
  Prec: {highest: (x: unknown) => x},
  // 行级装饰字段/效果（lib/lineDecoration.ts 用；mock 成恒等占位）
  StateField: {define: (spec: unknown) => spec},
  StateEffect: {define: () => ({of: (v: unknown) => v})},
}))
vi.mock('@codemirror/commands', () => ({defaultKeymap: []}))
vi.mock('@codemirror/search', () => ({search: () => ({}), searchKeymap: []}))
vi.mock('codemirror', () => ({basicSetup: gate.basicSetup}))
// 捕获 HighlightStyle.define 的入参规格，用于断言 tag→令牌 映射表真的存在（否则零覆盖）
const hs = vi.hoisted(() => ({specs: [] as unknown[][]}))
vi.mock('@codemirror/language', () => ({
  syntaxHighlighting: vi.fn(() => ({})),
  HighlightStyle: {define: (spec: unknown[]) => { hs.specs.push(spec); return {} }},
  bracketMatching: () => ({}),
  defaultHighlightStyle: sentinel.defaultHighlightStyle,
}))
// tags 的每个属性既当"tag 值"用，也被 `t.function(t.variableName)` / `t.special(...)` 当函数调用，
// 因此 mock 必须返回"可调用且自身可再被访问"的对象（纯字符串会在 apply 时抛 TypeError）。
vi.mock('@lezer/highlight', () => {
  const tag: unknown = new Proxy(function () {}, {get: () => tag, apply: () => tag})
  return {tags: new Proxy({}, {get: () => tag})}
})
vi.mock('../../../src/renderer/project-manager/lib/language', () => ({
  getLanguageExtension: async () => [],
}))

const createMock = EditorState.create as unknown as {mock: {calls: Array<[unknown]>}}
const shMock = syntaxHighlighting as unknown as {mock: {calls: unknown[][]}}

describe('CodeEditor 异步创建视图的销毁竞态', () => {
  beforeEach(() => {
    created = 0
    destroyed = 0
  })

  it('依赖在异步创建完成前变化时，过期视图被立即销毁且无泄漏', async () => {
    const {rerender, unmount} = render(<CodeEditor content="a" path="a.ts" />)
    // effect 已启动 IIFE 并挂起在 import('codemirror') 上，此时触发依赖变化
    await rerender(<CodeEditor content="b" path="a.ts" />)
    gate.resolve(Symbol('basicSetup'))
    // 等待两个 IIFE（过期的 + 当前的）完成
    await vi.waitFor(() => expect(created).toBe(2))
    expect(destroyed).toBe(1) // 过期视图已被 cancelled 分支销毁
    unmount()
    expect(destroyed).toBe(2) // 卸载后当前视图也被销毁，create === destroy
  })
})

describe('CodeEditor 主题化（spec §11）', () => {
  beforeEach(() => {
    created = 0
    destroyed = 0
    createMock.mock.calls.length = 0
    shMock.mock.calls.length = 0
    gate.resolve(Symbol('basicSetup'))
  })

  it('宿主元素带 pm-code-editor 类（样式规则落 globals.css，不走内联）', () => {
    const {container} = render(<CodeEditor content="a" path="a.ts" />)
    expect(container.querySelector('.pm-code-editor')).not.toBeNull()
  })

  it('语法着色不再吃 defaultHighlightStyle（浅色默认主题已弃用）', async () => {
    render(<CodeEditor content="a" path="a.ts" />)
    await vi.waitFor(() => expect(shMock.mock.calls.length).toBeGreaterThan(0))
    // 遍历全部 syntaxHighlighting 调用：任何一次都不得把浅色哨兵当作着色源
    // （只看最后一次调用是假绿：哨兵可能作为非末尾调用混进来）
    for (const call of shMock.mock.calls) {
      expect(call[0]).not.toBe(sentinel.defaultHighlightStyle)
    }
    expect(shMock.mock.calls.length).toBeGreaterThan(0)
  })

  it('Ctrl+F 搜索面板：接管 @codemirror 内置浅色默认值，且颜色全走令牌', () => {
    // CodeMirror 的 base theme 只按自身的 light/dark 判定给样式（本仓的 EditorView 未标 dark），
    // 于是四套主题下都会套上「浅色」那一档：.cm-button 的浅色 linear-gradient 底、
    // .cm-textfield 的 silver 描边 + 70% 字号、label 的 80% 字号、checkbox 的浏览器默认外观。
    // 这里把「一条默认值 → 一条接管规则」钉住，防止以后有人删掉其中一条。
    const panel = themeSpecs.specs[0]
    const keys = Object.keys(panel)
    expect(keys).toContain('&.cm-editor .cm-panel.cm-search')

    const field = keys.find(k => k.includes('cm-search') && k.includes('input:not([type=checkbox])'))
    expect(field, 'base theme 的 .cm-textfield / .cm-button 未被接管').toBeTruthy()
    expect(panel[field!]).toMatchObject({
      backgroundImage: 'none',   // 浅色渐变（深色主题下最刺眼的一处）
      borderRadius: '4px',       // base theme 是直角 / 1px 圆角
      fontSize: '12px',          // base theme 是 70%
      fontFamily: 'inherit',
    })
    expect(keys.some(k => k.includes('cm-search') && k.includes('input[type=checkbox]'))).toBe(true)
    expect(panel['&.cm-editor .cm-panel.cm-search [name=close]']).toBeTruthy()
    expect(panel['&.cm-editor .cm-panel.cm-search label']).toBeTruthy()

    // 控件轮廓单独一档（用户诉求 7）：面板挂在 --surface-elevated 上，而 --border 是按
    // --surface 校准的「结构分隔线」（深色族白 6%，在这块底上只有 1.08:1 亮度步长），
    // 于是按钮只剩一团填充、看上去「只有阴影没有边框」。谁把其中一条退回去，这个面板就会复发。
    for (const sel of [
      '&.cm-editor .cm-panel.cm-search input:not([type=checkbox])',
      '&.cm-editor .cm-panel.cm-search button',
      '&.cm-editor .cm-panel.cm-search label',
    ]) {
      expect(panel[sel]?.border, `${sel} 的轮廓档被打回 --border`).toBe('1px solid var(--border-emphasis)')
    }
    // hover 必须是**比静置更强**的另一档（混向 --text-primary），而不是同一个值
    expect(panel['&.cm-editor .cm-panel.cm-search button:hover'].borderColor).toMatch(/^color-mix\(/)
    expect(panel['&.cm-editor .cm-panel.cm-search label:hover'].borderColor).toMatch(/^color-mix\(/)
    // 关闭按钮是图标按钮：上面那条 button 规则会顺手把它套成描边方块，
    // 这条还原规则靠特异度 (0,5,0) 压过 button 的 (0,4,1)，不依赖插入顺序
    expect(panel['&.cm-editor .cm-panel.cm-search [name=close]']).toMatchObject({
      border: 'none',
      backgroundColor: 'transparent',
    })

    // 颜色一律走令牌 / color-mix：四主题里不得冒出写死的浅色
    const panelRules = keys
      .filter(k => k.includes('cm-panel') || k.includes('cm-search'))
      .map(k => JSON.stringify(panel[k]))
      .join(' ')
    expect(panelRules.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/g) ?? []).toEqual([])
  })

  it('themedHighlight 覆盖全部 8 个 --code-* 令牌（防拼写漂移）', () => {
    // describe 体在模块导入后即执行，themedHighlight 已在导入期完成 define
    const colors = (hs.specs.flat() as Array<{color?: string}>).map(s => s.color ?? '').join(' ')
    for (const token of [
      '--code-keyword', '--code-string', '--code-comment', '--code-number',
      '--code-type', '--code-function', '--code-ident', '--code-punct',
    ]) {
      expect(colors).toContain(token)
    }
  })

  // 编辑器只读不变量（spec §5 边界）：文案解禁后 editable=false 仍是硬约束。
  // 并入本块复用其 beforeEach（gate.resolve 只能 resolve 一次，另起 describe 的
  // beforeEach 会重复 resolve）。
  it('非 vim 模式安装按行选中接管（mousedown / dblclick / keydown）', async () => {
    domHandlers.specs.length = 0
    render(<CodeEditor content="a" path="a.ts" />)
    await vi.waitFor(() => expect(domHandlers.specs.length).toBeGreaterThan(0))
    const spec = domHandlers.specs[domHandlers.specs.length - 1]
    for (const type of ['mousedown', 'dblclick', 'keydown']) {
      expect(typeof spec[type]).toBe('function')
    }
  })

  it('vim 模式不安装接管（保留 vim 自身视觉模式，不产生字符级回退）', async () => {
    domHandlers.specs.length = 0
    created = 0
    render(<CodeEditor content="a" path="a.ts" forceVim />)
    await vi.waitFor(() => expect(created).toBeGreaterThan(0))
    expect(domHandlers.specs.length).toBe(0)
  })

  it('EditorView.editable.of(false) 被传入（编辑器仍只读）', async () => {
    const {EditorView} = await import('@codemirror/view')
    const spy = (EditorView as unknown as {editable: {of: {mock: {calls: unknown[][]}; mockClear: () => void}}}).editable.of
    spy.mockClear()
    render(<CodeEditor content="a" path="a.ts" />)
    await vi.waitFor(() => expect(spy.mock.calls.length).toBeGreaterThan(0))
    expect(spy.mock.calls.every(c => c[0] === false)).toBe(true)
  })

  // P0 回归护栏（配置层）：editable=false 会让 contentDOM 变 contenteditable="false" 且无 tabindex，
  // 元素不可聚焦 → domEventHandlers 挂在 contentDOM 上，键盘事件永远到不了 → 补 tabindex 才可聚焦。
  // ⚠️ jsdom 把 contenteditable=false 当作可聚焦，与 Chromium 行为不符，**无法**在此证明键盘
  // 真实可达；这里只断言「配置层面的事实」（contentAttributes 传入 tabindex=0），
  // 真实可达性由实机（Electron/Chromium）复验负责，不写假端到端用例。
  it('给 contentDOM 补可聚焦性：EditorView.contentAttributes 传入 tabindex=0', async () => {
    const {EditorView} = await import('@codemirror/view')
    const spy = (EditorView as unknown as {
      contentAttributes: {of: {mock: {calls: unknown[][]}; mockClear: () => void}}
    }).contentAttributes.of
    spy.mockClear()
    render(<CodeEditor content="a" path="a.ts" />)
    await vi.waitFor(() => expect(spy.mock.calls.length).toBeGreaterThan(0))
    expect(spy.mock.calls.some(c => (c[0] as {tabindex?: string} | undefined)?.tabindex === '0')).toBe(true)
  })
})

/** 构造一个带行信息的假文档（行号 1-based，位置为行首字符偏移） */
function makeDoc(lines: string[]) {
  const starts: number[] = []
  let off = 0
  for (const line of lines) {
    starts.push(off)
    off += line.length + 1
  }
  const doc = {
    lines: lines.length,
    line(n: number) {
      const i = n - 1
      return {from: starts[i], to: starts[i] + lines[i].length, number: n, text: lines[i]}
    },
    lineAt(pos: number) {
      let i = 0
      for (let k = 0; k < lines.length; k++) if (starts[k] <= pos) i = k
      return doc.line(i + 1)
    },
  }
  return doc
}

/** 构造假视图：posAtCoords 把 clientY 按 20px 行高映射到行首 */
function makeView(lines: string[]) {
  const doc = makeDoc(lines)
  const dispatched: unknown[] = []
  const view = {
    state: {doc},
    posAtCoords: ({y}: {x: number, y: number}) => {
      const idx = Math.max(0, Math.min(lines.length - 1, Math.floor(y / 20)))
      return doc.line(idx + 1).from
    },
    dispatch(spec: unknown) { dispatched.push(spec) },
  }
  return {view, dispatched, doc}
}

const identityFactory = (ranges: {from: number, to: number}[]) => ranges
/** 取最后一次 dispatch 的 selection 载荷 */
const lastSelection = (dispatched: unknown[]) =>
  (dispatched[dispatched.length - 1] as {selection: unknown}).selection

const mouse = (type: string, init: MouseEventInit) => new MouseEvent(type, {bubbles: true, ...init})
const key = (k: string, init: KeyboardEventInit = {}) => new KeyboardEvent('keydown', {key: k, cancelable: true, ...init})

describe('按行选中控制器（IDEA 风格语义）', () => {
  const LINES = ['aa', 'bbb', 'cccc']
  const makeController = (clipboard?: {writeText: (t: string) => void}) =>
    new LineSelectionController({createSelection: identityFactory, clipboard})

  it('单击选中整行（替换旧选区）', () => {
    const {view, dispatched, doc} = makeView(LINES)
    const c = makeController()
    expect(c.mousedown(mouse('mousedown', {button: 0, clientY: 0}), view)).toBe(true)
    expect(lastSelection(dispatched)).toEqual([{from: doc.line(1).from, to: doc.line(1).to}])
    // 再点第二行 → 选区被替换，而不是叠加
    c.mousedown(mouse('mousedown', {button: 0, clientY: 20}), view)
    expect(lastSelection(dispatched)).toEqual([{from: doc.line(2).from, to: doc.line(2).to}])
    c.destroy()
  })

  it('按住鼠标拖动 → 起点行到当前行连续扩选（替换）', () => {
    const {view, dispatched, doc} = makeView(LINES)
    const c = makeController()
    c.mousedown(mouse('mousedown', {button: 0, clientY: 0}), view)
    document.dispatchEvent(mouse('mousemove', {clientY: 40}))
    // 连续行合并成一个区间
    expect(lastSelection(dispatched)).toEqual([{from: doc.line(1).from, to: doc.line(3).to}])
    document.dispatchEvent(mouse('mouseup', {}))
    // 拖动结束后 mousemove 不再改变选区
    const before = dispatched.length
    document.dispatchEvent(mouse('mousemove', {clientY: 0}))
    expect(dispatched.length).toBe(before)
    c.destroy()
  })

  it('Ctrl/Cmd + 单击 → 切换单行（支持非连续跨行加选/减选）', () => {
    const {view, dispatched, doc} = makeView(LINES)
    const c = makeController()
    c.mousedown(mouse('mousedown', {button: 0, clientY: 0}), view)
    c.mousedown(mouse('mousedown', {button: 0, clientY: 40, ctrlKey: true}), view)
    expect(lastSelection(dispatched)).toEqual([
      {from: doc.line(1).from, to: doc.line(1).to},
      {from: doc.line(3).from, to: doc.line(3).to},
    ])
    // 再 Ctrl 点一次第三行 → 减选
    c.mousedown(mouse('mousedown', {button: 0, clientY: 40, metaKey: true}), view)
    expect(lastSelection(dispatched)).toEqual([{from: doc.line(1).from, to: doc.line(1).to}])
    c.destroy()
  })

  it('Shift + 单击 → 锚点行到目标行的区间选（替换）', () => {
    const {view, dispatched, doc} = makeView(LINES)
    const c = makeController()
    c.mousedown(mouse('mousedown', {button: 0, clientY: 0}), view)
    c.mousedown(mouse('mousedown', {button: 0, clientY: 20, shiftKey: true}), view)
    expect(lastSelection(dispatched)).toEqual([{from: doc.line(1).from, to: doc.line(2).to}])
    c.destroy()
  })

  it('双击仍按整行处理并吞掉事件（不产生词级选区）', () => {
    const {view, dispatched, doc} = makeView(LINES)
    const c = makeController()
    expect(c.dblclick(mouse('dblclick', {button: 0, clientY: 20}), view)).toBe(true)
    expect(lastSelection(dispatched)).toEqual([{from: doc.line(2).from, to: doc.line(2).to}])
    c.destroy()
  })

  it('Ctrl/Cmd+A 全选所有行、Esc 清除选区', () => {
    const {view, dispatched, doc} = makeView(LINES)
    const c = makeController()
    expect(c.keydown(key('a', {ctrlKey: true}), view)).toBe(true)
    expect(lastSelection(dispatched)).toEqual([{from: doc.line(1).from, to: doc.line(3).to}])
    expect(c.keydown(key('Escape'), view)).toBe(true)
    expect(lastSelection(dispatched)).toEqual([])
    c.destroy()
  })

  it('Ctrl/Cmd+C 把所选行原文写入剪贴板（按行序、\\n 连接、不含行号）', () => {
    const writeText = vi.fn()
    const {view} = makeView(LINES)
    const c = makeController({writeText})
    c.mousedown(mouse('mousedown', {button: 0, clientY: 0}), view)
    c.mousedown(mouse('mousedown', {button: 0, clientY: 40, ctrlKey: true}), view)
    expect(c.keydown(key('c', {ctrlKey: true}), view)).toBe(true)
    expect(writeText).toHaveBeenCalledWith('aa\ncccc')
    c.destroy()
  })

  it('剪贴板不可用时不抛错（容错）', () => {
    const {view} = makeView(LINES)
    const c = new LineSelectionController({createSelection: identityFactory})
    c.mousedown(mouse('mousedown', {button: 0, clientY: 0}), view)
    expect(() => c.keydown(key('c', {ctrlKey: true}), view)).not.toThrow()
    c.destroy()
  })

  it('纯函数：rangeLines / toggleLine / mergeRanges / selectionText', () => {
    expect(rangeLines(3, 1)).toEqual([1, 2, 3])
    expect(toggleLine([1, 3], 2)).toEqual([1, 2, 3])
    expect(toggleLine([1, 2, 3], 2)).toEqual([1, 3])
    const doc = makeDoc(['aa', 'bb', 'cc'])
    expect(mergeRanges(doc, [1, 2, 3])).toEqual([{from: 0, to: doc.line(3).to}])
    expect(mergeRanges(doc, [1, 3])).toEqual([
      {from: 0, to: 2},
      {from: 6, to: 8},
    ])
    expect(selectionText(doc, [3, 1])).toBe('aa\ncc')
  })
})

describe('LineSelectionController onChange / getSelected（spec §4.5）', () => {
  const LINES = ['aa', 'bbb', 'cccc']

  it('选中行时通过 onChange 派发行号快照', () => {
    const {view} = makeView(LINES)
    const seen: Array<{lineNumbers: number[]} | null> = []
    const c = new LineSelectionController({createSelection: identityFactory, onChange: s => seen.push(s)})
    c.mousedown(mouse('mousedown', {button: 0, clientY: 0}), view)
    expect(seen[seen.length - 1]).toEqual({lineNumbers: [1]})
    c.mousedown(mouse('mousedown', {button: 0, clientY: 40, shiftKey: true}), view)
    expect(seen[seen.length - 1]).toEqual({lineNumbers: [1, 2, 3]})
    c.destroy()
  })

  it('Esc 清空选区时派发 null', () => {
    const {view} = makeView(LINES)
    const seen: Array<{lineNumbers: number[]} | null> = []
    const c = new LineSelectionController({createSelection: identityFactory, onChange: s => seen.push(s)})
    c.mousedown(mouse('mousedown', {button: 0, clientY: 0}), view)
    c.keydown(key('Escape'), view)
    expect(seen[seen.length - 1]).toBeNull()
    c.destroy()
  })

  it('destroy() 派发 null 并清空 getSelected', () => {
    const {view} = makeView(LINES)
    const seen: Array<{lineNumbers: number[]} | null> = []
    const c = new LineSelectionController({createSelection: identityFactory, onChange: s => seen.push(s)})
    c.mousedown(mouse('mousedown', {button: 0, clientY: 0}), view)
    expect(c.getSelected()).toEqual([1])
    c.destroy()
    expect(seen[seen.length - 1]).toBeNull()
    expect(c.getSelected()).toEqual([])
  })
})

describe('CodeEditor onSelectionChange 接线（spec §6.2 B6：回调走 ref，不进重建依赖）', () => {
  beforeEach(() => {
    created = 0
    destroyed = 0
    gate.resolve(Symbol('basicSetup'))
  })

  it('回调换引用不重建 EditorView（父级每帧新建内联箭头也不重建）', async () => {
    const {rerender} = render(<CodeEditor content="a" path="a.ts" onSelectionChange={() => {}} />)
    await vi.waitFor(() => expect(created).toBe(1))
    // 换一个函数引用：若回调进了 effect 依赖，这里会 cleanup 旧视图 + 新建 → created 变 2
    rerender(<CodeEditor content="a" path="a.ts" onSelectionChange={() => {}} />)
    await new Promise(r => setTimeout(r, 0))
    expect(created).toBe(1)
    expect(destroyed).toBe(0)
  })
})
