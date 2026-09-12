import {useEffect, useRef} from 'react'
import {EditorSelection, EditorState, Prec} from '@codemirror/state'
import {EditorView, highlightActiveLine, keymap} from '@codemirror/view'
import {defaultKeymap} from '@codemirror/commands'
import {search, searchKeymap} from '@codemirror/search'
import {HighlightStyle, syntaxHighlighting} from '@codemirror/language'
import {tags as t} from '@lezer/highlight'
import {vim} from '@replit/codemirror-vim'
import {LineSelectionController} from '../lib/lineSelection'
import {lineSelectionDecorations, setSelectedLines} from '../lib/lineDecoration'

/** 等宽字体栈（无对应主题令牌，四主题通用） */
const MONO_FONT = 'ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, "Courier New", monospace'

/**
 * CodeMirror 内置搜索面板短语中文化。
 * @codemirror/search 的面板文案经 `EditorState.phrase(key)` 读取，键与源码中
 * `phrase(view, "...")` 的实参一一对应（Find / Replace / next / previous / all /
 * match case / regexp / by word / replace / replace all / close / go / Go to line …）。
 * 挂在 EditorState.phrases facet 上，覆盖内置英文面板。
 */
export const SEARCH_PHRASES: Record<string, string> = {
  Find: '查找',
  Replace: '替换',
  next: '下一个',
  previous: '上一个',
  all: '全部',
  select: '选择',
  'match case': '区分大小写',
  regexp: '正则',
  'by word': '全词',
  'whole word': '全词',
  replace: '替换',
  'replace all': '全部替换',
  close: '关闭',
  go: '跳转',
  'Go to line': '跳转到行',
  'current match': '当前匹配',
  'on line': '位于行',
  'replaced match on line $': '已替换第 $ 行的匹配',
  'replaced $ matches': '已替换 $ 处匹配',
}

/**
 * 令牌化语法着色（spec §11.1）。
 * 颜色全部走 CSS 变量 → 切换主题无需重建 EditorState，CodeMirror 自动应用新值。
 * 注：`tags` 不在 `@codemirror/language` 导出，来自 `@lezer/highlight`。
 */
export const themedHighlight = HighlightStyle.define([
  {tag: t.keyword, color: 'var(--code-keyword)'},
  {tag: [t.string, t.special(t.string)], color: 'var(--code-string)'},
  {tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--code-comment)', fontStyle: 'italic'},
  {tag: [t.number, t.bool, t.null], color: 'var(--code-number)'},
  {tag: [t.typeName, t.className, t.namespace], color: 'var(--code-type)'},
  {tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--code-function)'},
  {tag: [t.propertyName, t.variableName, t.definition(t.variableName)], color: 'var(--code-ident)'},
  {tag: [t.operator, t.punctuation, t.bracket], color: 'var(--code-punct)'},
])

/**
 * 深色主题覆盖（spec §11.2/§11.3）。
 * base theme 用 `&light .cm-gutters`（特异度 (0,2,0)），因此所有覆盖 base 的规则都带 `&` 自我
 * 限定写成 `&.cm-editor …`（升到 (0,3,0)），靠特异度确定性取胜，而不是赌注入顺序。
 */
const themedTheme = EditorView.theme({
  '&': {
    backgroundColor: 'transparent',
    color: 'var(--text-primary)',
    fontFamily: MONO_FONT,
    fontSize: '12px',
  },
  '&.cm-editor .cm-scroller': {fontFamily: 'inherit'},
  '&.cm-editor .cm-gutters': {
    backgroundColor: 'var(--code-gutter-bg)',
    color: 'var(--text-muted)',
    border: 'none',
    borderRight: '1px solid var(--border)',
  },
  '&.cm-editor .cm-lineNumbers .cm-gutterElement': {
    padding: '0 8px 0 4px',
    minWidth: '3ch',
    textAlign: 'right',
    fontVariantNumeric: 'tabular-nums',
  },
  '&.cm-editor .cm-activeLine': {backgroundColor: 'var(--code-current-line)'},
  '&.cm-editor .cm-activeLineGutter': {
    backgroundColor: 'var(--code-gutter-bg)',
    color: 'var(--text-primary)',
  },
  '&.cm-editor .cm-selectionBackground': {backgroundColor: 'var(--code-selection)'},
  // 与 base theme 的 focused 选区规则打平基础上再加一层自我限定，确保不回落到默认灰
  '&.cm-editor.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: 'var(--code-selection)',
  },
  '&.cm-editor .cm-cursor': {borderLeftColor: 'var(--text-primary)'},
  '&.cm-editor .cm-searchMatch': {backgroundColor: 'var(--code-match)'},
  '&.cm-editor .cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'var(--code-match)',
    outline: '1px solid var(--brand-primary)',
  },
  '&.cm-editor .cm-matchingBracket': {
    backgroundColor: 'var(--code-match)',
    outline: '1px solid var(--border)',
  },
  '&.cm-editor .cm-selectionMatch': {backgroundColor: 'var(--code-match)'},
  '&.cm-editor .cm-foldGutter .cm-gutterElement': {color: 'var(--text-muted)'},
  '&.cm-editor .cm-panels': {
    backgroundColor: 'var(--surface-elevated)',
    color: 'var(--text-primary)',
    borderTop: '1px solid var(--border)',
  },
  // 搜索面板默认 `{top: true}` → 走 .cm-panels-top，base theme 给的是浅色 #ddd 底边，深色下会露亮线
  '&.cm-editor .cm-panels-top': {borderBottomColor: 'var(--border)'},
  '&.cm-editor .cm-panel.cm-search': {
    backgroundColor: 'var(--surface-elevated)',
    color: 'var(--text-primary)',
  },
  '&.cm-editor .cm-panel.cm-search input, &.cm-editor .cm-panel.cm-search button': {
    backgroundColor: 'var(--surface-muted)',
    border: '1px solid var(--border)',
    color: 'var(--text-primary)',
  },
})

export function CodeEditor({content, path, forceVim, onSelectionChange}: {
  content: string
  path: string
  forceVim?: boolean
  onSelectionChange?: (sel: {lineNumbers: number[]} | null) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const controllerRef = useRef<LineSelectionController | null>(null)
  // 回调走 ref：若进 [content, path, forceVim] 依赖会因父级每帧新建函数而重建 EditorView
  const onSelectionChangeRef = useRef(onSelectionChange)
  onSelectionChangeRef.current = onSelectionChange

  useEffect(() => {
    if (!hostRef.current) return
    let cancelled = false
    void (async () => {
      const {basicSetup} = await import('codemirror')
      // 新版 @codemirror/view 将 lineWrapping 移为 EditorView 静态属性
      const lineWrapping = EditorView.lineWrapping
      const {getLanguageExtension} = await import('../lib/language')
      // 缩进参考线（spec §11.2）按计划授权降级为「不做」：需自写装饰 ViewPlugin，超出本 Task 预算。
      // 若后续补做，复用 globals.css 已备好的 .pm-indent-guide 规则。
      //
      // 按行选中（IDEA 风格）控制器：接管鼠标/键盘入口，把选区语义改成整行。
      // 用 Prec.highest 包裹：必须先于 basicSetup 内建 keymap 的 Mod-a（selectAll）
      // 与编辑器自身的 mousedown 选区处理运行，否则字符/词级选区会先被建立。
      const lineSelection = new LineSelectionController({
        createSelection: ranges => ranges.length
          ? EditorSelection.create(ranges.map(r => EditorSelection.range(r.from, r.to)))
          : EditorSelection.single(0),
        // 行级装饰：选中行集合以 StateEffect 与选区同事务派发（空行也可视，原因见 lib/lineDecoration.ts）
        createEffects: lines => setSelectedLines.of(lines),
        onChange: sel => onSelectionChangeRef.current?.(sel),
      })
      const extensions = [
        basicSetup,
        EditorView.editable.of(false),
        // contentDOM 可聚焦：editable=false 会让 @codemirror/view 把 contentDOM 设为
        // contenteditable="false" 且**不加 tabindex** → 元素不可聚焦 → 挂在 contentDOM 上的
        // domEventHandlers 收不到任何键盘事件（点击后焦点留在 body，Ctrl+C/A、Esc 全失效）。
        // 补 tabindex 后，@codemirror/view 内部「dom.tabIndex > -1」分支还会让 DOM 选区同步一并恢复。
        EditorView.contentAttributes.of({tabindex: '0'}),
        lineWrapping,
        highlightActiveLine(),
        themedTheme,
        // 非 fallback 样式 → 优先于 basicSetup 内建的 syntaxHighlighting(defaultHighlightStyle, {fallback: true})
        syntaxHighlighting(themedHighlight),
        search({top: true}),
        // 搜索面板短语中文化（覆盖 @codemirror/search 内置英文文案）
        EditorState.phrases.of(SEARCH_PHRASES),
        keymap.of([...searchKeymap, ...defaultKeymap]),
        ...(await getLanguageExtension(path)),
        // 按行选中的整行背景装饰（视觉层，语义仍由 EditorSelection 承担）
        lineSelectionDecorations,
        // vim 例外（forceVim 为真）：不安装按行选中接管，保留 vim 自身的视觉模式（Visual）能力。
        // 原因：vim 的 v/V/Ctrl-V 视觉模式与整行选区语义冲突，强行接管会破坏 vim 用户的预期；
        // 限制：vim 模式下没有 IDEA 式按行选中，鼠标回到 CodeMirror/vim 的默认行为。
        ...(forceVim ? [vim()] : [Prec.highest(EditorView.domEventHandlers({
          mousedown: (event, view) => lineSelection.mousedown(event, view),
          dblclick: (event, view) => lineSelection.dblclick(event, view),
          keydown: (event, view) => lineSelection.keydown(event, view),
        }))]),
      ]
      const state = EditorState.create({doc: content, extensions})
      const view = new EditorView({state, parent: hostRef.current!})
      // 竞态防护：异步加载期间组件已重渲染/卸载时，立即销毁避免泄漏
      if (cancelled) { view.destroy(); lineSelection.destroy(); return }
      viewRef.current = view
      controllerRef.current = lineSelection
    })()
    return () => {
      cancelled = true
      controllerRef.current?.destroy()
      controllerRef.current = null
      viewRef.current?.destroy()
      viewRef.current = null
    }
  }, [content, path, forceVim])

  return <div ref={hostRef} className="pm-code-editor" />
}
