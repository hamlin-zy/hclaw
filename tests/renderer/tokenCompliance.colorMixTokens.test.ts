// tests/renderer/tokenCompliance.colorMixTokens.test.ts
/**
 * 防复发护栏：`color-mix()` 站点引用的 `var(--token)` 必须**真实存在**。
 *
 * 成因（与 VAR_OPACITY 同族的事故）：Tailwind 允许把任意 `color-mix(...)` 写进任意值类名
 * 并**正常编译**——它不校验 `var(--x)` 里的令牌名是否存在。运行时若 `--x` 解析失败，
 * 整条 `color-mix` 成为非法值 → 该声明被浏览器**静默丢弃**：无控制台报错、无红灯，
 * 只有「样式没生效」这一现象（死样式）。现有 alpha 阶梯护栏只校验 color-mix 的
 * 「形态」与「档位」，**不看令牌名**，故 `bg-[color-mix(in_srgb,var(--unknown-token)_10%,transparent)]`
 * 能从它眼皮底下通过。本规则补上这一维。
 *
 * 与 alpha 阶梯护栏的分工（为何另起一个文件而非塞进 capabilityPages）：
 *   ① tokenCompliance.capabilityPages.test.ts 已约 1500 行、章程已溢出（独立复核已就此立任务），
 *      **不得再往里加规则**；
 *   ② 本规则属「令牌有效性」一族，与 alpha 阶梯（档位守恒）是不同的章程，混在一起会同时
 *      污染两套不变量。
 *
 * ── 作用域声明（如实描述，勿夸大）──
 *   - 只覆盖**规范形态**的 color-mix 站点（即 `parseColorMix` 能解析的那些：`in_srgb + var(--token) + 整数% + transparent|black`）。
 *     非规范形态（大小写变体、非常规参数、非阶梯用途等）已由 `canonicalColorMixViolations()` 的
 *     形态白名单判红，本规则**不重复**覆盖，也**不**为其兜底。
 *   - `style={{}}` 内联样式块里的 color-mix **不在**本规则作用域（既有 GAP 已登记）。
 *   - 只校验令牌的**存在性**，不校验取值的主题一致性——后者是 themeTokenSync.test.ts 的职责。
 *
 * ── 键集为何是三源并集 ──
 *   本规则要回答的是「这个令牌名在仓库里**真实存在**吗」，而不是「它是否由 globals.css 定义」。
 *   若只取 globals.css（唯一权威定义源），会把两类**合法**令牌冤枉成违规：
 *     a) 仅由窗口 HTML 内联主题表 `setProperty()` 声明、globals.css 未定义的键；
 *     b) 仅出现在 lib/theme.ts `ROOT_CSS_VARS`（applyThemeClass 负责清理的键）里的键。
 *   故取三源并集：globals.css 声明键 ∪ 各 HTML 内联主题表键 ∪ ROOT_CSS_VARS 键。
 *   注意：**只用「存在性」正则提取键**，不解析规则体/取值——那是 themeTokenSync.test.ts 的职责，
 *   此处刻意保持最简，避免与它重复实现 ruleBody / parseCssVars / extractObjectBody。
 */
import {describe, it, expect} from 'vitest'
import {readFileSync} from 'fs'
import {join} from 'path'
import {isComment, parseColorMix, scanColorMix, stripAllComments, walkSourceFiles, type ColorMixSite} from './helpers/tokenScan'

const ROOT = process.cwd()
const CSS_PATH = 'src/renderer/styles/globals.css'
const THEME_TS = 'src/renderer/lib/theme.ts'

/** globals.css 声明键：`--x:` */
const CSS_KEY = /(--[\w-]+)\s*:/g
/** 窗口 HTML 内联主题表键：`'--x':`（对象字面量的带引号键） */
const INLINE_KEY = /'(--[\w-]+)'\s*:/g
/**
 * lib/theme.ts 里 `ROOT_CSS_VARS = [ ... ]` 的区间（取最短配对的 `[`…`]`）。
 *
 * 为何先框区间：文件头的键集口径是「ROOT_CSS_VARS 数组里的键」，而单跑 `'--x'` 全文匹配比这宽
 * ——注释、别的字符串、别的数组里的任何 `'--x'` 字面量都会被当成合法令牌，等于给键集开后门。
 * 区间若因写法变动匹配不到（取到 0 键），由「真实源接线」用例里的区间命中断言兜住。
 */
const ROOT_CSS_VARS_BLOCK = /ROOT_CSS_VARS\s*=\s*\[([\s\S]*?)\]/
/** 上述区间内的键：`'--x'` */
const ROOT_VAR_KEY = /'(--[\w-]+)'/g

/** 提取全部键（克隆正则，避免 g 状态跨调用残留）。 */
const keysIn = (src: string, re: RegExp): string[] => [...src.matchAll(new RegExp(re))].map(m => m[1])

/** 从 theme.ts 源取 ROOT_CSS_VARS 区间的键；区间匹配不到 → 空数组（由断言兜底，不静默回退全文）。 */
const rootVarKeysIn = (src: string): string[] => {
  const block = src.match(ROOT_CSS_VARS_BLOCK)
  return block ? keysIn(block[1], ROOT_VAR_KEY) : []
}

/**
 * 键集构造（纯函数，便于用合成输入证明「并集」语义）。
 * 现实仓库中三源当前恰好被 globals.css 全覆盖（union === globals 键数），
 * 但语义上必须并集——见文件头「键集为何是三源并集」。
 */
function collectTokenKeys(cssSrc: string, htmlSrcs: readonly string[], themeSrc: string): Set<string> {
  const keys = new Set<string>()
  // 三处提键前**先按方言剥离注释**（F1）。不剥离的后果：注释里的假键会入集，
  // 于是「把一条废弃声明注释掉」这一日常重构动作即可凭空造出令牌、放行引用它的站点
  // ——本护栏「令牌必须真实存在」的核心保证被静默绕过（实测可复现）。
  for (const k of keysIn(stripAllComments(cssSrc, 'css'), CSS_KEY)) keys.add(k)
  for (const h of htmlSrcs) for (const k of keysIn(stripAllComments(h, 'html'), INLINE_KEY)) keys.add(k)
  for (const k of rootVarKeysIn(stripAllComments(themeSrc, 'ts'))) keys.add(k)
  return keys
}

/**
 * 规则本体：站点引用的令牌不在键集内即违规；整行注释内的站点不算（注释掉的代码不是活样式）。
 * 大小写敏感：CSS 自定义属性名大小写敏感，`--BAND-PRIMARY` 与 `--brand-primary` 不是同一个键。
 */
function tokenViolations(sites: readonly ColorMixSite[], keys: ReadonlySet<string>): string[] {
  return sites
    .filter(s => !isComment(s))
    .filter(s => !keys.has(`--${s.token}`))
    .map(
      s =>
        `${s.file}:${s.line}: color-mix 引用了不存在的令牌 --${s.token}` +
        `（该 var() 解析失败会让整条声明被静默丢弃）: ${s.text.trim()}`,
    )
}

// ── F2：跨行块注释体内的站点过滤（深度只在**本文件**维护，不动共享扫描器）──

/**
 * 源内「有活代码」的行号集合（块注释体外至少含一个非注释字符的行）。
 *
 * 为什么需要：`isComment` 只认行首（`//` / `*` / `/*`），`stripBlockComments` 又是逐行的——
 * 跨行块注释**体内**的一行站点（不以 `*` 开头）既非整行注释、也不含可剥的行内注释片段，
 * 于是被当成活站点判违规并虚高站点计数，与文件头「注释掉的代码不是活样式」自相矛盾。
 *
 * 为何只在本文件修：`stripBlockComments` / `isComment` 是共享扫描器（PM 护栏与能力页护栏共用），
 * 改其既有行为会波及那两条护栏，超出本任务范围。
 * 精度：按字符跟踪深度，行中途块注释收尾后仍有代码的行**算活行**（不会过滤过头）。
 */
function liveLinesOf(src: string): Set<number> {
  const live = new Set<number>()
  let depth = 0
  let line = 1
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (ch === '\n') {
      line++
      continue
    }
    if (depth > 0) {
      if (ch === '*' && src[i + 1] === '/') {
        depth--
        i++
      }
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      depth++
      i++
      continue
    }
    live.add(line)
  }
  return live
}

// ── 真实仓库的输入与产出 ─────────────────────────────────────────

const RENDERER_FILES = walkSourceFiles('src/renderer')
const HTML_FILES = RENDERER_FILES.filter(f => f.endsWith('.html'))

/** 真实源原文（保留注释态，供 M0/M2 的注释注入红绿灯证明复用）。 */
const RAW_CSS = readFileSync(join(ROOT, CSS_PATH), 'utf-8')
const RAW_HTML = HTML_FILES.map(f => readFileSync(join(ROOT, f), 'utf-8'))
const RAW_THEME = readFileSync(join(ROOT, THEME_TS), 'utf-8')

const KEY_SET = collectTokenKeys(RAW_CSS, RAW_HTML, RAW_THEME)

// LIVE_LINES / liveSites 依赖上方 RENDERER_FILES，故声明在此处（勿上移）。

/** 每个源文件的「活行」集合（键与 site.file 同口径：仓库相对路径、/ 分隔）。 */
const LIVE_LINES: ReadonlyMap<string, ReadonlySet<number>> = new Map(
  RENDERER_FILES.map(f => [f, liveLinesOf(readFileSync(join(ROOT, f), 'utf-8'))]),
)

/** 丢掉落在跨行块注释体内的站点；未知文件（默认不丢，宁可多报也不静默吞掉）。 */
const liveSites = (
  sites: readonly ColorMixSite[],
  liveByFile: ReadonlyMap<string, ReadonlySet<number>> = LIVE_LINES,
): ColorMixSite[] => sites.filter(s => liveByFile.get(s.file)?.has(s.line) ?? true)

const SITES = liveSites(scanColorMix(RENDERER_FILES))

/** 构造一个规范形态的 color-mix 行，供自检喂字符串。 */
const line = (token: string) => `<a className="bg-[color-mix(in_srgb,var(--${token})_10%,transparent)]" />`

describe('tokenCompliance.colorMixTokens — 键集（三源并集）', () => {
  it('键集规模达标且含已知键（防键集解析写错导致规则空转）', () => {
    // 现约 118（globals.css 声明键数）。下界取 105（约 89%）而非精确值：
    // 本断言的目的是「解析器退化 → 键集塌成 0」这类空转，而不是冻结令牌总数——
    // 钉在精确值会让一次合法的令牌删除报出「解析退化」这种误导性诊断。
    expect(KEY_SET.size).toBeGreaterThanOrEqual(105)
    for (const k of ['--brand-primary', '--border', '--text-muted', '--error', '--warning', '--success', '--info', '--surface-elevated', '--surface-muted']) {
      expect(KEY_SET.has(k), `键集应含 ${k}`).toBe(true)
    }
  })

  it('并集语义：仅内联声明的键、仅 ROOT_CSS_VARS 的键都被纳入（防退化成「只取 globals.css」）', () => {
    // 合成输入：三个源各自贡献一个独占键，任何一个源被漏掉都会在该键上失败。
    const synthetic = collectTokenKeys(
      ':root { --only-in-css: #000; }',
      ["<script>const T={'--only-in-html': '#000'}</script>"],
      "export const ROOT_CSS_VARS = ['--only-in-root']",
    )
    expect(synthetic.has('--only-in-css')).toBe(true)
    expect(synthetic.has('--only-in-html')).toBe(true)
    expect(synthetic.has('--only-in-root')).toBe(true)

    // 且这三个「合法」令牌经规则本体判定后**不得**产出违规（不误伤）。
    const sites = parseColorMix(line('only-in-html'), 'self.tsx', 1).concat(
      parseColorMix(line('only-in-root'), 'self.tsx', 2),
    )
    expect(tokenViolations(sites, synthetic)).toEqual([])
  })
})

describe('tokenCompliance.colorMixTokens — 键集：先剥注释再提键（F1）', () => {
  /**
   * 修前红灯实录：键集直接跑在原始全文上，注释里的假键会入集。
   * 后果不是「多几个无关键」，而是**核心保证被击穿**——把一条废弃声明注释掉（日常重构动作）
   * 即可凭空造出令牌，引用它的站点全部放行。以下三条按方言覆盖该路径。
   */
  it('css：块注释（跨行）里的假键不入集，正常声明仍入集', () => {
    const truthy = collectTokenKeys(':root { --real-css: #000; }', [], '')
    expect(truthy.has('--real-css'), '剥离不得过头：正常声明必须仍入集').toBe(true)

    const injected = collectTokenKeys(
      ':root { --real-css: #000; }\n/* 已废弃（跨行）:\n   --fake-css: #000\n*/',
      [],
      '',
    )
    expect(injected.has('--fake-css')).toBe(false)
    expect(injected.has('--real-css')).toBe(true)
    // 且该假键经规则本体判定时**确实**判违规（证明「入集/不入集」是唯一致命差异）
    expect(tokenViolations(parseColorMix(line('fake-css'), 'self.tsx', 1), injected)).toHaveLength(1)
  })

  it('html：HTML 注释与行首 `//` 里的假键不入集，内联主题表正常键仍入集', () => {
    const html = [
      '<script>',
      "const T = {'--real-html': '#000'}",
      '// 已废弃 --fake-html-line: #000',
      '</script>',
      "<!-- 已废弃: '--fake-html': '#000' -->",
    ].join('\n')
    const keys = collectTokenKeys('', [html], '')
    expect(keys.has('--real-html'), '剥离不得过头：内联主题表正常键必须仍入集').toBe(true)
    expect(keys.has('--fake-html')).toBe(false)
    expect(keys.has('--fake-html-line')).toBe(false)
  })

  it('ts：ROOT_CSS_VARS 区间内的注释假键不入集，数组内正常键仍入集；且不全局剥 `//`', () => {
    const ts = [
      'export const ROOT_CSS_VARS = [',
      "  '--real-ts',",
      "  // 已废弃 '--fake-ts-line'",
      '  /*',
      "    已废弃（跨行）'--fake-ts-block'",
      '  */',
      ']',
    ].join('\n')
    const keys = collectTokenKeys('', [], ts)
    expect(keys.has('--real-ts'), '剥离不得过头：数组内正常键必须仍入集').toBe(true)
    expect(keys.has('--fake-ts-line')).toBe(false)
    expect(keys.has('--fake-ts-block')).toBe(false)
    // ts 方言**不**全局剥 `//`：全局剥会把 URL / 字符串里的 `//` 一并砍掉，反而截断出假键
    expect(stripAllComments('const ws = "ws://localhost/x"', 'ts')).toContain('ws://localhost/x')
    // 行首 `//` 则必须被剥（与 isComment 的边界一致）
    expect(stripAllComments('  // x', 'ts').trim()).toBe('')
  })
})


describe('tokenCompliance.colorMixTokens — 规则本体', () => {
  it('非恒真：引用不存在的令牌 / 大小写变体 → 判违规', () => {
    const unknown = parseColorMix(line('unknown-token'), 'self.tsx', 1)
    const notAToken = parseColorMix(line('not-a-token'), 'self.tsx', 2)
    // 大小写变体：--BAND-PRIMARY 与 --brand-primary 不是同一个键（CSS 自定义属性名大小写敏感）
    const caseVariant = parseColorMix(line('BAND-PRIMARY'), 'self.tsx', 3)
    expect(tokenViolations(unknown, KEY_SET)).toHaveLength(1)
    expect(tokenViolations(notAToken, KEY_SET)).toHaveLength(1)
    expect(tokenViolations(caseVariant, KEY_SET)).toHaveLength(1)
    expect(tokenViolations(caseVariant, KEY_SET)[0]).toContain('--BAND-PRIMARY')
  })

  it('不误伤：合法令牌（含仅内联声明 / 仅 ROOT_CSS_VARS 的键）→ 零违规', () => {
    const legal = parseColorMix(line('brand-primary'), 'self.tsx', 1)
    expect(tokenViolations(legal, KEY_SET)).toEqual([])
    const unionLegal = parseColorMix(line('only-in-html'), 'self.tsx', 2).concat(
      parseColorMix(line('only-in-root'), 'self.tsx', 3),
    )
    const synthetic = collectTokenKeys('', ["{'--only-in-html': 1}"], "export const ROOT_CSS_VARS = ['--only-in-root']")
    expect(tokenViolations(unionLegal, synthetic)).toEqual([])
  })
})

describe('tokenCompliance.colorMixTokens — 跨行块注释内的站点（F2）', () => {
  /**
   * 修前红线：`isComment` 只认行首（`//` / `*` / `/*`），跨行块注释**体内**的一行站点
   * （不以 `*` 开头）既非整行注释、也无行内注释片段可剥 → 被当成活站点判违规并虚高站点计数。
   * 文件头已声明「注释掉的代码不是活样式」，两者自相矛盾。
   */
  it('块注释体内的站点不判违规；块注释外同一写法仍判违规（防过滤过头）', () => {
    const src = [
      '/* 旧样式（已注释）：',
      `<a className="bg-[color-mix(in_srgb,var(--${'unknown-token'})_10%,transparent)]" />`,
      '*/',
      `<a className="bg-[color-mix(in_srgb,var(--${'unknown-token'})_10%,transparent)]" />`,
    ].join('\n')

    const raw = src.split('\n').flatMap((l, i) => parseColorMix(l, 'self.tsx', i + 1))
    // 两条都被解析出来（解析器不认识块注释）→ 不过滤时两条都判违规（红线）
    expect(raw).toHaveLength(2)
    expect(tokenViolations(raw, KEY_SET)).toHaveLength(2)

    const live = liveSites(raw, new Map([['self.tsx', liveLinesOf(src)]]))
    // 过滤后只剩块注释外那条；块注释内的那条不再虚报（站点计数同步修正）
    expect(live).toHaveLength(1)
    expect(live[0].line).toBe(4)
    const v = tokenViolations(live, KEY_SET)
    expect(v).toHaveLength(1)
    expect(v[0]).toContain(':4:')
  })

  it('真实性：过滤只删「落在块注释体内」的站点（删掉的每一条都可复算）', () => {
    // `?? true` 的未知文件兜底：宁可多报，也不静默吞掉整个文件的站点
    const orphan = parseColorMix(line('brand-primary'), 'nowhere.tsx', 1)
    expect(liveSites(orphan, new Map())).toHaveLength(1)

    const all = scanColorMix(RENDERER_FILES)
    expect(all.length).toBeGreaterThanOrEqual(SITES.length) // 过滤只删不增
    // 按 file:line 比对（站点对象每次扫描都是新实例，不能按引用比）
    const kept = new Set(SITES.map(s => `${s.file}:${s.line}`))
    const dropped = all.filter(s => !kept.has(`${s.file}:${s.line}`))
    // 被删的每一条都必须**确实**落在跨行块注释体内（复算同一口径，防「删过头」）
    for (const s of dropped) {
      const live = liveLinesOf(readFileSync(join(ROOT, s.file), 'utf-8'))
      expect(live.has(s.line), `${s.file}:${s.line} 不在块注释体内却被删`).toBe(false)
    }
  })
})

describe('tokenCompliance.colorMixTokens — 真实源接线（F3）', () => {
  /**
   * 为何要这组断言：键集是三源并集，而**当前并集恰好等于 globals.css 的 118 个键**
   * ——HTML 源或 theme 源若静默失连（读文件失败、过滤写错、区间正则匹配到 0 条），
   * 并集规模**不变**、全绿。:96 的合成用例只证明函数逻辑，不证明真实文件被读入。
   */
  it('HTML 与 theme.ts 各自被实际读入并产出足量键（防「源静默失连」）', () => {
    // 下界口径：三个窗口入口 HTML 的**去重**内联键现为 25；theme.ts 的 ROOT_CSS_VARS 现为 25。
    // 取 20（约 80%）留余量：允许后续合法增删，但任何「读到 0 条」的清空式退化都会跌破。
    expect(HTML_FILES.length).toBeGreaterThanOrEqual(3)
    const htmlKeys = new Set(RAW_HTML.flatMap(h => keysIn(stripAllComments(h, 'html'), INLINE_KEY)))
    expect(htmlKeys.size).toBeGreaterThanOrEqual(20)

    const themeKeys = rootVarKeysIn(stripAllComments(RAW_THEME, 'ts'))
    expect(themeKeys).toHaveLength(new Set(themeKeys).size) // 无重复键（重复说明区间截错）
    expect(themeKeys.length).toBeGreaterThanOrEqual(20)

    // ROOT_CSS_VARS 区间正则必须**真的命中**（匹配到 0 条会让上方断言以「失连」之名报错，
    // 这里单独点名区间正则本身，避免诊断指向错处）
    expect(ROOT_CSS_VARS_BLOCK.test(RAW_THEME), 'ROOT_CSS_VARS 区间正则应命中 theme.ts').toBe(true)

    // 三源并集：并集 ⊇ 各源（真实文件上，而非合成输入）
    for (const k of htmlKeys) expect(KEY_SET.has(k), `HTML 源键 ${k} 应入并集`).toBe(true)
    for (const k of themeKeys) expect(KEY_SET.has(k), `theme 源键 ${k} 应入并集`).toBe(true)
  })
})

describe('tokenCompliance.colorMixTokens — 扫描集与存量', () => {
  it('扫描集非空且达标（防目录写错 / 遍历失效导致规则空转）', () => {
    expect(RENDERER_FILES.length).toBeGreaterThan(0)
    // 现存 222 个站点（全仓 src/renderer 规范形态）；下界取 200（约 10% 余量），
    // 允许后续重构小幅增删站点，同时任何「扫不到」的整体退化都会跌破。
    expect(SITES.length).toBeGreaterThanOrEqual(200)
  })

  it('存量零违规（键集规模 / 站点数 / 违规数）', () => {
    const v = tokenViolations(SITES, KEY_SET)
    // eslint-disable-next-line no-console
    console.log(`[color-mix tokens] 键集=${KEY_SET.size} 站点=${SITES.length} 违规=${v.length}`)
    expect(v).toEqual([])
  })
})
