import {describe, expect, it} from 'vitest'
import fs from 'fs'
import path from 'path'
import {stripAllComments} from './helpers/tokenScan'

/**
 * 输入框聚焦「闪一下」护栏（regression guard）。
 *
 * ## 现象
 * 会话列表的「搜索对话」与备忘录的「搜索备忘录」输入框，点击聚焦时先闪出一圈描边，
 * 再变成最终样式。
 *
 * ## 根因（已实测取证，勿凭直觉改写本段）
 * Tailwind v3 的 `outline-none` **不是** `outline-style: none`，而是：
 *
 *     .outline-none               { outline: 2px solid transparent; outline-offset: 2px }
 *     .focus\:outline-none:focus  { outline: 2px solid transparent; outline-offset: 2px }
 *
 * 即：**style 是 solid，只是颜色透明**。由此产生两个后果：
 *
 * 1. `focus:outline-none` 选择器权重 (0,2,0) **高于** globals.css 的兜底
 *    `input:focus-visible { outline: none }` (0,1,1)，
 *    于是那条「文本输入类 outline 置空」的兜底**从未生效**——被 utility 静默压过去了。
 * 2. 同元素若还挂着 `transition-all`：`outline-color` 可过渡、会被纳入过渡，
 *    而 `outline-style` 是离散属性、同帧翻值。聚焦瞬间：
 *      · `outline-style` 立刻由 `none` 变成 `solid`（不可过渡 → 当帧生效）
 *      · `outline-color` 仍停在起始值 `currentColor`，再在 150ms 内淡向 `transparent`
 *    于是这 150ms 里真的渲染出一圈**不透明实心描边**——就是用户看到的「闪一下」，
 *    它随后自行淡出，所以只在聚焦瞬间可见。
 *
 * 为什么只有 `transition-all`：Tailwind v3 的 `transition` / `transition-colors` 属性表里
 * **不含** `outline-color`，只有 `transition-all`（transition-property: all）会把它卷进来。
 *
 * 实测（electron 逐帧采样 getComputedStyle；脚本见 tmp/focus-flash/probe.cjs）：
 *   · 现行统一串（focus:outline-none + transition-all）→ 16/16 帧可见描边，
 *     起始 `rgb(51,51,51)`（浅色）/ `rgb(212,212,212)`（深色），完全不透明
 *   · 去掉 `focus:outline-none`（单变量对照）        → 0/16 帧可见
 *   · `transition-all` → `transition-none`（单变量） → 0/16 帧可见
 *   · 无条件 `outline-none`（style 恒为 solid）      → 0/16 帧可见（无处可翻）
 * 故反模式 = 「`focus:outline-*`」×「`transition-all`」在同一元素的 className 上共现。
 *
 * ## 能力边界（如实声明，勿夸大）
 * 这是**规则级**证据，不是渲染级证据：它断言「反模式在源码中不存在」，
 * 并不证明浏览器真的算出了 `outline: none`。之所以仍用源码扫描——jsdom 不做层叠与
 * 过渡求值，任何在 jsdom 内的「运行时」断言都是假绿；而「反模式是否出现」是可机械判定的
 * 源文本事实，钉住它即可防止静默回归。
 *
 * 扫描口径：按**字符串字面量**（" / ' / `）切分并跨行匹配，而非逐行——
 * className 常跨多行书写，逐行扫描会漏（本文件首版就是这么漏掉 9 个站点的）。
 * 注释先整体剥除，避免注释里提到的反模式造成误报。
 */

const RENDERER = path.resolve(process.cwd(), 'src/renderer')

function collectSources(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...collectSources(p))
    else if (/\.tsx?$/.test(e.name)) out.push(p)
  }
  // 排序：readdirSync 的原始顺序跨平台不稳定，违规清单的顺序不该跟着漂
  return out.sort()
}

/** 取出源码里的全部字符串字面量（含跨行），带起始行号 */
export function extractLiterals(src: string): Array<{text: string; line: number}> {
  const out: Array<{text: string; line: number}> = []
  let line = 1
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (ch === '\n') {
      line++
      i++
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const startLine = line
      i++
      let buf = ''
      while (i < src.length) {
        const c = src[i]
        if (c === '\\') {
          buf += (src[i + 1] ?? '') === 'n' ? '\n' : (src[i + 1] ?? '')
          i += 2
          continue
        }
        if (c === '\n') line++
        if (c === ch) break
        buf += c
        i++
      }
      out.push({text: buf, line: startLine})
      i++
      continue
    }
    i++
  }
  return out
}

/**
 * 该字面量是否含 `focus:outline-*` / `focus-visible:outline-*` 工具类
 * （无条件 `outline-none` 不算：它的 style 恒为 solid，无处可翻）。
 *
 * 为什么 `focus-visible:` 也必须算：两者展开的是**同一条声明**（`outline: 2px solid transparent`），
 * 只是选择器不同——`focus-visible` 版本同样会在匹配当帧把 `outline-style` 翻成 solid，
 * 配 `transition-all` 同样闪。首版只认 `focus:`，把这条等价的路径漏在了护栏外。
 */
const hasFocusOutline = (token: string) => /(^|:)(?:focus|focus-visible):outline-/.test(token)

/** 扫描一处源码文本，返回违规字面量所在行（供自检直接喂合成串） */
export function findAntiPatterns(src: string): number[] {
  const clean = stripAllComments(src, 'ts')
  const hits: number[] = []
  for (const lit of extractLiterals(clean)) {
    const tokens = lit.text.split(/\s+/).filter(Boolean)
    if (tokens.some(hasFocusOutline) && tokens.includes('transition-all')) hits.push(lit.line)
  }
  return hits
}

describe('输入框聚焦闪烁 — 反模式不存在（focus:outline-* × transition-all）', () => {
  it('src/renderer 全量扫描：无任何站点同时使用 focus:outline-* 与 transition-all', () => {
    const violations: string[] = []
    for (const file of collectSources(RENDERER)) {
      const rel = path.relative(process.cwd(), file).replace(/\\/g, '/')
      for (const line of findAntiPatterns(fs.readFileSync(file, 'utf-8'))) {
        violations.push(`${rel}:${line}`)
      }
    }
    expect(
      violations,
      [
        '聚焦瞬间会闪出实心描边：Tailwind 的 focus:outline-none 展开为 `outline: 2px solid transparent`',
        '（style=solid，仅颜色透明）。再叠加 transition-all，聚焦时 outline-style 当帧翻为 solid，',
        '而 outline-color 仍从 currentColor 过渡到 transparent，于是 150ms 内渲染出可见描边。',
        '修法：文本输入类删掉 focus:outline-none —— globals.css 的 input:focus-visible{outline:none} 会接管。',
      ].join('\n'),
    ).toEqual([])
  })

  it('护栏自检：合成反模式必须被命中（否则本护栏是恒绿摆设）', () => {
    const redJsx =
      '<input className="focus:outline-none transition-all focus:border-[var(--brand-primary)]" />'
    expect(findAntiPatterns(redJsx)).toEqual([1])

    // className 跨多行书写（首版逐行扫描正是漏在这里）
    const redMultiline = [
      '<textarea',
      '  className="w-full text-sm focus:outline-none',
      '             transition-all"',
      '/>',
    ].join('\n')
    expect(findAntiPatterns(redMultiline)).toEqual([2])

    // 变体链前缀（dark-all:focus:outline-none）
    const redVariant = '<input className="dark-all:focus:outline-none transition-all" />'
    expect(findAntiPatterns(redVariant)).toEqual([1])

    // focus-visible: 与 focus: 展开的是同一条声明（outline: 2px solid transparent），同样会闪
    expect(findAntiPatterns('<input className="focus-visible:outline-none transition-all" />')).toEqual([1])
    expect(findAntiPatterns('<input className="focus-visible:outline-2 transition-all" />')).toEqual([1])

    // 合法站点不得误伤
    expect(findAntiPatterns('<input className="focus:outline-none focus:border-[var(--brand-primary)]" />')).toEqual([])
    expect(findAntiPatterns('<input className="transition-all focus:border-[var(--border-emphasis)]" />')).toEqual([])
    // transition-colors / 裸 transition 的属性表不含 outline-color，不算反模式
    expect(findAntiPatterns('<input className="focus:outline-none transition-colors" />')).toEqual([])
    expect(findAntiPatterns('<input className="focus:outline-none transition" />')).toEqual([])
    // 无条件 outline-none 不翻 style，不算反模式
    expect(findAntiPatterns('<input className="outline-none transition-all" />')).toEqual([])
    // 注释里的反模式不算
    expect(findAntiPatterns('// 旧写法：focus:outline-none transition-all 会闪\nconst a = 1')).toEqual([])
  })
})
