import type {Language} from '@codemirror/language'
import {highlightTree, tagHighlighter, tags as t} from '@lezer/highlight'

/** 一段行内着色片段。cls 为 '' 表示这一段没有着色（未着色区间也显式成段，见下方不变量） */
export type LineToken = {text: string, cls: string}

/**
 * 与 components/CodeEditor.tsx 的 `themedHighlight` **逐条同源**（tag 分组照抄，不自创）。
 * 差别只有一个：CodeEditor 把 tag 映射到 CSS 变量，这里映射到类名，类名再于 globals.css
 * 引用**同一批 `--code-*` 令牌**。于是「编辑器里看到的颜色」与「diff 里看到的颜色」必然一致，
 * 将来调色只需改令牌，两边同时生效。
 *
 * 注：`highlightTree` / `tagHighlighter` / `tags` 均来自 `@lezer/highlight`，
 * **不在** `@codemirror/language` 的导出里（后者只透出 HighlightStyle/syntaxHighlighting）。
 */
const highlighter = tagHighlighter([
  {tag: t.keyword, class: 'pm-tok-keyword'},
  {tag: [t.string, t.special(t.string)], class: 'pm-tok-string'},
  {tag: [t.comment, t.lineComment, t.blockComment], class: 'pm-tok-comment'},
  {tag: [t.number, t.bool, t.null], class: 'pm-tok-number'},
  {tag: [t.typeName, t.className, t.namespace], class: 'pm-tok-type'},
  {tag: [t.function(t.variableName), t.function(t.propertyName)], class: 'pm-tok-function'},
  {tag: [t.propertyName, t.variableName, t.definition(t.variableName)], class: 'pm-tok-ident'},
  {tag: [t.operator, t.punctuation, t.bracket], class: 'pm-tok-punct'},
])

/**
 * 着色预算（字符数）。highlightTree 是 O(节点数) 的树遍历 + 线性切分，单次本身不贵，
 * 但 diff 视图一次要跑**左右两份全文**，且切换 filePath 会重复执行；大文件（bundle、
 * 压缩产物、生成代码）会占住主线程到肉眼可见的卡顿。40 万字符 ≈ 一万行常规源码，
 * 远超人工 review 的合理 diff 体量 —— 超过就退回既有的单色渲染（降级但不冻结 UI）。
 * 与 DiffViewer 里既有的 `MAX_WORD_DIFF_*` 护栏同一思路。
 */
export const MAX_HIGHLIGHT_CHARS = 400_000

/**
 * 按扩展名取 Language（**不是** Extension[]，和 lib/language.ts 的 getLanguageExtension 分开，
 * 后者服务于 CodeEditor，改动它会有回归风险）。不支持的扩展名一律 null。
 */
async function getLanguage(path: string): Promise<Language | null> {
  const ext = path.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'ts': case 'js': case 'mjs': case 'cjs': {
      const {javascriptLanguage} = await import('@codemirror/lang-javascript')
      return javascriptLanguage
    }
    // jsx/tsx 必须显式开 jsx：与 lib/language.ts 的 `javascript({jsx: …})` 同源。
    // 用 javascriptLanguage（jsx 关闭）会把 JSX 标签当语法错误恢复，标签名不着 pm-tok-type，
    // 导致同一份 .tsx 在编辑器里与 diff 里着色不一致 —— 违反本文件「两边必然同色」的契约。
    case 'tsx': case 'jsx': {
      const {javascript} = await import('@codemirror/lang-javascript')
      return javascript({jsx: true}).language
    }
    case 'json': {
      const {jsonLanguage} = await import('@codemirror/lang-json')
      return jsonLanguage
    }
    case 'css': case 'scss': {
      const {cssLanguage} = await import('@codemirror/lang-css')
      return cssLanguage
    }
    case 'html': case 'htm': {
      const {htmlLanguage} = await import('@codemirror/lang-html')
      return htmlLanguage
    }
    default: return null
  }
}

/** 把整篇的着色区间按行切开，产出 `LineToken[][]`（length === content.split('\n').length）。 */
function splitByLine(ranges: readonly {from: number, to: number, cls: string}[], content: string): LineToken[][] {
  const lines = content.split('\n')
  const out: LineToken[][] = []
  // 行首在 content 中的偏移量；每轮先 +1 跳过行分隔符 '\n'（CRLF 的 '\r' 留在行尾，
  // 与 content.split('\n') / DiffViewer 的 splitLines 同口径）
  let lineStart = 0
  let firstRange = 0
  for (const line of lines) {
    const lineEnd = lineStart + line.length
    const tokens: LineToken[] = []
    // 相邻且同类名的片段就地合并（含未着色的 '' 段）——同一个 token 被拆成大量
    // 单字符 span 既浪费 DOM，也会让下游的词级 mark 被迫切碎，这里一次收敛掉。
    const push = (text: string, cls: string) => {
      if (!text) return
      const last = tokens[tokens.length - 1]
      if (last && last.cls === cls) last.text += text
      else tokens.push({text, cls})
    }
    // 丢弃完全落在本行之前的区间（多行区间会保留给后续行，故只按起点推进）
    while (firstRange < ranges.length && ranges[firstRange].to <= lineStart) firstRange++
    let pos = lineStart
    for (let i = firstRange; i < ranges.length && ranges[i].from < lineEnd; i++) {
      const r = ranges[i]
      const from = Math.max(r.from, lineStart)
      const to = Math.min(r.to, lineEnd)
      if (to <= from) continue
      if (from > pos) push(content.slice(pos, from), '')
      push(content.slice(from, to), r.cls)
      pos = to
    }
    if (pos < lineEnd) push(content.slice(pos, lineEnd), '')
    out.push(tokens)
    lineStart = lineEnd + 1
  }
  return out
}

/**
 * 逐行语法着色。返回 null 表示「不着色」，调用方应走原有渲染路径：
 * - 扩展名不支持（.md / .txt / .yaml / 无扩展名 …）
 * - 内容超预算（见 MAX_HIGHLIGHT_CHARS）
 *
 * **不变量**：`tokens[i].map(t => t.text).join('') === content.split('\n')[i]`，
 * 即着色切分对每一行都是无损覆盖（未着色处显式补 `cls: ''` 段）。
 * 选「显式补空段」而不是「省略」是为了让不变量无条件成立 —— 渲染侧于是可以无脑
 * 按覆盖处理，不必区分「这行有没有着色」。
 */
export async function highlightLines(content: string, path: string): Promise<LineToken[][] | null> {
  if (content.length > MAX_HIGHLIGHT_CHARS) return null
  const language = await getLanguage(path)
  if (!language) return null
  const tree = language.parser.parse(content)
  const ranges: {from: number, to: number, cls: string}[] = []
  highlightTree(tree, highlighter, (from, to, cls) => {
    ranges.push({from, to, cls})
  })
  return splitByLine(ranges, content)
}
