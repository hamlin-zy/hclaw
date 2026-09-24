/**
 * HTML → Markdown 渲染层
 *
 * 背景：web_fetch 原先用正则剥标签，会丢失表格/列表/层级/链接，且对超深嵌套无防护。
 * 本模块用词法标签扫描器定位元素区间（深度守卫与正文提取共用），
 * 再由 turndown 转换为 markdown：删除线 / 任务列表 / 高亮代码块取自 GFM 插件，
 * 表格规则自实现（插件版表格规则会为推断对齐而遍历全表行，在 domino 上退化为 O(行²)）。
 *
 * 安全：turndown 转换是同步的，超深嵌套会阻塞主进程事件循环，
 * 故设 MAX_CONVERSION_DEPTH 上限，超限直接整体省略。
 */

import TurndownService from 'turndown'
import {highlightedCodeBlock, strikethrough, taskListItems} from '@joplin/turndown-plugin-gfm'

export interface HtmlTransformOptions {
  /** 转换前输入字符上限，默认 200_000 */
  maxInputChars?: number
  /** 输出 markdown 字符上限，默认 100_000 */
  maxOutputChars?: number
}

export interface HtmlTransformResult {
  markdown: string
  /** 输入超 maxInputChars 被截断 */
  sourceTruncated: boolean
  /** 因深度超限或转换异常而整体省略 */
  omitted: boolean
}

// ─── 常量 ─────────────────────────────────────────────

const DEFAULT_MAX_INPUT_CHARS = 200_000
const DEFAULT_MAX_OUTPUT_CHARS = 100_000

/** 最大转换深度：超过则整体省略（同步转换会阻塞事件循环） */
const MAX_CONVERSION_DEPTH = 512

/** 正文提取结果的最小字符数（不达标则回退全文） */
const MIN_EXTRACT_CHARS = 200
/** 正文提取结果占全文文本长度的最小比例（不达标则回退全文） */
const MIN_EXTRACT_RATIO = 0.2

/** void 元素：不压栈 */
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])

/** raw text 元素：内容按纯文本处理，直到配对结束标签 */
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'noscript'])

/**
 * 遇到同名开标签时会自动闭合前一个同名元素的标签
 *
 * HTML5 允许省略 </p>、</li>、</td> 等的闭合标签，
 * 页面源码里连续出现同类开标签是常态，不代表嵌套加深。
 */
const AUTO_CLOSE_SAME_NAME = new Set([
  'p', 'li', 'td', 'th', 'tr', 'dt', 'dd', 'option', 'thead', 'tbody', 'tfoot',
])

/** 开标签出现时自动闭合栈内最近的未闭合 <p> 的块级元素 */
const CLOSES_PARAGRAPH = new Set([
  'div', 'section', 'article', 'main', 'aside', 'header', 'footer', 'nav', 'ul', 'ol',
  'table', 'form', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre',
])

/** 正文候选容器（配合 role="main" 使用） */
const MAIN_CANDIDATE_ELEMENTS = new Set(['article', 'main'])

/** 开标签上的 role="main" 标记（正文容器） */
const ROLE_MAIN_PATTERN = /role\s*=\s*["']?main\b/i

/** 参与 class/id 语义筛选的块级候选容器 */
const BLOCK_ELEMENTS = new Set(['div', 'section', 'article'])

/** 提取后整块剥离的噪音元素 */
const NOISE_ELEMENTS = new Set(['nav', 'header', 'footer', 'aside', 'form'])

/**
 * class/id 中的否定语义 token：命中即排除该块
 *
 * 优先于肯定词判定 —— 评论区/侧栏/页脚即使很长也不是正文。
 */
const NEGATIVE_SEMANTIC_TOKENS = new Set([
  'comment', 'comments', 'reply', 'replies', 'discuss', 'discussion', 'sidebar', 'aside',
  'related', 'recommend', 'recommendation', 'footer', 'header', 'nav', 'navbar', 'menu',
  'banner', 'breadcrumb', 'share', 'social', 'widget', 'promo', 'sponsor', 'ad', 'ads',
  'advert', 'advertisement', 'pager', 'pagination', 'meta', 'tag', 'tags', 'toolbar',
])

/** class/id 中的肯定语义 token：命中才纳入候选 */
const POSITIVE_SEMANTIC_TOKENS = new Set([
  'content', 'article', 'post', 'entry', 'main', 'body', 'text', 'story', 'detail',
  'page', 'essay', 'blog',
])

/** 不可见内容元素（turndown 规则剔除） */
const NON_VISIBLE_ELEMENTS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED',
])

// ─── 标签扫描 ─────────────────────────────────────────

/** 元素区间（开标签到配对闭标签） */
interface ElementRange {
  /** 小写标签名 */
  name: string
  /** 开标签起始位置 */
  start: number
  /** 配对闭标签之后的位置 */
  end: number
  /** 开标签属性区原文（用于识别 role="main"） */
  attrs: string
}

interface ScanResult {
  ranges: ElementRange[]
  /** 扫描过程中的最大嵌套深度 */
  maxDepth: number
}

/** 扫描栈上尚未闭合的开标签 */
interface OpenElement {
  /** 小写标签名 */
  name: string
  /** 开标签起始位置 */
  start: number
  /** 开标签属性区原文 */
  attrs: string
}

interface ParsedTag {
  name: string
  isClose: boolean
  selfClosing: boolean
  /** 标签本身结束（'>' 之后）的位置 */
  end: number
  /** 属性区原文 */
  attrs: string
}

/**
 * 读取一个标签
 *
 * 跳过引号内的 '>'；非标签（如正文里的裸 '<'）返回 null
 */
function readTag(html: string, start: number): ParsedTag | null {
  const len = html.length
  let i = start + 1
  if (i >= len) return null

  // 声明 / 处理指令（<!-- --> 注释已由调用方跳过）：跳到引号外的 '>'
  if (html[i] === '!' || html[i] === '?') {
    let quote: string | null = null
    while (i < len) {
      const ch = html[i]
      if (quote) {
        if (ch === quote) quote = null
      } else if (ch === '"' || ch === "'") {
        quote = ch
      } else if (ch === '>') {
        return {name: '!declaration', isClose: false, selfClosing: true, end: i + 1, attrs: ''}
      }
      i++
    }
    return null
  }

  let isClose = false
  if (html[i] === '/') {
    isClose = true
    i++
  }

  const nameStart = i
  while (i < len && /[A-Za-z0-9:_-]/.test(html[i])) i++
  if (i === nameStart) return null
  const name = html.slice(nameStart, i).toLowerCase()

  const attrsStart = i
  let quote: string | null = null
  while (i < len) {
    const ch = html[i]
    if (quote) {
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '>') {
      break
    } else if (ch === '<') {
      // 畸形标签（缺 '>'）：放弃，交给调用方按文本处理
      return null
    }
    i++
  }
  if (i >= len) return null

  const attrs = html.slice(attrsStart, i)
  return {name, isClose, selfClosing: /\/\s*$/.test(attrs), end: i + 1, attrs}
}

/**
 * 查找 raw text 元素的配对结束标签起始位置（大小写不敏感）
 */
function findRawTextEnd(html: string, name: string, from: number): number {
  const lower = html.toLowerCase()
  let i = from
  while (i < lower.length) {
    const idx = lower.indexOf(`</${name}`, i)
    if (idx < 0) return -1
    const after = lower[idx + 2 + name.length]
    if (after === undefined || after === '>' || /\s/.test(after)) return idx
    i = idx + 2
  }
  return -1
}

/**
 * 应用 HTML5 最小集隐式闭合规则（仅影响栈，不产出元素区间）
 *
 * HTML5 允许省略部分闭合标签，正常长文页大量依赖这一点；
 * 若一律按「未配对开标签」计深度，正常页面会被误判为超深嵌套而整页丢弃。
 */
function closeImplicitly(
  stack: OpenElement[],
  name: string,
): void {
  const autoCloseSameName = AUTO_CLOSE_SAME_NAME.has(name)
  const closesParagraph = CLOSES_PARAGRAPH.has(name)
  if (!autoCloseSameName && !closesParagraph) return

  for (let s = stack.length - 1; s >= 0; s--) {
    const openName = stack[s].name
    if ((autoCloseSameName && openName === name) || (closesParagraph && openName === 'p')) {
      // 连同其上的元素一起弹出：它们同样没有配对闭标签
      stack.length = s
      return
    }
  }
}

/**
 * 扫描 HTML，产出配对成功的元素区间与最大嵌套深度
 *
 * 词法扫描（非 DOM 解析）：跳过注释与引号内的 '>'，void 元素不压栈，
 * raw text 元素内容按文本处理直到配对结束标签
 */
function scanHtml(html: string): ScanResult {
  const ranges: ElementRange[] = []
  const stack: OpenElement[] = []
  let maxDepth = 0
  let i = 0

  while (i < html.length) {
    const lt = html.indexOf('<', i)
    if (lt < 0) break

    // 注释：整块跳过
    if (html.startsWith('<!--', lt)) {
      const commentEnd = html.indexOf('-->', lt + 4)
      if (commentEnd < 0) break
      i = commentEnd + 3
      continue
    }

    const tag = readTag(html, lt)
    if (!tag) {
      i = lt + 1
      continue
    }
    i = tag.end

    if (tag.isClose) {
      // 就近找同名开标签配对（容错：容忍中间缺失的闭标签）
      for (let s = stack.length - 1; s >= 0; s--) {
        if (stack[s].name === tag.name) {
          ranges.push({name: tag.name, start: stack[s].start, end: tag.end, attrs: stack[s].attrs})
          stack.length = s
          break
        }
      }
      continue
    }

    if (tag.selfClosing || VOID_ELEMENTS.has(tag.name)) {
      ranges.push({name: tag.name, start: lt, end: tag.end, attrs: tag.attrs})
      continue
    }

    closeImplicitly(stack, tag.name)

    stack.push({name: tag.name, start: lt, attrs: tag.attrs})
    if (stack.length > maxDepth) maxDepth = stack.length

    if (RAW_TEXT_ELEMENTS.has(tag.name)) {
      const closeStart = findRawTextEnd(html, tag.name, tag.end)
      let end = html.length
      if (closeStart >= 0) {
        const gt = html.indexOf('>', closeStart)
        end = gt < 0 ? html.length : gt + 1
      }
      const opened = stack.pop() as OpenElement
      ranges.push({name: opened.name, start: opened.start, end, attrs: opened.attrs})
      i = end
    }
  }

  return {ranges, maxDepth}
}

// ─── 正文提取 ─────────────────────────────────────────

/**
 * 去标签后的文本长度（正文密度打分用）
 */
function textLength(fragment: string): number {
  return fragment
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .length
}

/**
 * 整块剥离噪音元素（nav / header / footer / aside / form）
 */
function stripNoiseBlocks(html: string): string {
  const {ranges} = scanHtml(html)
  const noise = ranges
    .filter((range) => NOISE_ELEMENTS.has(range.name))
    .sort((a, b) => a.start - b.start)
  if (noise.length === 0) return html

  let out = ''
  let cursor = 0
  for (const block of noise) {
    if (block.start < cursor) continue // 已被外层噪音区间覆盖
    out += html.slice(cursor, block.start)
    cursor = block.end
  }
  return out + html.slice(cursor)
}

/**
 * 取出开标签 class / id 属性值的语义 token
 *
 * 按非字母数字字符切分后比对，而非子串匹配：
 * 子串匹配会让 `header`（含 ad）、`read`（含 ad）等正常类名被误判为广告位。
 */
function semanticTokensOf(attrs: string): string[] {
  const tokens: string[] = []
  const attrPattern = /(?<![\w-])(class|id)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi
  let match: RegExpExecArray | null

  while ((match = attrPattern.exec(attrs)) !== null) {
    const raw = match[2] ?? match[3] ?? match[4] ?? ''
    for (const token of raw.toLowerCase().split(/[^a-z0-9]+/)) {
      if (token) tokens.push(token)
    }
  }
  return tokens
}

/**
 * 块级候选的语义筛选：否定词命中即排除，否则须命中肯定词才纳入
 */
function isContentCandidate(attrs: string): boolean {
  const tokens = semanticTokensOf(attrs)
  if (tokens.some((token) => NEGATIVE_SEMANTIC_TOKENS.has(token))) return false
  return tokens.some((token) => POSITIVE_SEMANTIC_TOKENS.has(token))
}

/**
 * 正文提取
 *
 * 顺序：
 * 1. 存在 article / main / role="main" 时：在其中取文本最长者（不再退而求其次做块级打分）
 * 2. 不存在时：按 class/id 语义筛选块级候选，在其中取文本最长者
 * 3. 无可纳入候选或结果不达阈值（< 200 字符或 < 全文文本 × 0.2）→ 改用全文
 * 4. 提取后剥离 nav/header/footer/aside/form 整块
 */
function extractMainContent(html: string, scan: ScanResult): string {
  const fullTextLen = textLength(html)

  /** 在候选区间中取文本最长者；不达阈值返回 null */
  const pickLongest = (candidates: ElementRange[]): ElementRange | null => {
    let best: ElementRange | null = null
    let bestLen = -1
    for (const candidate of candidates) {
      const len = textLength(html.slice(candidate.start, candidate.end))
      if (len > bestLen) {
        bestLen = len
        best = candidate
      }
    }
    if (!best) return null
    const acceptable = bestLen >= MIN_EXTRACT_CHARS && bestLen >= fullTextLen * MIN_EXTRACT_RATIO
    return acceptable ? best : null
  }

  const mainCandidates = scan.ranges.filter((range) =>
    MAIN_CANDIDATE_ELEMENTS.has(range.name) || ROLE_MAIN_PATTERN.test(range.attrs))

  // 存在明确的正文容器时只在其中挑选；不达标即回退全文（不再退而求其次做块级打分）
  const candidates = mainCandidates.length > 0
    ? mainCandidates
    : scan.ranges.filter((range) => BLOCK_ELEMENTS.has(range.name) && isContentCandidate(range.attrs))

  const picked = pickLongest(candidates)
  const base = picked ? html.slice(picked.start, picked.end) : html
  return stripNoiseBlocks(base)
}

// ─── 表格规则（自实现，O(n)） ─────────────────────────────

/**
 * 表格规则为何自实现：
 * 上游 gfm 插件的表格规则为推断列对齐，会逐列遍历整表所有行；
 * 而 domino 中每次访问 `table.rows` 都会重建行集合，
 * 「列 × 行」的访问模式因此退化为 O(行²)——12000 行表格需 98 秒，同步阻塞主进程。
 * 这里只读单行内部的子元素：表头判定看本行子元素是否全为 th，
 * 对齐标记只取单元格自身属性，不做整列投票、不访问 rows / cells / rowIndex。
 * 单次转换成本与单元格总数成正比。
 */

/** 单元格内容最小宽度（GFM 对齐标记本身占 3 字符） */
const MIN_TABLE_CELL_WIDTH = 3

/** 单元格渲染：补齐首列管道前缀、转义管道符、折叠换行 */
function formatTableCell(content: string, index: number): string {
  const prefix = index === 0 ? '| ' : ' '
  const text = content
    .trim()
    .replace(/\n\r/g, '<br>')
    .replace(/\n/g, '<br>')
    .replace(/\|+/g, '\\|')
    .padEnd(MIN_TABLE_CELL_WIDTH)
  return prefix + text + ' |'
}

/** 对齐标记只取该单元格自身的 align / text-align，不参考同列其他行 */
function tableAlignmentToken(cell: Element): string {
  const raw = (cell.getAttribute('align') ?? (cell as HTMLElement).style?.textAlign ?? '').toLowerCase()
  if (raw === 'left') return ':---'
  if (raw === 'right') return '---:'
  if (raw === 'center') return ':---:'
  return '---'
}

/** 元素在兄弟节点中的序号（跳过文本节点；只走兄弟指针，不重建集合） */
function elementIndexOf(node: Node): number {
  let index = 0
  let sibling = node.previousSibling
  while (sibling) {
    if (sibling.nodeType === 1) index++
    sibling = sibling.previousSibling
  }
  return index
}

/** 注册表格相关规则（table / 行 / 单元格 / 表格分组 / 标题 / 列定义） */
function installTableRules(service: TurndownService): void {
  service.addRule('tableCell', {
    filter: ['th', 'td'],
    replacement: (content, node) => formatTableCell(content, elementIndexOf(node)),
  })

  service.addRule('tableRow', {
    filter: 'tr',
    replacement: (content, node) => {
      const children = node.childNodes
      let elementCount = 0
      let allHeaderCells = true
      for (let i = 0; i < children.length; i++) {
        const child = children[i]
        if (child.nodeType !== 1) continue
        elementCount++
        if (child.nodeName !== 'TH') allHeaderCells = false
      }

      // 表头行：紧随其后的对齐标记行各列取本行单元格自身的对齐属性
      if (elementCount === 0 || !allHeaderCells) return '\n' + content

      let border = ''
      let index = 0
      for (let i = 0; i < children.length; i++) {
        const child = children[i]
        if (child.nodeType !== 1) continue
        border += formatTableCell(tableAlignmentToken(child as unknown as Element), index++)
      }
      return '\n' + content + (border ? '\n' + border : '')
    },
  })

  service.addRule('table', {
    filter: 'table',
    replacement: (content) => '\n\n' + content.replace(/\n+/g, '\n').trim() + '\n\n',
  })

  service.addRule('tableSection', {
    filter: ['thead', 'tbody', 'tfoot'],
    replacement: (content) => content,
  })

  service.addRule('caption', {
    filter: 'caption',
    replacement: (content) => (content.trim() ? '\n' + content.trim() + '\n' : ''),
  })

  service.addRule('colgroup', {
    filter: ['colgroup', 'col'],
    replacement: () => '',
  })
}

// ─── turndown 转换 ─────────────────────────────────────────

/**
 * 创建 turndown 实例（模块级单例，无状态可共享）
 */
function createTurndownService(): TurndownService {
  const service = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  })

  // 只取 GFM 的删除线 / 任务列表 / 高亮代码块，表格规则由 installTableRules 自实现
  service.use([highlightedCodeBlock, strikethrough, taskListItems])
  installTableRules(service)

  // 剔除不可见内容（脚本/样式、hidden 属性、aria-hidden、内联 display:none 等）
  service.addRule('removeNonVisibleContent', {
    filter: (node) => {
      const el = node as HTMLElement
      if (typeof el.nodeName !== 'string') return false
      if (NON_VISIBLE_ELEMENTS.has(el.nodeName)) return true
      if (typeof el.hasAttribute === 'function' && el.hasAttribute('hidden')) return true
      if (typeof el.getAttribute === 'function' && el.getAttribute('aria-hidden') === 'true') return true
      if (el.nodeName === 'INPUT' && el.getAttribute?.('type') === 'hidden') return true
      const style = el.getAttribute?.('style') ?? ''
      return /display\s*:\s*none|visibility\s*:\s*(hidden|collapse)/i.test(style)
    },
    replacement: () => '',
  })

  return service
}

const turndownService = createTurndownService()

// ─── 对外入口 ─────────────────────────────────────────

/**
 * HTML → Markdown
 *
 * @param html 原始 HTML 字符串
 * @param options 输入/输出字符上限
 */
export function htmlToMarkdown(html: string, options?: HtmlTransformOptions): HtmlTransformResult {
  const maxInputChars = options?.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS
  const maxOutputChars = options?.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS

  let source = html
  let sourceTruncated = false
  if (source.length > maxInputChars) {
    source = source.slice(0, maxInputChars)
    sourceTruncated = true
  }

  // 深度守卫：超深嵌套不进 turndown（同步转换会阻塞事件循环）
  const scan = scanHtml(source)
  if (scan.maxDepth > MAX_CONVERSION_DEPTH) {
    return {markdown: '', sourceTruncated, omitted: true}
  }

  let markdown: string
  try {
    markdown = turndownService.turndown(extractMainContent(source, scan))
  } catch {
    // 转换异常：绝不把原始 HTML 当结果返回
    return {markdown: '', sourceTruncated, omitted: true}
  }

  if (markdown.length > maxOutputChars) {
    markdown = markdown.slice(0, maxOutputChars)
  }

  return {markdown: markdown.trim(), sourceTruncated, omitted: false}
}
