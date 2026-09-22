import {describe, expect, it} from 'vitest'
import fs from 'fs'
import path from 'path'
import {stripAllComments} from '../helpers/tokenScan'

/**
 * `role="button"` 键盘可达性护栏（regression guard）。
 *
 * ## 现象
 * 声明了 `role="button"` 的元素对外宣称「这是一个按钮」，屏幕阅读器会把它念成按钮、
 * 键盘用户会尝试用 Tab 聚焦再用 Enter/Space 激活。若该元素同时给了 `tabIndex`
 * （即可被 Tab 聚焦）却**没有 `onKeyDown`**，就是一个「骗人」的可聚焦按钮：
 * 焦点进得来，按下去没反应——键盘用户被困死在这个站点。
 *
 * ## 扫描口径（为什么是源码扫描而不是渲染断言）
 * 「某元素是否同时声明了 role=button / tabIndex / onKeyDown」是**可机械判定的源文本事实**；
 * 而渲染级断言需要为每个组件准备 store mock 与交互上下文（成本高、覆盖窄、易漏新组件）。
 * 这里取规则级证据：只要全仓不再出现「role=button + tabIndex 但无 onKeyDown」的组合，
 * 该缺陷类就不再复发。它不证明浏览器真的把按键送进了 handler——如实声明能力边界。
 *
 * ## 切标签方式
 * JSX 开标签**常跨多行**（本仓库尤其如此），逐行匹配会漏。故这里做真正的
 * 标签扫描：从 `<Tag` 起，跳过字符串字面量（' " `）与 `{}` 表达式（其中可能含
 * `=>` 的 `>`），在**顶层**遇到 `>` 才算标签结束。
 *
 * 注释先整体剥除（`stripAllComments`，与 focusOutlineFlash / tokenScan 同源口径）：
 * 源码注释里出现的 `<span role="button" tabIndex={-1}>` 只是**说明文字**，不是站点。
 *
 * ## 为什么剥注释要「保行号」（本护栏的导航前提）
 * 护栏的产出是「文件:行」导航串（红灯里 `path:line`），行号必须指向**源文件真实行**。
 * 而 `stripAllComments` 的 TS 口径是 `replace(/\/\*[\s\S]*?\*\//g, '')`：把跨行块注释
 * **连同其中的换行**一并删掉，于是注释之后的每一行都整体上移。
 * 实测（node 一次性脚本复核）：`ConvModeSegs.tsx` 原 314 行 → 剥离后 290 行（漂移 24）；
 * 把该文件唯一的站点（`role` 条件式按钮标签 L125..L146，`onKeyDown` 在 L132）在内存里抹掉后，
 * 旧口径报 `:111`（该行是 `useEffect(() => {`，指错路），新口径报 `:125`（标签真实起始行）。
 * `CopyButton.tsx` 原 70 行 → 剥离后 66 行（漂移 4），旧报 `:44`（空行）/ 新报 `:48`。
 * 结论：这类红灯导航不到违规处——一个「指错路」的护栏比没有护栏更费人。
 *
 * 故本护栏走 `stripCommentsKeepingLines`（见下）：块注释按 `\n` 映射为**等量空行**，
 * 剥离后行数与原文件严格一致；行首 `//` 注释整行删除（该正则只吃行内字符，不含换行，天然不漂移），
 * 行内 `//` 依 `stripAllComments` 既有口径**不剥离**（那是 `https://` 保命线），也不引入漂移。
 * 自检用例把这条不变量钉住：构造样本断言 `findViolations` 返回的行号 == 样本真实行号，
 * 且对 `src/renderer` 全量文件断言「剥离后行数 == 原行数」。
 */

const RENDERER = path.resolve(process.cwd(), 'src/renderer')

function collectSources(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...collectSources(p))
    else if (/\.tsx$/.test(e.name)) out.push(p)
  }
  // 排序：readdirSync 的原始顺序跨平台不稳定，违规清单的顺序不该跟着漂
  return out.sort()
}

/** 一个 JSX 开标签（含跨行原文）及其起始行号 */
type OpenTag = {line: number; text: string}

/**
 * 取出源码中的全部 JSX 开标签（含跨行），带起始行号。
 * 跳过 `</...>`（闭标签）、`<!...>`（注释/DOCTYPE）；要求 `<` 后紧跟合法标签首字符
 * 且其后是空白 / `/` / `>`，以排除 `a < b` 这类比较表达式被误当成标签。
 */
export function findOpenTags(src: string): OpenTag[] {
  const out: OpenTag[] = []
  const n = src.length
  let line = 1
  let i = 0
  while (i < n) {
    const c = src[i]
    if (c === '\n') { line++; i++; continue }
    if (c !== '<') { i++; continue }
    if (!/^<[A-Za-z][\w.]*(?=[\s/>])/.test(src.slice(i, i + 64))) { i++; continue }

    const startLine = line
    let j = i + 1
    let depth = 0            // `{}` 表达式嵌套深度（其中可含 `=>` 的 `>`）
    let quote: string | null = null
    let text = '<'
    while (j < n) {
      const ch = src[j]
      if (ch === '\n') line++
      if (quote) {
        if (ch === '\\') { text += ch + (src[j + 1] ?? ''); j += 2; continue }
        if (ch === quote) quote = null
        text += ch; j++; continue
      }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; text += ch; j++; continue }
      if (ch === '{') { depth++; text += ch; j++; continue }
      if (ch === '}') { depth--; text += ch; j++; continue }
      if (depth === 0 && ch === '>') { text += ch; j++; break }
      text += ch; j++
    }
    i = j
    out.push({line: startLine, text})
  }
  return out
}

/**
 * role 取值 `button`——含**条件式**写法（`role={readOnly ? undefined : 'button'}`，
 * 见 ConvModeSegs 的折叠胶囊）：那种写法在非只读态确实是按钮，同样需要键盘处理，
 * 不能只认 `role="button"` 字面量，否则护栏恰好漏掉最该守的那一处（首版即如此，已修）。
 */
const HAS_ROLE_BUTTON = /role\s*=\s*(?:"button"|'button'|\{[\s\S]*?['"]button['"][\s\S]*?\})/
const HAS_TAB_INDEX = /tabIndex\s*=/
const HAS_ON_KEY_DOWN = /onKeyDown\s*=/

/**
 * 先把块注释（含跨行）**替换为等量换行的空白**，再交给 `stripAllComments` 收尾。
 *
 * 为什么不能直接用 `stripAllComments(src, 'ts')`：它把块注释（从起始标记到结束标记，
 * 含跨行）**整体删除**，跨行块注释的换行随之消失 → 后续行号整体上移，
 * 红灯里的 `path:line` 导航不到违规处（见文件头说明）。
 *
 * 做法：匹配到的注释体里，除 `\n` 外的一切字符换成空格——换行个数逐字保留，
 * 所以 `split('\n').length` 前后相同；同时字符偏移也基本保留（同长度替换），
 * 避免「删注释导致相邻 token 粘连」这类二阶偏差（`foo` 与 `bar` 之间的注释不再把二者粘成 `foobar`）。
 * 替换后已无块注释，`stripAllComments` 只剩行首 `//` 的整行删除（不动换行）与 html/css 分支，无副作用。
 */
export function stripCommentsKeepingLines(src: string): string {
  return stripAllComments(src.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' ')), 'ts')
}

/** 返回该文件中「可聚焦按钮却无键盘处理」的违规行号（行号 == 源文件真实行号） */
export function findViolations(src: string): number[] {
  return findOpenTags(stripCommentsKeepingLines(src))
    .filter((t) => HAS_ROLE_BUTTON.test(t.text) && HAS_TAB_INDEX.test(t.text) && !HAS_ON_KEY_DOWN.test(t.text))
    .map((t) => t.line)
}

describe('role="button" + tabIndex 键盘护栏', () => {
  it('自检：合成样本能被正确识别（防止扫描器静默失效）', () => {
    const bad = `
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
      >x</div>
    `
    expect(findViolations(bad)).toEqual([2])

    const good = `
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(e) => { if (e.key === 'Enter') onSelect() }}
      >x</div>
    `
    expect(findViolations(good)).toEqual([])

    // 非 role=button 的可聚焦元素不在本护栏范围内（如 tabIndex=0 的容器）
    expect(findViolations('<div tabIndex={0} onClick={f}>x</div>')).toEqual([])

    // 条件式 role（三层表达式）同样算 role=button：不能只认字面量写法
    expect(findViolations(`
      <span
        role={readOnly ? undefined : 'button'}
        tabIndex={readOnly ? undefined : 0}
      >x</span>
    `)).toEqual([2])

    // 注释里的「示例标签」不是站点（TreeRow 的说明注释即此形态），不得计入
    expect(findViolations('//   chevron = <span role="button" tabIndex={-1}>（由 TreeChevron 提供）')).toEqual([])

    // 跨行开标签：属性分散在 4 行，onKeyDown 写在最后一行也必须被认到
    expect(findViolations(`
      <div
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter') f() }}
      >x</div>
    `)).toEqual([])
  })

  it('自检：跨行块注释不引起行号漂移（红灯的 path:line 必须导航得到）', () => {
    // 真实源文件的漂移根因：块注释体被整段删除，连带吃掉其中的换行，其后所有行整体上移。
    // 这里构造「块注释在前、违规站点在后」的最小样本，把行号对齐钉死。
    const sample = [
      '/* 一段跨行块注释', // 1
      '   注释第二行', // 2
      '   注释第三行 */', // 3
      '', // 4
      '<div', // 5 ← 违规站点的真实起始行
      '  role="button"', // 6
      '  tabIndex={0}', // 7
      '  onClick={f}', // 8
      '>x</div>', // 9
    ].join('\n')

    // 报出的行号 == 样本中的真实行号（旧口径下这里会报 3：3 行注释被压成 1 行空行，整体上移 2 行）
    expect(findViolations(sample)).toEqual([5])
    // 漂移的形式化不变量：剥离后行数必须与原文件一致
    expect(stripCommentsKeepingLines(sample).split('\n').length).toBe(sample.split('\n').length)
  })

  it('自检：行内 // 注释不引入漂移，行首 // 注释整行删除也不改行数', () => {
    const sample = [
      'const url = "https://example.com/x" // 行内注释不剥离（保住 URL）', // 1
      '// 行首注释：整行删除，但换行保留', // 2
      '/* 跨行', // 3
      '   注释 */', // 4
      '<div', // 5 ← 违规站点的真实起始行
      '  role="button"', // 6
      '  tabIndex={0}', // 7
      '>x</div>', // 8
    ].join('\n')

    expect(findViolations(sample)).toEqual([5])
    expect(stripCommentsKeepingLines(sample).split('\n').length).toBe(sample.split('\n').length)
    // 行内注释里的 URL 不被砍 —— `stripAllComments` 的既有口径（`ws://` / `https://` 保命线），本护栏不得改动它
    expect(stripCommentsKeepingLines(sample)).toContain('https://example.com/x')
  })

  it('src/renderer 全量扫描：无「role="button" + tabIndex 但无 onKeyDown」的站点', () => {
    const violations: string[] = []
    for (const file of collectSources(RENDERER)) {
      const rel = path.relative(process.cwd(), file).replace(/\\/g, '/')
      const raw = fs.readFileSync(file, 'utf-8')
      // 行号不变量（全仓）：剥离注释后行数必须与原文件一致，否则红灯里的 `path:line` 导航不到违规处
      expect(stripCommentsKeepingLines(raw).split('\n').length, `${rel} 剥离注释后行数漂移`).toBe(
        raw.split('\n').length,
      )
      for (const line of findViolations(raw)) {
        violations.push(`${rel}:${line}`)
      }
    }
    expect(
      violations,
      [
        'role="button" 的元素对外宣称是按钮，且带 tabIndex 说明它可被 Tab 聚焦，',
        '但缺少 onKeyDown：键盘用户聚焦后按 Enter/Space 毫无反应（骗人按钮）。',
        '修法：补 onKeyDown，处理 Enter/Space → preventDefault + 触发等价点击行为；',
        '若内部还含可聚焦子元素，另加 `if (e.target !== e.currentTarget) return` 守卫。',
        '若该站点本不该键盘可达，则应去掉 role/tabIndex，而不是留着空壳。',
      ].join('\n'),
    ).toEqual([])
  })
})
