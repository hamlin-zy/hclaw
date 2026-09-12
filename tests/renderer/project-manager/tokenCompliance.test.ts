// tests/renderer/project-manager/tokenCompliance.test.ts
import {describe, it, expect} from 'vitest'
import {readFileSync, readdirSync, statSync} from 'fs'
import {join, relative} from 'path'

const ROOT = join(process.cwd(), 'src/renderer/project-manager')

/** `var(--x, #hex)` 兜底写法（spec §2.1 的头号反模式） */
const HEX_FALLBACK = /var\(\s*--[a-z0-9-]+\s*,\s*#[0-9a-fA-F]{3,8}/
/** 裸 hex 颜色字面值 */
const BARE_HEX = /#[0-9a-fA-F]{3,8}\b/
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(name)) out.push(full)
  }
  return out
}

const rel = (f: string) => relative(process.cwd(), f).replace(/\\/g, '/')
const relFromRoot = (f: string) => relative(ROOT, f).replace(/\\/g, '/')

const ALL_FILES = walk(ROOT)
/**
 * 扫描范围 = project-manager 下全部 .ts/.tsx，**无白名单**。
 * 阶段三（Task 3）已把 EditorArea / EditorTab 的 hex 清干净，原来的 PHASE3_DEFERRED
 * 排除清单失去存在理由，整体删除——扫描范围只增不减才是护栏的正确方向。
 */
const FILES = ALL_FILES

interface Hit {
  file: string
  line: number
  /** 原始行文本（保留前导空白与行首注释符，供注释判定使用） */
  text: string
}

/** 逐行扫描，命中就记录 file:line: 原文，方便直接跳过去改 */
function scan(re: RegExp): Hit[] {
  const hits: Hit[] = []
  for (const file of FILES) {
    readFileSync(file, 'utf-8').split('\n').forEach((line, i) => {
      if (re.test(line)) hits.push({file: rel(file), line: i + 1, text: line})
    })
  }
  return hits
}

/** 整行注释（// 或块注释的 * / 开头）。遍历用原始行文本，不能用 trim 后的串。 */
const isComment = (h: Hit) => /^\s*(\/\/|\*|\/\*)/.test(h.text)

const describeHitLoc = (h: Hit) => `${h.file}:${h.line}`
const describeHit = (h: Hit) => `${describeHitLoc(h)}: ${h.text.trim()}`

/** 违规 = 命中且不是整行注释 */
function violations(re: RegExp): string[] {
  return scan(re).filter(h => !isComment(h)).map(describeHit)
}

describe('令牌合规扫描（spec §16.2）', () => {
  it('自检：扫描范围无白名单排除，原推迟的三个文件都已在范围内', () => {
    // 白名单护栏升级：原 PHASE3_DEFERRED 是永久硬编码排除清单，没有过期机制，
    // 护栏会静默永久收窄。现在改为断言「没有任何文件被排除」——有人偷偷加回排除
    // 清单就会被立刻抓住；覆盖只增不减。
    expect(FILES.length, '有文件被排除出扫描范围了（不准加白名单）').toBe(ALL_FILES.length)
    const names = ALL_FILES.map(relFromRoot)
    for (const d of ['components/EditorArea.tsx', 'components/EditorTab.tsx', 'components/ImageViewer.tsx']) {
      expect(names, `应被扫描的文件不存在: ${d}`).toContain(d)
    }
    // 仍有 30+ 个文件在扫描范围内，避免"扫了个空目录"式的假绿
    expect(FILES.length).toBeGreaterThan(30)
    expect(names).toContain('ProjectManagerApp.tsx')
    expect(names).toContain('ui/ContextMenu.tsx')
  })

  it('注释过滤只放行整行注释，代码行里的同样写法照抓', () => {
    const h = (text: string): Hit => ({file: 'x', line: 1, text})
    expect(isComment(h('// var(--bg-secondary, #252526)'))).toBe(true)
    expect(isComment(h('   * #FFC66D'))).toBe(true)
    expect(isComment(h('  /* #fff */'))).toBe(true)
    expect(isComment(h('  const x = "#FFC66D"'))).toBe(false)
    expect(isComment(h('  background: var(--bg, #fff),'))).toBe(false)
  })

  it('禁止 `var(--x, #hex)` 兜底写法', () => {
    // 旧右键菜单写了 var(--bg-secondary, #252526)，该令牌根本不存在，
    // 导致所有主题都落到 Darcula 灰。这是本次要根治的头号反模式。
    const hits = violations(HEX_FALLBACK)
    expect(hits, `发现带 hex 兜底的 var() 用法:\n${hits.join('\n')}`).toEqual([])
  })

  it('project-manager 下的 .ts/.tsx 不得出现裸 hex 颜色字面值', () => {
    // 仅禁兜底会漏掉"把 STATUS_STYLE 的 hex 换个地方写"这类回归，所以连裸 hex 一起禁。
    // 白名单：无（lib/fileIcon.ts 与 lib/statusColor.ts 用的都是 var(--token) 字符串，不是 hex）。
    const hits = violations(BARE_HEX)
    expect(hits, `发现裸 hex 字面值:\n${hits.join('\n')}`).toEqual([])
  })

  it('回归守卫：不得再出现 var(--bg-secondary, ...) 这个不存在的令牌', () => {
    // 唯一允许出现该字符串的地方是 ui/ContextMenu.tsx 的整行注释——它在文档化这条规则本身。
    const all = scan(/var\(--bg-secondary/)
    expect(all.filter(h => !isComment(h)).map(describeHit)).toEqual([])
    const comment = all.find(
      h => isComment(h) && h.file.endsWith('ui/ContextMenu.tsx') && h.text.includes('var(--bg-secondary, #252526)'),
    )
    // 断言它是"因为整行注释而被放行"，不是靠改写措辞躲过匹配：注释里仍写着被禁的写法。
    // 锚定文件+文本而非行号，避免无关的编辑让断言变脆。
    expect(comment, 'ContextMenu 里记录该反模式的注释不见了——它是这条规则的文档，不要删也不要改写').toBeDefined()
  })
})

describe('内联样式预算（spec §1.4 阶段一判据）', () => {
  const PHASE1_FILES = [
    'ProjectManagerApp.tsx',
    'components/FileTree.tsx',
    'components/GitStatusPanel.tsx',
    'components/GitBranchTree.tsx',
    'components/GitLogPanel.tsx',
    'components/GitDagGraph.tsx',
    'components/GitCommitDetail.tsx',
    'components/StatusBar.tsx',
  ]

  it('阶段一涉及的 8 个文件内联 style 合计 ≤ 5 处', () => {
    const counts = PHASE1_FILES.map(f => {
      const src = readFileSync(join(ROOT, f), 'utf-8')
      return [f, (src.match(/style=\{\{/g) ?? []).length] as const
    })
    const total = counts.reduce((sum, [, n]) => sum + n, 0)
    const detail = counts.filter(([, n]) => n > 0).map(([f, n]) => `${f}: ${n}`).join('\n')
    expect(total, `各文件内联样式数:\n${detail}`).toBeLessThanOrEqual(5)
  })
})
