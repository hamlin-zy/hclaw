import {useEffect, useImperativeHandle, useRef, type Ref} from 'react'
import {EditorSelection, EditorState, Prec} from '@codemirror/state'
import {EditorView, highlightActiveLine, keymap} from '@codemirror/view'
import {defaultKeymap} from '@codemirror/commands'
import {search, searchKeymap} from '@codemirror/search'
import {HighlightStyle, syntaxHighlighting} from '@codemirror/language'
import {tags as t} from '@lezer/highlight'
import {vim} from '@replit/codemirror-vim'
import {LineSelectionController} from '../lib/lineSelection'
import {lineSelectionDecorations, locateLineDecorations, setLocatedLine, setSelectedLines} from '../lib/lineDecoration'
import {clampLine, shouldClearLocateOnSelectionChange} from '../lib/locateHighlight'

/** 等宽字体栈（无对应主题令牌，四主题通用） */
const MONO_FONT = 'ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, "Courier New", monospace'

/**
 * CodeMirror 内置搜索面板短语中文化。
 * @codemirror/search 的面板文案经 `EditorState.phrase(key)` 读取，键与源码中
 * `phrase(view, "...")` 的实参一一对应（Find / Replace / next / previous / all /
 * match case / regexp / by word / replace / replace all / close / go / Go to line …）。
 * 挂在 EditorState.phrases facet 上，覆盖内置英文面板。
 */
const SEARCH_PHRASES: Record<string, string> = {
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
 * 搜索面板里文本域与按钮**共用**的几何档（12px 字号 / 24px 高 / 4px 圆角 / 固定内外边距）。
 * 抽成常量是因为这两条规则必须逐字一致——它们曾经共用一条选择器，后来为了分档轮廓拆开，
 * 拆开后任何一边改了字号/圆角都会变成肉眼可见的错位。
 */
const PANEL_CONTROL_GEOMETRY = {
  color: 'var(--text-primary)',
  // 清掉 `&light .cm-textfield` 的浅底与 `&light .cm-button` 的浅色 linear-gradient 底
  // （渐变残留会让深色主题里的按钮整片发白，是面板最刺眼的一处）
  backgroundImage: 'none',
  // base theme 给输入框/按钮的是 70% 字号 + 2px 直角描边；统一到面板这一档
  fontFamily: 'inherit',
  fontSize: '12px',
  borderRadius: '4px',
  height: '24px',
  padding: '0 6px',
  // base theme 的 `.2em .6em .2em 0`（相对 em）在 12px 下间距不等，改用固定像素
  margin: '2px 6px 2px 0',
  verticalAlign: 'middle',
} as const

/**
 * 面板控件的**轮廓**单独一档，不走 `--border`。
 *
 * `--border` 是按 `--surface` 底校准的「结构分隔线」（深色族=白 6%），把它放在面板的
 * `--surface-elevated` 上时只剩 1.08:1 的亮度步长——按钮的填充又和面板同族，
 * 视觉上就只剩用户原话的「一团阴影、没有边框」。控件轮廓改用 `--border-emphasis`：
 * 全局 checkbox（`1.5px solid var(--border-emphasis)`）用的就是这一档，语义即「控件要被看见」。
 *
 * 描边对面板底的实测对比度（`getComputedStyle` 取色、按 alpha 合成后算 WCAG 比值）：
 * 静置 emphasis = light 2.16 / dark 1.23 / yuanshandai 1.82 / shiyangjin 2.27；
 * 原 --border = 1.47 / 1.08 / 1.38 / 1.54。深色族仍是四主题最低的一档，
 * 但它与全局 checkbox 同源同值——要更强只能动 `--border-emphasis` 这个全局口径，
 * 不该在这一个面板里私自加码。
 *
 * hover 只往 `--text-primary` 靠 20%：`--text-primary` 不透明，权重一大就把
 * `--border-emphasis` 的 alpha 抬起来，描边会变成近乎实色的亮环（dark 实测 >3:1，
 * 等于给每个按钮套一圈白框），所以这里刻意留在低权重。
 */
const PANEL_CONTROL_BORDER = '1px solid var(--border-emphasis)'
const PANEL_CONTROL_BORDER_HOVER = 'color-mix(in srgb, var(--border-emphasis) 80%, var(--text-primary))'

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
    outline: '1px solid var(--focus-ring)',
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
  // 搜索面板默认 `{top: true}` → 走 .cm-panels-top，base theme 给的是浅色底边，深色下会露亮线
  '&.cm-editor .cm-panels-top': {borderBottomColor: 'var(--border)'},
  // ── Ctrl+F 内置搜索面板（@codemirror/search）──
  // 只覆盖 bg/border/color 不够：面板里每个控件的**其余属性**仍来自 @codemirror/view 与
  // @codemirror/search 的内置浅色 base theme（输入框的 silver 描边 + 70% 字号、按钮的浅色
  // linear-gradient 底、label 的 80% 字号、面板 2px/6px 的紧凑内边距……），在四套主题里都会露出来。
  // 下面按「一条默认样式的漏洞 → 一条接管规则」逐项补齐；颜色一律走令牌，四主题自动适配，
  // 深色无需单独降档（面板没有需要在深色下分辨的浅色渐变）。
  '&.cm-editor .cm-panel.cm-search': {
    backgroundColor: 'var(--surface-elevated)',
    color: 'var(--text-primary)',
    // base theme 的 `padding: 2px 6px 4px` 是按 80% 字号设计的，与编辑器 12px 字号不成比例
    padding: '4px 8px',
    fontSize: '12px',
    lineHeight: '1.5',
  },
  // 文本框与按钮**不共用一条规则**：几何同档（PANEL_CONTROL_GEOMETRY），轮廓分档。
  // 原先两者共用 `border: 1px solid var(--border)`，那条线在面板底上等于不存在（见
  // PANEL_CONTROL_BORDER 注释里的实测值），于是「下一个 / 全部替换」这些按钮看上去
  // 只有一块比面板略深的填充——即用户说的「一团阴影、没有边框」。轮廓档位提到
  // --border-emphasis 后，这一排控件才有能读出来的边。
  // 复选框单独放行到 globals.css 的全局自定义 checkbox（描边 1.5px + brand-primary 勾选态），
  // 故这里用 :not([type=checkbox]) 把它排除在「文本框/按钮」外观之外
  '&.cm-editor .cm-panel.cm-search input:not([type=checkbox])': {
    ...PANEL_CONTROL_GEOMETRY,
    backgroundColor: 'var(--surface-muted)',
    border: PANEL_CONTROL_BORDER,
  },
  '&.cm-editor .cm-panel.cm-search button': {
    ...PANEL_CONTROL_GEOMETRY,
    backgroundColor: 'var(--surface-muted)',
    border: PANEL_CONTROL_BORDER,
  },
  '&.cm-editor .cm-panel.cm-search .cm-textfield': {lineHeight: '22px'},
  // 浅色主题下 placeholder 落到浏览器默认灰（全局令牌化规则只覆盖深色主题）
  '&.cm-editor .cm-panel.cm-search input::placeholder': {color: 'var(--text-muted)'},
  '&.cm-editor .cm-panel.cm-search .cm-textfield:focus-visible': {
    outline: '1px solid var(--focus-ring)',
    outlineOffset: '1px',
  },
  // 区分大小写 / 正则 / 全词三个开关：与提交列表面板（GitLogPanel）的筛选条件**同形**——
  // 紧凑的 glyph chip（对齐 .pm-toggle-chip：20px 高 / 4px 圆角 / 1px 描边 / 11px 字号，
  // 激活态为品牌色浅底 + 品牌色字），而不是「浏览器复选框 + 长中文」。
  // 唯一与 .pm-toggle-chip 不同的是描边档位：chip 是**透明底**（形状全靠那圈线），而这一行
  // 落在浮层底（--surface-elevated）上、不是 --border 校准所依据的内容面，所以描边同样取
  // PANEL_CONTROL_BORDER——同排的按钮/输入框都是这一档，否则一行里会有一半控件没有边。
  // 复选框本体保留（语义与键盘可达性都在），仅视觉隐藏；glyph 由 CSS 生成，
  // 与 @codemirror/search 的短语表解耦（短语表仍供可访问名与读屏使用）。
  //
  // 注：CodeMirror 不给这三个 label 设 title，故没有提交列表面板那样的悬浮说明——
  // 这是纯 CSS 方案的边界（补 title 需要在面板 DOM 上挂观察者，收益不抵复杂度）。
  '&.cm-editor .cm-panel.cm-search input[type=checkbox]': {
    position: 'absolute',
    width: '0',
    height: '0',
    margin: '0',
    opacity: '0',
  },
  '&.cm-editor .cm-panel.cm-search label': {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '20px',
    padding: '0 6px',
    margin: '2px 6px 2px 0',
    background: 'transparent',
    border: PANEL_CONTROL_BORDER,
    borderRadius: '4px',
    // 藏掉短语表注入的中文（区分大小写 / 正则 / 全词）：只让 ::after 的 glyph 显形，
    // 读屏仍读得到 label 文本（这正是保留字面量、只压字号的原因）
    fontSize: '0',
    color: 'var(--text-secondary)',
    whiteSpace: 'pre',
    cursor: 'pointer',
    verticalAlign: 'middle',
  },
  '&.cm-editor .cm-panel.cm-search label::after': {fontSize: '11px'},
  '&.cm-editor .cm-panel.cm-search label:hover': {
    color: 'var(--text-primary)',
    borderColor: PANEL_CONTROL_BORDER_HOVER,
  },
  // 与提交列表面板逐字同源的三个 glyph（正则 / 区分大小写 / 全词）
  '&.cm-editor .cm-panel.cm-search label:has(input[name=re])::after': {content: '".*"'},
  '&.cm-editor .cm-panel.cm-search label:has(input[name=case])::after': {content: '"Aa"'},
  '&.cm-editor .cm-panel.cm-search label:has(input[name=word])::after': {content: '"全词"'},
  '&.cm-editor .cm-panel.cm-search label:has(input:checked)': {
    background: 'var(--brand-muted)',
    borderColor: 'var(--brand-border)',
    color: 'var(--brand-primary)',
    fontWeight: '600',
  },
  '&.cm-editor .cm-panel.cm-search label:has(input:focus-visible)': {
    outline: '2px solid var(--focus-ring)',
    outlineOffset: '1px',
  },
  // base theme 只给按钮的 :active 换一层渐变；渐变被清掉后必须补回自己的 hover/active 反馈。
  // 描边不再需要「静置→hover」跨档（静置已经是 --border-emphasis），hover 的提亮交给
  // PANEL_CONTROL_BORDER_HOVER 那一档 20% 的混合。
  '&.cm-editor .cm-panel.cm-search button:hover': {
    backgroundColor: 'color-mix(in srgb, var(--text-primary) 8%, var(--surface-muted))',
    borderColor: PANEL_CONTROL_BORDER_HOVER,
    color: 'var(--text-primary)',
  },
  '&.cm-editor .cm-panel.cm-search button:active': {
    backgroundColor: 'color-mix(in srgb, var(--text-primary) 14%, var(--surface-muted))',
  },
  // 关闭按钮（`[name=close]`，内容是一个 ×）：上面那条 button 规则会顺手把它套成描边方块，
  // 这里显式还原成图标按钮，尺寸/圆角对齐 .pm-icon-btn（20px / transparent / 4px 圆角）。
  // 压过 `button` 规则靠的是特异度而非顺序：本选择器多一个属性选择器，是 (0,5,0) 对 (0,4,1)，
  // 所以这条规则挪到前面也仍然生效
  '&.cm-editor .cm-panel.cm-search [name=close]': {
    position: 'absolute',
    top: '4px',
    right: '6px',
    width: '20px',
    height: '20px',
    padding: '0',
    margin: '0',
    backgroundColor: 'transparent',
    border: 'none',
    borderRadius: '4px',
    color: 'var(--text-muted)',
    fontSize: '14px',
    lineHeight: '1',
    cursor: 'pointer',
  },
  '&.cm-editor .cm-panel.cm-search [name=close]:hover': {
    backgroundColor: 'var(--surface-muted)',
    color: 'var(--text-primary)',
  },
})

/**
 * CodeEditor 的命令式句柄（工单 06）。
 *
 * 这是本组件**唯一**对外暴露的实例能力：`EditorView` 实例始终锁在组件内部，
 * 定位请求方（`EditorArea`）只能表达两个意图，拿不到视图也改不了编辑器状态。
 * 之所以需要它：定位的三件事（滚动居中、光标置行首、点亮高亮）都必须在同一个视图实例上做。
 */
export interface CodeEditorHandle {
  /**
   * 定位到某行：滚动使其居中、光标置该行行首，并点亮定位高亮。
   * `scroll: false` 用于「重复定位到同一行」——只重新点亮，视线不跳。
   * @returns 是否已应用到活着的视图；`false` = 视图尚未就绪，调用方应保持挂起、
   *          待 `onEditorReady` 后重试（`EditorView` 是异步创建的，请求可能先到）。
   */
  locate(line: number, options?: {scroll?: boolean}): boolean
  /** 硬清除定位高亮（无渐隐）：只清装饰，不动选区 */
  clearLocate(): void
}

export function CodeEditor({
  content, path, forceVim, onSelectionChange, onEditorReady, ref,
}: {
  content: string
  path: string
  forceVim?: boolean
  onSelectionChange?: (sel: {lineNumbers: number[]} | null) => void
  /** 视图就绪（`EditorView` 已创建）：早到的定位请求据此重试 */
  onEditorReady?: () => void
  /** React 19 的 ref-as-prop：命令式句柄见 `CodeEditorHandle` */
  ref?: Ref<CodeEditorHandle>
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const controllerRef = useRef<LineSelectionController | null>(null)
  // 回调走 ref：若进 [content, path, forceVim] 依赖会因父级每帧新建函数而重建 EditorView
  const onSelectionChangeRef = useRef(onSelectionChange)
  onSelectionChangeRef.current = onSelectionChange
  const onEditorReadyRef = useRef(onEditorReady)
  onEditorReadyRef.current = onEditorReady
  /**
   * 「本次选区变化源自定位」的显式标记。
   * 定位会把光标移到目标行行首，这本身也是一次选区变化——没有这个标记就只能靠猜，
   * 会把定位自己的光标移动误判成用户操作、刚点亮的高亮立刻被清掉。
   * dispatch 是同步的，因此标记只需覆盖 dispatch 调用本身。
   */
  const locatingRef = useRef(false)
  /** 清高亮的稳定入口（挂在 ref 上：controller 回调与卸载路径都要用，且不能让 effect 依赖漂移） */
  const clearLocateRef = useRef((): void => {
    viewRef.current?.dispatch({effects: setLocatedLine.of(null)})
  })
  /** 定位的稳定实现（挂在 ref 上：句柄对象身份必须稳定，见下方 useImperativeHandle 的空依赖） */
  const locateRef = useRef((line: number, options?: {scroll?: boolean}): boolean => {
    const view = viewRef.current
    if (!view) return false   // 视图未就绪：调用方保持挂起，等 onEditorReady
    const n = clampLine(line, view.state.doc.lines)
    const pos = view.state.doc.line(n).from
    locatingRef.current = true
    try {
      view.dispatch({
        // 光标置该行行首
        selection: {anchor: pos},
        effects: [
          // 居中而非就近可见（spec §定位）；重复定位同一行时调用方传 scroll: false 跳过
          ...(options?.scroll === false ? [] : [EditorView.scrollIntoView(pos, {y: 'center'})]),
          setLocatedLine.of(n),
        ],
      })
    } finally {
      locatingRef.current = false
    }
    return true
  })

  useImperativeHandle(ref, () => ({
    locate: (line, options) => locateRef.current(line, options),
    clearLocate: () => clearLocateRef.current(),
  }), [])

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
        onChange: sel => {
          // 用户操作优先：非「定位来源」的选区变化立即清掉定位高亮。
          // 定位自己造成的移动被 locatingRef 标记过，不会误触发这里（见 lib/locateHighlight.ts）。
          if (shouldClearLocateOnSelectionChange(locatingRef.current ? 'locate' : 'user')) clearLocateRef.current()
          onSelectionChangeRef.current?.(sel)
        },
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
        // 定位高亮的整行背景装饰：与上一行**互相独立**的一条通道（见 lib/lineDecoration.ts）
        ...locateLineDecorations,
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
      // 视图就绪：通知父级重试挂起中的定位请求（EditorView 是异步创建的，请求可能先到）
      onEditorReadyRef.current?.()
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
