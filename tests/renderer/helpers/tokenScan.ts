// tests/renderer/helpers/tokenScan.ts
/**
 * 令牌合规护栏的公共扫描器。
 *
 * 为什么抽出来？
 *   project-manager/tokenCompliance.test.ts 与 tokenCompliance.capabilityPages.test.ts 关注的是
 *   不同的目录树、各有各的文件清单与豁免策略；但「反模式长什么样」这件事只能有一个定义，
 *   否则两条护栏会各自漂移。故把纯正则常量与逐行扫描原语收在这里，两侧共用。
 *
 * 共享边界（如实描述，勿夸大）：
 *   - **双消费者**：`BARE_HEX` / `isComment` / `scan` / `violations` / `describeHit` / `Hit`——
 *     PM 护栏与能力页护栏都 import。
 *   - **单消费者**：`color-mix` 解析器一族（`COLOR_MIX` / `parseColorMix` / `scanColorMix` /
 *     `colorMixRole` / alpha 形态校验）目前**只有** tokenCompliance.capabilityPages.test.ts 在用。
 *     放在这里是因为它随后续任务可能长出第二个消费者，但**当下不是**「已双消费者」；
 *     后来者别误以为改它天然受两条护栏保护——它只被一条护栏覆盖。
 *
 * 不在这里的东西：文件清单、豁免谓词、alpha 白名单。那些是每个护栏**自己的策略**，故意不共享。
 */
import {readFileSync, readdirSync, statSync} from 'fs'
import {join, relative} from 'path'

export interface Hit {
  /** 仓库相对路径（/ 分隔），便于报错直接跳转 */
  file: string
  line: number
  /** 原始行文本（保留前导空白与行首注释符，供注释判定使用） */
  text: string
}

/** 裸 hex 颜色字面值 */
export const BARE_HEX = /#[0-9a-fA-F]{3,8}\b/
/** 函数式颜色字面值 */
export const RGB_HSL = /\b(?:rgba?|hsla?)\(/
/** `var(--x, #hex)` / `var(--x, rgb(...))` / `var(--x, hsl(...))` 兜底写法 */
export const VAR_FALLBACK = /var\(\s*--[\w-]+\s*,\s*(?:#|rgba?\(|hsla?\()/
/**
 * Tailwind 3.4 无法编译的「var() + 不透明度」写法（`bg-[var(--x)]/80`）。
 * 机制：withAlphaVariable 的 parseColor 只认 hex/rgb/hsl，var() 返回 null → 整条 utility 被省略。
 * 全仓已统一改写为 `[color-mix(in_srgb,var(--x)_NN%,transparent)]`（实测可编译），
 * 故在 capabilityPages 护栏里对**全量 src/renderer** 强制命中数 = 0。
 * 复评触发点 = 升级 Tailwind v4（届时任意色值的 `/NN` 重新可用）。
 *
 * 形态覆盖（同族同命，均零产出）：
 *   `[var(--x)]/80`、`[var(--x)]/[0.5]`、`[var(--x)]/[.3]`、
 *   `text-[color:var(--x)]/50`（可选 `color:` 类型前缀）、
 *   `bg-[var(--x,transparent)]/50`（带兜底值的 var()）。
 * 刻意**不**命中 `bg-[color-mix(in_srgb,var(--x)_10%,transparent)]`——那是本规则要求的正确写法。
 */
export const VAR_OPACITY = /\[\w*:?var\(--[\w-]+(?:\s*,[^)]+)?\)\]\/[\[.\d]/

/** 仓库相对路径（统一 / 分隔） */
export const rel = (f: string) => relative(process.cwd(), f).replace(/\\/g, '/')

/**
 * 整行注释判定：该**行首**是否为 `//`、块注释的 `*` 或块注释开头，或 JSX 花括号注释的开头
 * （形如 `{` 紧跟一个块注释）。遍历用原始行文本，不能用 trim 后的串。
 *
 * 如实描述其能力边界（勿夸大）：
 *   - 只认**行首**。行内 / 行尾的行内注释（如 `<Foo/>` 后紧跟一个花括号块注释）**不由本函数识别**，
 *     那类误报改由 color-mix 一族在扫描前 `stripBlockComments()` 剔除注释片段解决。
 *   - JSX 花括号注释只匹配**起始**形态（`{` + 块注释开头），正则**不校验**结尾的 `}`；
 *     多行 JSX 注释的后续行（既不以上述任一前缀开头）**不被识别**，会被当作普通代码行。
 */
export const isComment = (h: Hit) => /^\s*(\/\/|\*|\/\*|\{\s*\/\*)/.test(h.text)

/**
 * 剥掉一行内的块注释片段，含 JSX 花括号注释的注释体。
 * 用途：`isComment` 只认行首，行内 / 行尾注释（`<Foo/>` 后的花括号注释，内含 color-mix）
 * 会漏过它；color-mix 一族在解析前先剥掉注释片段即可避免这类误报。
 * 注意：逐行处理，跨行的块注释（开始标记与结束标记各占一行）不会被完整剥离——
 * 其后的代码行仍按普通行处理（与 isComment 的边界一致）。
 */
export const stripBlockComments = (line: string): string => line.replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * 剥离**全文**注释（跨行），供「先剥离、再提取」的键集 / 键名提取使用（追加导出，勿动上方原语）。
 *
 * 为什么需要它：提取键名的正则（`--x:` / `'--x':`）若直接跑在原始全文上，**注释里的假键也会入集**。
 * 把一条废弃声明注释掉是日常重构动作，而它即可凭空造出一个并不存在的令牌，
 * 让引用该令牌的站点被放行——「令牌必须真实存在」这条核心保证被静默绕过（实测可复现）。
 * 故提取前必须按方言剥离注释。
 *
 * 方言差异（勿统一成一套，会误伤）：
 *   - `css`：只剥 `/* ... *​/`（跨行）。CSS 无行注释。
 *   - `html`：剥 `<!-- ... -->`（跨行）+ `/* ... *​/`（内联 `<style>` / `<script>`）+ 行首 `//`。
 *   - `ts`：剥 `/* ... *​/`（跨行）+ **行首** `//`。
 *     **不**全局剥 `//`：那会把 `ws://` / `https://` 这类 URL 与字符串里的 `//` 一并砍掉，
 *     反而截断出新的假键。行首判定与 `isComment` 的边界一致。
 *
 * 与 `stripBlockComments` 的分工：后者是**逐行**原语（供逐行扫描剥行内注释片段），
 * 本函数是**整源**方言感知剥离（供「整源提取」前的一次性预处理）。二者并存，勿互相替代。
 */
export function stripAllComments(src: string, dialect: 'css' | 'html' | 'ts'): string {
  let out = src
  if (dialect === 'html') out = out.replace(/<!--[\s\S]*?-->/g, '')
  out = out.replace(/\/\*[\s\S]*?\*\//g, '')
  if (dialect !== 'css') out = out.replace(/^[ \t]*\/\/.*$/gm, '')
  return out
}

export const describeHit = (h: Hit) => `${h.file}:${h.line}: ${h.text.trim()}`

/**
 * 逐行扫描给定文件，命中就记录 file:line: 原文。
 * 每次重置 lastIndex —— 兼容带 g 标志的正则（避免跨行 lastIndex 残留导致漏报）。
 */
export function scan(files: readonly string[], re: RegExp): Hit[] {
  const hits: Hit[] = []
  for (const file of files) {
    readFileSync(file, 'utf-8').split('\n').forEach((line, i) => {
      re.lastIndex = 0
      if (re.test(line)) hits.push({file: rel(file), line: i + 1, text: line})
    })
  }
  return hits
}

/** 违规 = 命中且不是整行注释 */
export function violations(files: readonly string[], re: RegExp): string[] {
  return scan(files, re).filter(h => !isComment(h)).map(describeHit)
}

// ── color-mix alpha 档位扫描（alpha 阶梯护栏用，追加导出，勿动以上原语）──

/**
 * 匹配 Tailwind 任意值里的 color-mix 不透明度写法（全仓唯一「合法」的 var()+不透明度形态）：
 *   `<变体...>:<utility>-[color-mix(in_srgb,var(--token)_NN%,transparent|black)]`
 * 例：`dark-all:focus-visible:ring-[color-mix(in_srgb,var(--brand-primary)_20%,transparent)]`
 *
 * 捕获组：1=utility 及其变体前缀（冒号分隔）、2=令牌名、3=alpha 数字、4=混合目标。
 * 这是 Tailwind 3.4 无法编译的 `[var(--x)]/NN`（见上方 VAR_OPACITY）的替代写法；
 * 语义上 `transparent` = 淡化（wash/边框/环/文字），`black` = 实底 hover 加深。
 *
 * important 前缀（F2）：Tailwind 允许在 utility 前加 `!`（`dark:!ring-[...]`）。变体段
 * `(?::!?[\w-]+)*` **容忍** `!`，使这类站点被完整解析（而非在 `!` 处截断成「无变体的浅色
 * utility」）——截断会导致 `dark:!ring-[...]` 被误判为 ring.light、双向偏差
 * （20% 过度拦截、50% 静默放行）。`!` 紧贴 utility，解析时从末段剥离。
 *
 * 注意：本正则只认**规范形态**——它**不是**「所有 color-mix 的通用解析器」。
 * 更宽/更怪（但 Tailwind 仍能编译出有效 CSS）的形态由下方
 * `COLOR_MIX_ARBITRARY` + `canonicalColorMixViolations()` 专门拦截（F2 形态白名单）。
 *
 * 大小写（F1）：**函数名** `color-mix` 用 `(?i:)` 大小写不敏感匹配——CSS 函数名不区分大小写
 * （`COLOR-MIX` / `Color-Mix` 均有效且被 Tailwind 逐字透传，Chrome 实测生效），若只认小写，
 * 这类站点会整体逃过 alpha 阶梯。但**参数**（`in_srgb` / `transparent` / `black`）仍按下文
 * 大小写敏感：非常规大小写（`in_SRGB` / `TRANSPARENT` / `BLACK`）是**合法 CSS**——关键字与
 * 色彩空间名在 CSS 里大小写不敏感，浏览器不会丢弃——但属**非规范书写**（合法 CSS，只是
 * 绕开了规范形态），故由 F2 形态白名单判违规（「函数名/参数大小写非常规」）。
 */
export const COLOR_MIX =
  /([\w-]+(?::!?[\w-]+)*)-\[(?i:color-mix)\(\s*in_srgb\s*,\s*var\(--([\w-]+)\)_(\d+)%\s*,\s*(transparent|black)\s*\)\]/g

export interface ColorMixSite extends Hit {
  /** 变体前缀（冒号分隔的有序段），如 ['dark-all','focus-visible'] */
  variants: string[]
  /** 末段 utility，如 'ring' / 'bg' / 'border' / 'text' / 'decoration' / 'to' */
  utility: string
  /** 令牌名（不含 -- 前缀），如 'brand-primary' */
  token: string
  /** alpha 档位（百分数，如 30） */
  alpha: number
  /** 混合目标：transparent=淡化 / black=实底加深 */
  target: 'transparent' | 'black'
}

/** 从单行文本解析出全部 color-mix 站点（自检用例可直接喂字符串）。 */
export function parseColorMix(line: string, file = '', lineNo = 0): ColorMixSite[] {
  const out: ColorMixSite[] = []
  // F7：先剥掉行内注释片段（行首注释由调用方 isComment 过滤，行内/行尾注释靠这一步）
  const src = stripBlockComments(line)
  COLOR_MIX.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = COLOR_MIX.exec(src)) !== null) {
    // 此处可朴素 split(':')：COLOR_MIX 的变体段是 `!?[\w-]+`，不含方括号，
    // 故不会出现 `[&:is(.dark)]` 那种「括号内含冒号」被劈裂的情况。
    // 若日后放宽 COLOR_MIX 的变体段，必须改用 splitVariants()（见其 JSDoc 与 F5 根因说明）。
    const segs = m[1].split(':')
    // F2：末段可能带 important 前缀（`dark:!ring` → 末段 `!ring`），剥离 `!` 后才是 utility。
    const utility = (segs.pop() as string).replace(/^!/, '')
    out.push({
      file,
      line: lineNo,
      text: line,
      variants: segs,
      utility,
      token: m[2],
      alpha: Number(m[3]),
      target: m[4] as 'transparent' | 'black',
    })
  }
  return out
}

/** 扫描文件集，汇总全部 color-mix 站点（含注释行；调用方按需过滤）。 */
export function scanColorMix(files: readonly string[]): ColorMixSite[] {
  const out: ColorMixSite[] = []
  for (const file of files) {
    readFileSync(file, 'utf-8').split('\n').forEach((line, i) => {
      out.push(...parseColorMix(line, rel(file), i + 1))
    })
  }
  return out
}

/**
 * 由 utility + 变体前缀判定「角色」——**机械分类**，白名单策略在护栏测试里（策略不在这里）。
 * 焦点环按主题分档：`dark-all:` 前缀（tailwind.config 注册，覆盖 .dark/.yuanshandai 两个深色主题）
 * 单列为 `ring.dark`，因为暗色主题下同一 alpha 视觉更亮，需更低档位（见 spec §7-3）。
 */
export function colorMixRole(site: ColorMixSite): string {
  const V = new Set(site.variants)
  switch (site.utility) {
    case 'ring':
      return V.has('dark-all') ? 'ring.dark' : 'ring.light'
    case 'bg':
      return V.has('hover') ? 'hover:bg' : 'bg'
    case 'border':
      if (V.has('hover')) return 'hover:border'
      if (V.has('focus')) return 'focus:border'
      return 'border'
    case 'text':
      if (V.has('hover')) return 'hover:text'
      if (V.has('group-hover')) return 'group-hover:text'
      if (V.has('marker')) return 'marker:text'
      return 'text'
    default:
      // 单例 utility（decoration / to 等）原样返回
      return site.utility
  }
}

// ── F2：color-mix 形态白名单（「不认识的形态 = 违规」，而非「= 忽略」）──

/**
 * Tailwind 任意值里出现的 `color-mix(`（`[` … `]` 之间，单行内）。
 *
 * 为何不直接放宽上方 COLOR_MIX 去「接纳」各种怪形态？
 *   那等于给 `in_SRGB` / `in_oklab` / `var(--x,#hex)` / `_45_%` 这类非规范写法发通行证——
 *   它们都能被 Tailwind 编译出有效 CSS，却逃过所有基于「规范形态」的规则，是真实的绕过路径。
 *   正解是反过来：只承认唯一规范形态，**不认识的一律判违规**（并按下方两类文案分流）。
 *
 * 大小写（F1）：函数名 `color-mix` 大小写不敏感（`COLOR-MIX` / `Color-Mix` 必须被**检出**，
 * 否则整个 F2 形态白名单都被「换个大小写」击穿）；参数大小写是否规范由
 * `classifyColorMixArbitrary()` 单独判定。
 *
 * 已知盲区（见 GAP）：`[^[\]]*` 无法跨越同一任意值内另一对 `[]`，该构造仍会漏。
 */
export const COLOR_MIX_ARBITRARY = /\[[^[\]]*(?i:color-mix)\([^[\]]*\]/g

/** 唯一被承认的 color-mix 形态：`in_srgb + var(--token) + 整数% + transparent|black`（全小写）。 */
export const CANONICAL_COLOR_MIX = /^\[color-mix\(in_srgb,var\(--[\w-]+\)_\d+%,(?:transparent|black)\)\]$/

/**
 * 非阶梯用途 color-mix 登记表（默认空数组）。
 *
 * 语义：命中登记项的**字面形态**即整体放行——`canonicalColorMixViolationIn` 在分类**之前**短路，
 * 故登记表只应登记「非阶梯用途」的字面，不应登记「形态非法」的字面（那等于给写错开绿灯）。
 * 为什么需要它：护栏的作用域是「Tailwind 任意值内的 color-mix = 阶梯用法」，但现实中存在
 * 同样合法、**并非** alpha 阶梯的用法（双色渐变、感知均匀色彩空间、品牌色阴影、mask 等）。
 * 没有登记通道时，这些合法视觉工作被逼到护栏外（挪进 `style={{}}` 这个已知盲区），
 * 或只能去改护栏源码——后者是更坏的耦合。
 *
 * 与 ALPHA_LADDER **互相独立**：本表**只**服务 F2 白名单的「非阶梯用途未登记」这一档，
 * 不参与 alpha 阶梯判定。注意：匹配按**字面**、且在分类**之前**短路——故登记项会绕过分类，
 * 只应登记「非阶梯用途」的字面；登记「形态非法」的字面等于给写错开绿灯（靠评审约束，不靠代码）。
 * 每条 = 字面形态 + 中文理由 + 复评触发点。复评触发点可在条目被删除时由 reviewer 复查。
 */
export interface NonLadderColorMixEntry {
  /**
   * 字面形态：字符串（子串匹配）或正则（勿带 g 标志，避免 lastIndex 残留）。
   * **匹配口径**：匹配的是 Tailwind 任意值本身（`[...]`，**不含** utility / 变体前缀，如
   * `bg-`），与 `COLOR_MIX_ARBITRARY` 的命中一致；写整条类名（含 `bg-`）会匹配不到。
   */
  pattern: RegExp | string
  /** 中文理由：为何它不是 alpha 阶梯用法 */
  why: string
  /** 复评触发点：何时该回来重新评估是否可改写成阶梯形态 */
  revisit: string
}

export const NON_LADDER_COLOR_MIX: NonLadderColorMixEntry[] = []

/**
 * 登记入口的定位（常量名 + 所在文件）——违规文案里原样点名，让看到红灯的人知道
 * 该去哪儿登记（而非去放宽 `CANONICAL_COLOR_MIX` 或改校验逻辑）。
 */
export const NON_LADDER_REGISTRY_LOCATION =
  'tests/renderer/helpers/tokenScan.ts 的 NON_LADDER_COLOR_MIX'

/** 某任意值是否命中非阶梯登记表。 */
function isRegisteredNonLadder(arb: string): boolean {
  return NON_LADDER_COLOR_MIX.some(e =>
    typeof e.pattern === 'string' ? arb.includes(e.pattern) : new RegExp(e.pattern.source, e.pattern.flags.replace('g', '')).test(arb),
  )
}

/**
 * 判定一个 color-mix 任意值（整个 `[...]`）的违规类别。返回 null = 规范形态。
 * 两类文案（F3）：
 *   ①「大小写非常规 / 形态非法（写错了）」——引导改写成规范形态；
 *   ②「非阶梯用途未登记」——引导在 NON_LADDER_COLOR_MIX 登记理由（而非硬改成 alpha 形态）。
 */
function classifyColorMixArbitrary(arb: string): string | null {
  // ① 函数名大小写：CSS 函数名不区分大小写，但规范形态要求全小写 `color-mix`。
  if (!arb.includes('color-mix(')) {
    return 'color-mix 函数名大小写非常规（规范形态要求全小写 `color-mix`）'
  }
  // ① 参数大小写：`in_srgb` / `transparent` / `black` 必须全小写。
  const badParamCase =
    (/in_srgb/i.test(arb) && !arb.includes('in_srgb')) ||
    (/transparent/i.test(arb) && !arb.includes('transparent')) ||
    (/black/i.test(arb) && !arb.includes('black'))
  if (badParamCase) {
    return 'color-mix 参数大小写非常规（`in_srgb` / `transparent` / `black` 必须全小写）'
  }
  if (CANONICAL_COLOR_MIX.test(arb)) return null
  // ② 非规范形态分两类：写错了（形态非法）vs 合法但非阶梯用途。
  //    「写错了」= 裸的 color-mix 任意值，且结构就是在尝试阶梯形态（in_srgb + var(--token) + % + 目标）。
  const bare = /^\[color-mix\(/.test(arb)
  const ladderAttempt =
    /color-mix\(\s*in_srgb\s*,\s*var\(--[\w-]+[^)]*\)[^,]*,\s*(?:transparent|black)\s*\)/.test(arb)
  if (bare && ladderAttempt) {
    return 'color-mix 形态非法（必须 `in_srgb + var(--token) + 整数% + transparent|black`）'
  }
  return `color-mix 非阶梯用途未登记（渐变 / 色彩空间 / 组合值等）；若确属非阶梯用途，请在 ${NON_LADDER_REGISTRY_LOCATION} 登记理由，勿硬改成 alpha 形态，也勿改校验逻辑`
}

/** 单行形态检查：返回违规信息（空 = 该行所有 color-mix 任意值都规范）。自检可直接喂字符串。 */
export function canonicalColorMixViolationIn(line: string, file = 'self.tsx', lineNo = 1): string[] {
  const out: string[] = []
  // F7：先剥掉行内注释片段，避免 `<Foo/>{/* 旧: ... */}` 这类行被误报
  const src = stripBlockComments(line)
  COLOR_MIX_ARBITRARY.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = COLOR_MIX_ARBITRARY.exec(src)) !== null) {
    const arb = m[0]
    if (isRegisteredNonLadder(arb)) continue
    const v = classifyColorMixArbitrary(arb)
    if (v) out.push(`${file}:${lineNo}: ${v}: ${arb}`)
  }
  return out
}

/** 非规范形态的 color-mix 违规（含整行注释过滤）。 */
export function canonicalColorMixViolations(files: readonly string[]): string[] {
  const out: string[] = []
  for (const file of files) {
    readFileSync(file, 'utf-8').split('\n').forEach((line, i) => {
      const h: Hit = {file: rel(file), line: i + 1, text: line}
      if (isComment(h)) return
      out.push(...canonicalColorMixViolationIn(line, h.file, h.line))
    })
  }
  return out
}

// ── F4：内建 dark: 误用防护 ─────────────────────────────────────

/**
 * 捕获「任意变体链 + 阶梯颜色类 + [color-mix(...)]」。
 * 与 COLOR_MIX 不同，变体段允许方括号任意变体（`[&.dark]:`），因为内建 dark 正是以
 * `dark:` 与 `[&.dark]:` 两种形态出现的——COLOR_MIX 的 `[\w-]+` 段匹配不到后者。
 *
 * utility 覆盖面（F4）：必须覆盖**阶梯涉及的全部角色**——`ring`/`border`（含方向性 `border-[trblxy]`）、
 * `bg`、`text`、`decoration`、`to`。只覆盖 ring/border 时，`dark:bg-[color-mix(...)]` 会被 alpha 阶梯
 * 判成合法 `bg 10%` 静默通过，而 `dark:` 不命中 `.yuanshandai` → 远山黛漂移、零报警。
 *
 * 大小写（F1）：函数名 `color-mix` 大小写不敏感，否则 `dark:ring-[COLOR-MIX(...)]` 会逃逸本防护。
 * important 前缀（F2）：utility 前可有 `!`（`dark:!ring-[...]`），故 utility 组写成 `!?(?:ring|...)`——
 * 否则变体链与 utility 在 `!` 处断裂，`dark:!ring` 会被当作无变体的 `ring`，F4 漏掉内建 dark。
 */
const CLASS_COLOR_MIX =
  /((?:(?:\[[^\]\s]+\]|[\w-]+):)*)(!?(?:ring|bg|text|decoration|to|border(?:-[trblxy])?))-\[(?i:color-mix)\(([^\]]*)\)\]/g

/**
 * 按 `:` 切分变体链，但**不切方括号内部**的冒号——
 * 函数式伪类变体（`[&:is(.dark)]` / `[&:where(.dark)]`）内含冒号，
 * 朴素 split(':') 会把它劈成 `[&` 与 `is(.dark)]`，使 isBuiltinDarkVariant 永远认不出 `.dark`（F5 逃逸根因）。
 */
function splitVariants(chain: string): string[] {
  const segs: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of chain) {
    if (ch === '[') depth++
    else if (ch === ']') depth--
    if (ch === ':' && depth === 0) {
      segs.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur) segs.push(cur)
  return segs.filter(Boolean)
}

/**
 * 判定一个变体段是否为内建 `dark`（`.dark` 专用）——`dark-all:` 不算（它覆盖两个深色主题）。
 * 用 lookbehind/lookahead 统一判定「独立出现的 `.dark`」：前导字符只要不是 `[\w-]` 即成立，
 * 从而覆盖函数式伪类里的 `.dark`（`[&:is(.dark)]` / `[&:where(.dark)]`，前导为 `(` / `,` / `:`），
 * 也覆盖 `[.dark_&]` / `[&.dark]`；同时不误伤 `.dark-foo` / `.darktheme` 这类更长标识符。
 */
function isBuiltinDarkVariant(seg: string): boolean {
  if (seg === 'dark') return true
  if (/^\[.*\]$/.test(seg)) {
    // 尾部 / 首部的 `_` 是 Tailwind 的空格（`.dark_&` == `.dark &`）
    const inner = seg.slice(1, -1).replace(/_/g, ' ')
    return /(?<![\w-])\.dark(?![\w-])/.test(inner)
  }
  return false
}

/**
 * 阶梯颜色类（ring/border/bg/text/decoration/to）的 color-mix 站点若用了内建 `dark`
 * （`dark:` 或 `[&.dark]:` / `[&:is(.dark)]:` 等）→ 违规。
 * 机制：内建 dark 只命中 `.dark`，不命中 `.yuanshandai`；用它给「深色降档」的角色会让远山黛
 * 停在浅色档（如焦点环 50% 而非 30%）——是真漂移且零报警。深色主题必须写 `dark-all:`。
 */
export function darkVariantMisuseViolations(files: readonly string[]): string[] {
  const out: string[] = []
  for (const file of files) {
    readFileSync(file, 'utf-8').split('\n').forEach((line, i) => {
      const h: Hit = {file: rel(file), line: i + 1, text: line}
      if (isComment(h)) return
      out.push(...darkVariantMisuseIn(line, h.file, h.line))
    })
  }
  return out
}

/** 单行检查：阶梯颜色类的 color-mix 站点是否用了内建 dark。返回违规信息（空 = 合规）。 */
export function darkVariantMisuseIn(line: string, file = 'self.tsx', lineNo = 1): string[] {
  const out: string[] = []
  // F7：先剥掉行内注释片段
  const src = stripBlockComments(line)
  CLASS_COLOR_MIX.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CLASS_COLOR_MIX.exec(src)) !== null) {
    const segs = splitVariants(m[1])
    if (segs.some(isBuiltinDarkVariant)) {
      out.push(
        `${file}:${lineNo}: 深色主题请用 dark-all:（内建 dark:/[&.dark]: 只命中 .dark，` +
          `不命中 .yuanshandai，会让深色降档在远山黛失效）: ${m[0]}`,
      )
    }
  }
  return out
}

// ── 目录遍历（追加导出，勿动以上原语）──

/**
 * 递归列出某仓库相对目录下的全部源文件（`.ts` / `.tsx` / `.html`），
 * 返回仓库相对路径（/ 分隔、**内部已排序**）。
 *
 * 语义照抄 capabilityPages 护栏里那份局部 `walkDir`（递归、按扩展名收源码、相对路径），
 * 另加两处：① 一并收 `.html`（color-mix 令牌规则要覆盖内联主题表所在的窗口入口文件）；
 * ② 内部 sort，调用方无需再排序。仍排除 `*.d.ts`（声明文件不含源码级类名）。
 *
 * 为何另开一份而**不**改两个既有护栏去复用：那会引入无关 churn（既有护栏行为未变时不应被触碰）。
 * 后续若回收，应作为独立重构任务，而非在新增规则时顺手改。
 */
export function walkSourceFiles(relDir: string): string[] {
  const abs = join(process.cwd(), relDir)
  const out: string[] = []
  for (const name of readdirSync(abs)) {
    const full = join(abs, name)
    if (statSync(full).isDirectory()) out.push(...walkSourceFiles(rel(full)))
    else if (/\.(tsx?|html)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(rel(full))
  }
  return out.sort()
}
