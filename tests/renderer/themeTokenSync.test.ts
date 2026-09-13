// tests/renderer/themeTokenSync.test.ts
/**
 * 防复发护栏：内联 THEMES 表 ↔ globals.css 令牌同步
 *
 * 成因（本次 HIGH 缺陷）：主题令牌在四处被**手工复制** ——
 *   1. src/renderer/styles/globals.css                      （唯一权威，4 个主题块）
 *   2. src/renderer/index.html                              内联 THEMES / LIGHT_VARS
 *   3. src/renderer/dialogWindow.html                       内联 THEMES
 *   4. src/renderer/main_window/projectManager.html         内联 THEMES
 * 这三个 HTML 的 <head> 内联脚本用 `documentElement.style.setProperty()` 写令牌，
 * **内联样式优先级高于 globals.css 的类选择器**。因此只要内联表失同步，该窗口的令牌
 * 修复就完全失效 —— 本次就发生了「改了 globals.css + index.html，却漏了 3、4」。
 * 本测试即为防复发的守卫。
 *
 * 键集分两档：
 *   - `OWNED`（语义键）：要求**完备性**（4 个主题块 + 每个内联表都必须声明）且逐字符相等。
 *   - `BRAND_STATUS`（品牌 / 状态键）：只要求「凡声明即相等」。因为 `--brand-ink*` 在 `.dark`
 *     下有意缺失、`--brand-hover` 在 3 个子窗口的内联表里从未声明，完备性在此不成立。
 * 这组品牌/状态键曾长期漂移（26 处，例：dark 内联把浅色的 brand ramp 当成了深色值），
 * 表现为窗口首帧闪出另一种品牌色——现已全部收敛，不再豁免。
 *
 * 另有第三个不变量：凡被内联脚本 `setProperty` 写过的键，必须出现在 `lib/theme.ts` 的
 * `ROOT_CSS_VARS` 里，否则 `applyThemeClass()` 清理不掉它，内联值会**永久**压过 globals.css。
 * （`--brand-ink*` 本轮就曾漏在 ROOT_CSS_VARS 之外。）
 */
import {describe, it, expect} from 'vitest'
import {readFileSync, readdirSync} from 'fs'
import {join} from 'path'

/** 递归收集目录下所有 .ts/.tsx 源文件绝对路径 */
function walkSources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, {withFileTypes: true})) {
    const abs = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      walkSources(abs, out)
    } else if (/\.(ts|tsx)$/.test(e.name)) out.push(abs)
  }
  return out
}

const ROOT = process.cwd()
const CSS_PATH = join(ROOT, 'src/renderer/styles/globals.css')
const CSS = readFileSync(CSS_PATH, 'utf-8')

/** 四个主题块（CSS 选择器 → 主题名） */
const CSS_THEMES = [
  {selector: ':root', name: 'light'},
  {selector: '.dark', name: 'dark'},
  {selector: '.yuanshandai', name: 'yuanshandai'},
  {selector: '.shiyangjin', name: 'shiyangjin'},
] as const

/** 内联表主题名 → globals.css 主题名 */
const HTML_THEME_TO_CSS: Record<string, string> = {
  dark: 'dark',
  yuanshandai: 'yuanshandai',
  shiyangjin: 'shiyangjin',
}

/** LIGHT_VARS（亮色兜底）对应 globals.css 的 :root */
const LIGHT_VARS_CSS = 'light'

/** 本护栏拥有的语义键集合（要求完备性） */
const OWNED = [
  '--surface', '--surface-muted', '--surface-elevated', '--surface-overlay', '--surface-chrome',
  '--text-primary', '--text-secondary', '--text-muted',
  '--border', '--border-muted', '--border-emphasis',
  '--chip-bg', '--chip-border', '--track', '--track-strong',
] as const

/**
 * 品牌 / 状态键：不要求完备性，只要求「凡插内联声明即与 globals.css 相等」。
 * 见文件头说明——这组键曾整体漂移 26 处。
 */
const BRAND_STATUS = [
  '--brand-primary', '--brand-hover', '--brand-muted', '--brand-ink', '--brand-ink-hover',
  '--success', '--warning', '--error', '--info',
] as const

// ── globals.css 解析 ────────────────────────────────────────

/** 取出某个选择器对应的规则体（按大括号配平） */
function ruleBody(selector: string): string {
  const at = CSS.indexOf(selector + ' {')
  if (at === -1) throw new Error(`未找到规则: ${selector}`)
  const start = CSS.indexOf('{', at)
  let depth = 0
  for (let i = start; i < CSS.length; i++) {
    if (CSS[i] === '{') depth++
    else if (CSS[i] === '}') {
      depth--
      if (depth === 0) return CSS.slice(start + 1, i)
    }
  }
  throw new Error(`规则未闭合: ${selector}`)
}

/** 解析规则体里所有 `--name: value;` 声明 */
function parseCssVars(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /(--[\w-]+)\s*:\s*([^;]+);/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) out[m[1]] = m[2].trim()
  return out
}

// ── HTML 内联 THEMES 解析 ───────────────────────────────────

/** 取 `var <name> = { ... }` 的对象体（按大括号配平） */
function extractObjectBody(html: string, name: string): string | null {
  const at = html.indexOf(`var ${name} = {`)
  if (at === -1) return null
  const start = html.indexOf('{', at)
  let depth = 0
  for (let i = start; i < html.length; i++) {
    if (html[i] === '{') depth++
    else if (html[i] === '}') {
      depth--
      if (depth === 0) return html.slice(start + 1, i)
    }
  }
  return null
}

/** 解析 `'--key': 'value'` 键值对串 */
function parsePairs(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /'(--[\w-]+)'\s*:\s*'([^']*)'/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) out[m[1]] = m[2]
  return out
}

interface InlineTheme {
  file: string
  theme: string
  vars: Record<string, string>
}

/** 解析某个 HTML 的 THEMES 表 */
function parseThemes(file: string, html: string): InlineTheme[] {
  const body = extractObjectBody(html, 'THEMES')
  if (body === null) throw new Error(`${file}: 未找到内联 THEMES 对象`)
  const out: InlineTheme[] = []
  // 每条主题：'<name>': { ... vars: { <pairs> } }
  const re = /'([\w-]+)'\s*:\s*\{[^{}]*vars\s*:\s*\{([^{}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) out.push({file, theme: m[1], vars: parsePairs(m[2])})
  if (out.length === 0) throw new Error(`${file}: THEMES 解析出 0 个主题`)
  return out
}

/** 解析某个 HTML 的 LIGHT_VARS（可能不存在） */
function parseLightVars(file: string, html: string): InlineTheme | null {
  const body = extractObjectBody(html, 'LIGHT_VARS')
  if (body === null) return null
  return {file, theme: 'light', vars: parsePairs(body)}
}

/** 空白归一化（允许空格差异，不允许数值/字符差异） */
const norm = (v: string): string => v.replace(/\s+/g, '')

// ── 数据准备 ────────────────────────────────────────────────

const cssVars: Record<string, Record<string, string>> = {}
for (const {selector, name} of CSS_THEMES) cssVars[name] = parseCssVars(ruleBody(selector))

const HTML_FILES = [
  'src/renderer/index.html',
  'src/renderer/dialogWindow.html',
  'src/renderer/main_window/projectManager.html',
] as const

const inlineThemes: InlineTheme[] = []
const lightVarsList: InlineTheme[] = []
for (const rel of HTML_FILES) {
  const html = readFileSync(join(ROOT, rel), 'utf-8')
  inlineThemes.push(...parseThemes(rel, html))
  const lv = parseLightVars(rel, html)
  if (lv) lightVarsList.push(lv)
}

/** 逐键比对，返回可定位的失败项 */
function compare(
  file: string,
  theme: string,
  vars: Record<string, string>,
  css: Record<string, string>,
  keys: readonly string[] = OWNED,
): string[] {
  const problems: string[] = []
  for (const key of keys) {
    if (!(key in vars)) continue // 键存在性由「完备性」用例单独断言
    const actual = vars[key]
    const expected = css[key]
    if (expected === undefined) {
      problems.push(`${file} / ${theme} / ${key} / 期望 globals.css 有该键，但缺失 / 实际 ${actual}`)
      continue
    }
    if (norm(actual) !== norm(expected)) {
      problems.push(`${file} / ${theme} / ${key} / 期望 ${expected} / 实际 ${actual}`)
    }
  }
  return problems
}

// ── 测试 ────────────────────────────────────────────────────

describe('主题令牌同步护栏：globals.css 四主题块键完备性', () => {
  it(`4 个主题块必须声明 OWNED 的全部 ${OWNED.length} 个键`, () => {
    const missing: string[] = []
    for (const {selector, name} of CSS_THEMES) {
      for (const key of OWNED) {
        if (!(key in cssVars[name])) missing.push(`${selector} (${name}) / ${key}`)
      }
    }
    expect(missing, `globals.css 缺少以下 OWNED 键（需人工决策是否补齐）：\n${missing.join('\n')}`).toEqual([])
  })
})

describe('主题令牌同步护栏：内联 THEMES 与 globals.css 一致', () => {
  it(`每个 HTML 的每个主题都必须声明全部 ${OWNED.length} 个 OWNED 键`, () => {
    const missing: string[] = []
    for (const t of inlineThemes) {
      for (const key of OWNED) {
        if (!(key in t.vars)) missing.push(`${t.file} / ${t.theme} / ${key}`)
      }
    }
    expect(missing, `内联 THEMES 缺少以下 OWNED 键：\n${missing.join('\n')}`).toEqual([])
  })

  it('每个 HTML 的每个主题，凡声明的 OWNED 键，值必须与 globals.css 逐字符相等', () => {
    const problems: string[] = []
    for (const t of inlineThemes) {
      const cssTheme = HTML_THEME_TO_CSS[t.theme]
      expect(cssTheme, `${t.file} / ${t.theme}: 未知主题名`).toBeDefined()
      problems.push(...compare(t.file, t.theme, t.vars, cssVars[cssTheme]))
    }
    expect(problems, `内联 THEMES 与 globals.css 失同步（文件 / 主题 / 键 / 期望 / 实际）：\n${problems.join('\n')}`).toEqual([])
  })

  it('LIGHT_VARS（如声明）与 globals.css :root 一致', () => {
    const problems: string[] = []
    for (const lv of lightVarsList) {
      problems.push(...compare(lv.file, lv.theme, lv.vars, cssVars[LIGHT_VARS_CSS]))
    }
    expect(problems, `LIGHT_VARS 与 :root 失同步：\n${problems.join('\n')}`).toEqual([])
  })

  it('结构自检：至少解析到 9 个主题（3 文件 × 3 主题）', () => {
    expect(inlineThemes).toHaveLength(9)
  })
})

describe('主题令牌同步护栏：内联品牌/状态键与 globals.css 一致', () => {
  it(`凡内联声明的品牌/状态键（${BRAND_STATUS.length} 个），值必须与 globals.css 逐字符相等`, () => {
    const problems: string[] = []
    for (const t of inlineThemes) {
      const cssTheme = HTML_THEME_TO_CSS[t.theme]
      expect(cssTheme, `${t.file} / ${t.theme}: 未知主题名`).toBeDefined()
      problems.push(...compare(t.file, t.theme, t.vars, cssVars[cssTheme], BRAND_STATUS))
    }
    expect(problems, `内联品牌/状态键与 globals.css 失同步（文件 / 主题 / 键 / 期望 / 实际）：\n${problems.join('\n')}`).toEqual([])
  })

  it('自检：这组键确实被内联表声明过（防止键集写错导致空跑）', () => {
    const declared = new Set<string>()
    for (const t of inlineThemes) for (const k of Object.keys(t.vars)) declared.add(k)
    const covered = BRAND_STATUS.filter(k => declared.has(k))
    expect(covered.length, 'BRAND_STATUS 与内联表完全无交集，用例在空跑').toBeGreaterThanOrEqual(5)
  })
})

describe('主题令牌同步护栏：内联写过的键必须能被 applyThemeClass 清理', () => {  it('凡出现在任一内联 THEMES / LIGHT_VARS 的键，必须在 lib/theme.ts 的 ROOT_CSS_VARS 中', () => {
    const themeTs = readFileSync(join(ROOT, 'src/renderer/lib/theme.ts'), 'utf-8')
    const m = themeTs.match(/const ROOT_CSS_VARS = \[([\s\S]*?)\]/)
    expect(m, '未在 lib/theme.ts 中找到 ROOT_CSS_VARS 数组').toBeTruthy()
    const rootCssVars = [...m![1].matchAll(/'([^']+)'/g)].map(x => x[1])
    const leaked = new Set<string>()
    for (const t of [...inlineThemes, ...lightVarsList]) {
      for (const key of Object.keys(t.vars)) {
        if (!rootCssVars.includes(key)) leaked.add(`${key}  ← ${t.file} / ${t.theme}`)
      }
    }
    expect(
      [...leaked],
      'HTML 内联脚本用 setProperty 写了这些键，但 ROOT_CSS_VARS 里没有 → applyThemeClass() 永远清理不掉，内联值会永久压过 globals.css：\n' +
        [...leaked].join('\n'),
    ).toEqual([])
  })
})

describe('主题令牌同步护栏：ROOT_CSS_VARS 唯一权威（不得有第二份副本）', () => {
  it('除 lib/theme.ts 外，任何源文件都不得再声明一份「内联变量清理清单」', () => {
    // 历史事故：App.tsx 复制了一份清单且漏掉 7 个键（含 --surface-chrome），
    // 结果 index.html 的浅色首帧内联值被 inline 优先级永久钉住，
    // dark / yuanshandai 下两条侧栏永远显示浅色 #f6f7f9。
    // 上面的「必须能被清理」用例只看 theme.ts，抓不到副本 —— 本用例补上。
    const offenders: string[] = []
    for (const abs of walkSources(join(ROOT, 'src'))) {
      const rel = abs.slice(ROOT.length + 1).replace(/\\/g, '/')
      if (rel === 'src/renderer/lib/theme.ts') continue
      const src = readFileSync(abs, 'utf-8')
      // 同文件里既有 removeProperty 循环，又有令牌清单字面量 ⇒ 极可能是副本
      if (/removeProperty/.test(src) && /'--surface-overlay'/.test(src)) offenders.push(rel)
    }
    expect(
      offenders,
      '以下文件疑似复制了 ROOT_CSS_VARS 清单。请改为 import {applyThemeClass} from <path>/lib/theme，' +
        '否则漏键会让内联值永久压过 globals.css：\n' + offenders.join('\n'),
    ).toEqual([])
  })

  it('自检：扫描器确实覆盖到了 src/ 下的源码（防止 walk 写错导致空跑）', () => {
    expect(walkSources(join(ROOT, 'src')).length).toBeGreaterThan(100)
  })
})

describe('主题标识护栏：ThemeName 唯一权威（不得再手写主题名清单）', () => {
  // 与 --surface-chrome 事故同型：主题名散成多份 → 新增主题时漏改某处，
  // 类型检查通过但该窗口静默停在旧主题。唯一权威 = src/shared/types/theme.ts
  const AUTH = 'src/shared/types/theme.ts'
  const PATTERNS: Array<[string, RegExp]> = [
    // 注意必须写满四个名字：`'light' | 'dark'` 单独也在用，那是**系统明暗轴**
    // （BrowserWindow backgroundColor / titleBarOverlay colorScheme），与主题名无关，不能拦
    ['手写主题名联合类型', /'light'\s*\|\s*'dark'\s*\|\s*'yuanshandai'/],
    ['四主题字面量数组', /\[\s*'light'\s*,\s*'dark'/],
    ['深色主题字面量数组', /\[\s*'dark'\s*,\s*'yuanshandai'/],
  ]

  it(`除 ${AUTH} 外，任何 .ts/.tsx 都不得再手写主题名清单`, () => {
    const offenders: string[] = []
    for (const abs of walkSources(join(ROOT, 'src'))) {
      const rel = abs.slice(ROOT.length + 1).replace(/\\/g, '/')
      if (rel === AUTH) continue
      const src = readFileSync(abs, 'utf-8')
      for (const [label, re] of PATTERNS) {
        if (re.test(src)) offenders.push(`${rel}  ← ${label}`)
      }
    }
    expect(
      offenders,
      `以下文件重写了主题名清单，请改为从 @shared/types 引入 (ThemeName / THEME_NAMES / DARK_THEMES)：\n` +
        offenders.join('\n'),
    ).toEqual([])
  })

  it('自检：模式本身可用（对样例文本能命中，防止正则写错导致空跑）', () => {
    const sample = [
      "type T = 'light' | 'dark' | 'yuanshandai' | 'shiyangjin'",
      "const A = ['light', 'dark', 'yuanshandai', 'shiyangjin']",
      "const D = ['dark', 'yuanshandai']",
    ].join('\n')
    for (const [label, re] of PATTERNS) {
      expect(re.test(sample), `模式「${label}」连样例都匹配不到`).toBe(true)
    }
  })

  it('自检：权威文件仍声明主题名与深色集合（防止排除项名不副实）', () => {
    const auth = readFileSync(join(ROOT, AUTH), 'utf-8')
    expect(auth).toMatch(/THEME_NAMES\s*=/)
    expect(auth).toMatch(/DARK_THEMES\s*:/)
    for (const n of ['light', 'dark', 'yuanshandai', 'shiyangjin']) expect(auth).toContain(`'${n}'`)
  })
})
