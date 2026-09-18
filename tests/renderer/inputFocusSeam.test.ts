import {describe, expect, it} from 'vitest'
import fs from 'fs'
import path from 'path'
import {stripAllComments, walkSourceFiles} from './helpers/tokenScan'

/**
 * 文本输入框焦点样式的**收敛护栏**。
 *
 * ## 契约
 * 全仓每一个「文本输入类控件」（`<input>` 的非 checkbox/radio/file/range/color/hidden 类型，
 * 以及 `<textarea>`）的焦点样式**必须**来自 `src/renderer/lib/inputFocus.ts` 的 `INPUT_FOCUS`；
 * 控件自身**不得**再声明一遍焦点方言。
 *
 * ## 为什么要有这条护栏
 * 收敛前实况（2026-09 盘点，88 个站点）：
 *   `focus:ring-*` 31 处 / 仅 `focus:border-*` 41 处 / 无焦点样式 13 处 /
 *   与 `INPUT_FOCUS` 一致 2 处 —— 也就是「统一」实际只覆盖 2/88。
 * 只靠人工复查必然再次漂移，故把契约写成可机械判定的断言。
 *
 * ## 允许的例外（穷尽，勿扩）
 * 1. **错误态降级**：`focus:border-red-*` / `focus:border-[var(--error)]`。
 *    这是表单校验反馈，不是焦点方言。
 * 2. `EXEMPT` 登记表里的站点——每条都必须写明**理由**与**复评触发点**，
 *    对应仓库既有的豁免登记习惯（见 tests/renderer/tokenCompliance.*.test.ts）。
 *    豁免是**标签粒度**的：给了 `anchor` 就只豁免「属性文本含该锚点」的那一个标签。
 *    这样才敢在 AgentsDialog.tsx 这种「10+ 个已收敛输入框 + 1 个例外」的文件里开口子。
 *    过期登记（锚点匹配不到任何标签）由同名自检用例拦下。
 *
 * ## 能力边界（如实声明）
 * 规则级证据：断言的是「源码里没有第二种焦点方言」，不证明浏览器算出的样式符合预期。
 * 渲染级证据见 tmp/focus-flash/probe.cjs 与 probe-seam.cjs（electron 逐帧采样）。
 *
 *   - **只扫 `.tsx`**（`src/renderer` 下）。`.ts` 里没有 JSX；三个 HTML 入口
 *     （index.html / dialogWindow.html / main_window/projectManager.html）无手写输入框。
 *   - **注释先剥离再扫**（`stripAllComments`）。首版漏了这一步，导致源码注释里写
 *     `<input type="date">` 也会被判违规——那是「护栏逼着改注释」，不是真违规。
 *   - **标签切分靠正则**（`extractTags`）：止于配平后的标签 `>`。动态拼接出标签名的写法会漏，
 *     本仓目前没有。
 */

/** 扫描目标：仓库相对路径（/ 分隔），已排序 */
const SCAN_TARGETS = () => walkSourceFiles('src/renderer').filter((f) => f.endsWith('.tsx'))

interface Exemption {
  /** 仓库相对路径（/ 分隔） */
  file: string
  /** 可选。给出后**只**豁免属性文本含该锚点的标签；缺省 = 豁免整个文件 */
  anchor?: string
  reason: string
  revisit: string
}

/** 豁免登记。新增前先问：真的不能走 INPUT_FOCUS，还是只是懒得改？ */
const EXEMPT: Exemption[] = [
  {
    file: 'src/renderer/components/InputArea.tsx',
    reason:
      '用户明确要求排除（本轮范围外）。主输入区的 textarea 无边框、无 ring，焦点视觉由父容器 ' +
      'focus-within:border-[var(--brand-primary)] 承担，与「带边框的单行/多行输入框」不是同一形态。',
    revisit: '若决定把主输入区也纳入统一焦点样式，或主输入区改为自带边框，则回来重评。',
  },
  {
    file: 'src/renderer/components/dialogs/AgentsDialog.tsx',
    anchor: 'flex-1 min-w-[80px] bg-transparent border-none outline-none',
    reason:
      'AgentsDialog 的 TagInput（chip 输入）：这是**无边框的隐形 inner input**，视觉外壳是父容器 ' +
      '（border + bg + focus-within 焦点态），与 InputArea 同形态、不是「带边框的单行/多行输入框」。' +
      '补 INPUT_FOCUS 会在 chip 容器内多套一层 radius=0 的 2px ring——容器已用 ' +
      'focus-within:border/ring 表达焦点，重复且视觉破损，故此处**主动不套** INPUT_FOCUS，由本豁免放行。' +
      '其余标签不受本豁免影响（锚点粒度）。',
    revisit: '若 TagInput 改为「input 自带边框」形态，或把父容器外壳也纳入 INPUT_FOCUS 契约，则回来重评。',
  },
  {
    file: 'src/renderer/project-manager/components/QuickOpen.tsx',
    anchor: 'pm-quickopen-input',
    reason:
      'QuickOpen 浮层（ADR-0002）的搜索框：同样是**无边框的隐形 inner input**，视觉外壳是 ' +
      '.pm-quickopen-head 这一行本身（该行自带 border-bottom，焦点经 :focus-within 抬到 ' +
      '--border-emphasis）。ring 是外扩的，套在整行铺满的输入框上会右端空出一道缝、并随 0 圆角 ' +
      '退化成直角——三种模式（File Search / Recent Files / Find in Files）下都肉眼可见，' +
      '即「搜索框右侧有缝隙 / 无圆角」这条反馈。补 INPUT_FOCUS 等于把这个缺陷装回去，故主动不套。',
    revisit:
      '若 QuickOpen 的搜索框改为「自带边框的独立控件」（行内留出对称内边距 + 圆角），则回来重评。',
  },
]

/** 该标签是否被登记豁免 */
function isExempt(rel: string, attrs: string): boolean {
  return EXEMPT.some((e) => e.file === rel && (!e.anchor || attrs.includes(e.anchor)))
}

/** 非文本输入的 type 值：这些控件没有「文本输入焦点」语义，不在本契约范围内 */
const NON_TEXT_TYPES = /type=["'](?:checkbox|radio|file|range|color|hidden|submit|button|reset|image)["']/

/** 焦点方言工具类：本契约禁止控件自带 */
const FORBIDDEN_FOCUS = /^(?:[a-z0-9-]+:)*(?:focus|focus-visible|focus-within):(?:ring|outline)(?:-|$)/
/** 允许的错误态降级 */
const ERROR_BORDER = /^(?:[a-z0-9-]+:)*focus:border-(?:red-\d+|\[var\(--(?:error|red)[^\]]*\)\])$/
/** 任何焦点边框工具类（错误态除外的一律违规） */
const FOCUS_BORDER = /^(?:[a-z0-9-]+:)*focus:border-/

/** 取出源码里全部字符串字面量（含跨行） */
export function extractLiterals(src: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      i++
      let buf = ''
      while (i < src.length) {
        const c = src[i]
        if (c === '\\') {
          buf += src[i + 1] ?? ''
          i += 2
          continue
        }
        if (c === ch) break
        buf += c
        i++
      }
      out.push(buf)
      i++
      continue
    }
    i++
  }
  return out
}

/** 从 `<input` / `<textarea` 起，切出该 JSX 标签的属性文本（配平括号与引号，止于标签的 `>`） */
export function extractTags(src: string): Array<{tag: string; start: number; attrs: string}> {
  const out: Array<{tag: string; start: number; attrs: string}> = []
  const re = /<(input|textarea)\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    const start = m.index
    let i = re.lastIndex
    let depth = 0
    let quote: string | null = null
    for (; i < src.length; i++) {
      const c = src[i]
      if (quote) {
        if (c === '\\') i++
        else if (c === quote) quote = null
        continue
      }
      if (c === '"' || c === "'" || c === '`') {
        quote = c
        continue
      }
      if (c === '{') depth++
      else if (c === '}') depth--
      else if (c === '>' && depth === 0) break
    }
    out.push({tag: m[1], start, attrs: src.slice(start, i + 1)})
    re.lastIndex = i + 1
  }
  return out
}

/** 对一个 JSX 标签的属性文本做契约检查，返回违规说明列表（空 = 合规） */
export function checkTag(attrs: string): string[] {
  if (NON_TEXT_TYPES.test(attrs)) return []
  const issues: string[] = []
  const tokens = extractLiterals(attrs).flatMap((lit) => lit.split(/\s+/)).filter(Boolean)
  if (!/INPUT_FOCUS/.test(attrs)) issues.push('未使用 INPUT_FOCUS（焦点样式未收敛）')
  for (const t of tokens) {
    if (FORBIDDEN_FOCUS.test(t)) issues.push(`自带焦点方言：${t}`)
    else if (FOCUS_BORDER.test(t) && !ERROR_BORDER.test(t)) issues.push(`自带焦点边框：${t}`)
  }
  return [...new Set(issues)].sort()
}

/**
 * 扫一处源码文本，返回违规说明（`relPath:line: 说明`）。
 * 主用例与自检共用本函数——「注释先剥离」「豁免在 checkTag 之前判定」这两件事只定义一次。
 */
export function scanSource(src: string, relPath: string): string[] {
  const clean = stripAllComments(src, 'ts')
  const out: string[] = []
  for (const {start, attrs} of extractTags(clean)) {
    if (isExempt(relPath, attrs)) continue
    const issues = checkTag(attrs)
    if (issues.length) {
      out.push(`${relPath}:${clean.slice(0, start).split('\n').length}: ${issues.join('；')}`)
    }
  }
  return out
}

describe('文本输入焦点样式收敛 — 每个输入框都必须走 INPUT_FOCUS', () => {
  it('src/renderer 全量扫描：无输入框自带第二套焦点方言', () => {
    const violations: string[] = []
    for (const relPath of SCAN_TARGETS()) {
      const src = fs.readFileSync(path.resolve(process.cwd(), relPath), 'utf-8')
      violations.push(...scanSource(src, relPath))
    }
    expect(
      violations,
      '文本输入类控件的焦点样式必须来自 src/renderer/lib/inputFocus.ts 的 INPUT_FOCUS。\n' +
        '若某个站点确实需要例外，请在 tests/renderer/inputFocusSeam.test.ts 的 EXEMPT 登记\n' +
        '（写明理由 + 复评触发点），不要放宽判据。',
    ).toEqual([])
  })

  it('护栏自检：合成违规必须被命中、错误态降级不得误伤', () => {
    expect(checkTag('<input className="w-full focus:ring-1 focus:ring-[var(--brand-primary)]" />')).toEqual([
      '未使用 INPUT_FOCUS（焦点样式未收敛）',
      '自带焦点方言：focus:ring-1',
      '自带焦点方言：focus:ring-[var(--brand-primary)]',
    ])
    // 注意：issues 经 [...new Set()].sort() 后是 **UTF-16 码位序**（非拼音序），
    // '方'(U+65B9) < '边'(U+8FB9)，故「自带焦点方言」排在「自带焦点边框」之前。
    expect(checkTag('<input className="focus:border-[var(--brand-primary)] focus:outline-none" />')).toEqual([
      '未使用 INPUT_FOCUS（焦点样式未收敛）',
      '自带焦点方言：focus:outline-none',
      '自带焦点边框：focus:border-[var(--brand-primary)]',
    ])
    // 合规
    expect(checkTag('<input className={`w-full ${INPUT_FOCUS}`} />')).toEqual([])
    // 错误态降级放行；但错误态仍需 INPUT_FOCUS 兜底
    expect(checkTag('<input className={`${INPUT_FOCUS} border-red-300 focus:border-red-400`} />')).toEqual([])
    // 非文本输入不在范围内
    expect(checkTag('<input type="checkbox" className="focus:ring-2" />')).toEqual([])
  })

  it('护栏自检：注释里的标签不算违规（否则会逼着改注释）', () => {
    // 首版在这条上翻过车：DatePicker 的注释写了 `<input type="date">`，被判「未使用 INPUT_FOCUS」，
    // 于是注释被改写成「原生日期输入控件」——护栏制造的假阳性污染了源码。
    const src = [
      '// 旧写法：<input className="focus:ring-1" />',
      '{/* 替换原生 <input type="date">：<textarea className="focus:outline-none" /> */}',
      'const a = 1',
    ].join('\n')
    expect(scanSource(src, 'x.tsx')).toEqual([])
    // 同一份源码，注释剥掉后真违规仍必须命中（防止「一律不扫」式假绿）
    expect(scanSource('<input className="focus:ring-1" />', 'x.tsx')).toHaveLength(1)
  })

  it('护栏自检：豁免按标签粒度生效，不放过同文件的其它违规', () => {
    // 文件级豁免（无 anchor）
    expect(isExempt('src/renderer/components/InputArea.tsx', '<textarea className="x" />')).toBe(true)
    // 锚点命中 → 豁免
    expect(
      isExempt(
        'src/renderer/components/dialogs/AgentsDialog.tsx',
        '<input className="flex-1 min-w-[80px] bg-transparent border-none outline-none py-1" />',
      ),
    ).toBe(true)
    // 同文件的其它标签不得被牵连
    expect(
      isExempt(
        'src/renderer/components/dialogs/AgentsDialog.tsx',
        '<input className="w-full rounded-lg border border-[var(--border)] py-2" />',
      ),
    ).toBe(false)
    // 同锚点但不同文件 → 不豁免
    expect(
      isExempt(
        'src/renderer/components/Other.tsx',
        '<input className="flex-1 min-w-[80px] bg-transparent border-none outline-none" />',
      ),
    ).toBe(false)
  })

  it('护栏自检：EXEMPT 登记表不得过期（锚点必须真实命中）', () => {
    const stale: string[] = []
    for (const e of EXEMPT) {
      const abs = path.resolve(process.cwd(), e.file)
      if (!fs.existsSync(abs)) {
        stale.push(`${e.file}：文件不存在，豁免无处生效`)
        continue
      }
      if (!e.anchor) continue
      const src = fs.readFileSync(abs, 'utf-8')
      if (!extractTags(src).some(({attrs}) => attrs.includes(e.anchor as string))) {
        stale.push(`${e.file}：锚点 ${JSON.stringify(e.anchor)} 未命中任何标签`)
      }
    }
    expect(stale, 'EXEMPT 是「带理由的例外」，不是永久豁免：锚点失配即已失效，请删掉或改准。').toEqual([])
  })

  it('护栏自检：标签切分能正确配平引号与花括号', () => {
    const src = [
      '<input',
      '  value={a > b ? "x" : "y"}',
      '  onChange={(e) => setV(e.target.value)}',
      '  className={`${INPUT_FOCUS} w-full`}',
      '/>',
      '<div>not a tag</div>',
    ].join('\n')
    const tags = extractTags(src)
    expect(tags).toHaveLength(1)
    expect(checkTag(tags[0].attrs)).toEqual([])
  })
})
