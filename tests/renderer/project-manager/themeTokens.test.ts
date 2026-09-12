// tests/renderer/project-manager/themeTokens.test.ts
import {describe, it, expect} from 'vitest'
import {readFileSync} from 'fs'
import {join} from 'path'

const CSS = readFileSync(join(process.cwd(), 'src/renderer/styles/globals.css'), 'utf-8')

/** 取出某个选择器对应的规则体（本文件只有顶层规则，按大括号配平取） */
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

/** 读一条声明；不存在返回 null */
function decl(body: string, name: string): string | null {
  const m = body.match(new RegExp(`(?:^|[;{\\s])${name}\\s*:\\s*([^;]+);`))
  return m ? m[1].trim() : null
}

const THEMES = [':root', '.dark', '.yuanshandai', '.shiyangjin'] as const
const SHARED = ':where(:root, .dark, .yuanshandai, .shiyangjin)'

/** 17 个派生令牌：值由 var()/color-mix() 得出，写在 :where(四主题) 共用规则里（spec §3.1/§3.2/§3.3） */
const DERIVED_TOKENS = [
  '--vcs-modified', '--vcs-added', '--vcs-deleted', '--vcs-untracked',
  '--icon-folder',
  '--diff-added-bg', '--diff-added-strong', '--diff-added-rail',
  '--diff-removed-bg', '--diff-removed-strong', '--diff-removed-rail',
  '--diff-blank-bg',
  '--code-gutter-bg', '--code-current-line', '--code-indent-guide',
  '--code-selection', '--code-match',
] as const

/**
 * 扫描全文所有「选择器 { 规则体 }」，只看选择器里带 `.pm-` 的那些。
 *
 * globals.css 里 @layer / @keyframes 内部也带花括号，但扁平正则会把内层规则也
 * 平铺匹配出来（选择器不含 .pm-，不影响本断言）；`.pm-*` 规则本身是文件末尾的扁平规则。
 * 先剥注释，避免注释里的 `var(--x, #hex)` 被误当成消费点。
 */
function pmRuleBodies(): string[] {
  const noComments = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: string[] = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(noComments))) {
    if (m[1].includes('.pm-')) out.push(m[2])
  }
  return out
}

describe('令牌层 §2.2 rev3：派生令牌必须放在四主题共用规则里', () => {
  it('--vcs-* 别名定义在 :where(四主题) 内', () => {
    const body = ruleBody(SHARED)
    expect(decl(body, '--vcs-modified')).toBe('var(--warning)')
    expect(decl(body, '--vcs-added')).toBe('var(--success)')
    expect(decl(body, '--vcs-deleted')).toBe('var(--error)')
    expect(decl(body, '--vcs-untracked')).toBe('var(--info)')
  })

  it('回归守卫：17 个派生令牌全部不得落进 :root（rev3 修正的核心缺陷）', () => {
    // :root 特指度 0,1,0 高于 :where(...) 的 0,0,0。一旦某个派生令牌被写进 :root，
    // 它会对**所有**主题生效（浅色值泄漏到深色主题）——这正是 rev3 要根治的缺陷。
    // 因此逐个遍历全部 17 个，而不是抽样 3 个。
    expect(DERIVED_TOKENS).toHaveLength(17)
    const root = ruleBody(':root')
    const shared = ruleBody(SHARED)
    for (const token of DERIVED_TOKENS) {
      expect(decl(shared, token), `${token} 应声明在 :where(四主题) 内`).not.toBeNull()
      expect(decl(root, token), `${token} 不得声明在 :root`).toBeNull()
    }
  })

  it('--diff-* 派生令牌全部在 :where(四主题) 内', () => {
    const body = ruleBody(SHARED)
    expect(decl(body, '--diff-added-bg')).toMatch(/^color-mix\(in srgb,\s*var\(--success\)\s*13%,\s*transparent\)$/)
    expect(decl(body, '--diff-added-strong')).toMatch(/^color-mix\(in srgb,\s*var\(--success\)\s*30%,\s*transparent\)$/)
    expect(decl(body, '--diff-added-rail')).toBe('var(--success)')
    expect(decl(body, '--diff-removed-bg')).toMatch(/^color-mix\(in srgb,\s*var\(--error\)\s*13%,\s*transparent\)$/)
    expect(decl(body, '--diff-removed-strong')).toMatch(/^color-mix\(in srgb,\s*var\(--error\)\s*30%,\s*transparent\)$/)
    expect(decl(body, '--diff-removed-rail')).toBe('var(--error)')
    expect(decl(body, '--diff-blank-bg')).toBe('var(--surface-muted)')
  })

  it('编辑器结构线索令牌全部在 :where(四主题) 内', () => {
    const body = ruleBody(SHARED)
    expect(decl(body, '--code-gutter-bg')).toBe('var(--surface-muted)')
    expect(decl(body, '--code-selection')).toBe('var(--brand-muted)')
    expect(decl(body, '--code-match')).toBe('var(--brand-muted)')
    expect(decl(body, '--code-current-line')).toMatch(/var\(--text-primary\)\s*5%/)
    expect(decl(body, '--code-indent-guide')).toMatch(/var\(--text-primary\)\s*9%/)
    expect(decl(body, '--icon-folder')).toMatch(/var\(--brand-primary\)\s*85%/)
  })

  it('回归护栏：.pm-* 规则消费的每个令牌都能在四套主题下解析（I1 免疫）', () => {
    // I1（--brand-border 只在 2/4 主题声明）之所以能溜到最终审查，是因为
    // 此前的测试只盯着「令牌是否在自己该在的位置」，没人检查「消费它的规则能否在
    // 四套主题下都拿到主题自己的值」。这条断言把两者接起来：枚举 .pm-* 规则里
    // 所有 var(--*) 消费点，要求每个令牌要么写在四主题共用规则里，要么在四套主题块
    // 里各声明一份。
    const shared = ruleBody(SHARED)
    const consumed = new Set<string>()
    for (const body of pmRuleBodies()) {
      for (const m of body.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) consumed.add(m[1])
    }
    // 防空扫描假绿：pm 段确实消费了十几个令牌（当前 23 个）
    expect(consumed.size).toBeGreaterThanOrEqual(15)

    // 合法豁免：主题无关的基础令牌——只在 :root 声明、没有任何主题块覆盖它。
    // :root 就是 <html>（主题 class 也挂在 <html> 上），各主题继承到的是同一个值。
    const THEME_INDEPENDENT = new Set(['--z-dropdown', '--z-elevated'])

    const offenders: string[] = []
    for (const token of consumed) {
      if (decl(shared, token) !== null) continue                          // 派生令牌：四主题共用规则
      const declaredIn = THEMES.filter(t => decl(ruleBody(t), token) !== null)
      if (declaredIn.length === THEMES.length) continue                   // 四套主题块各一份
      if (declaredIn.length === 1 && declaredIn[0] === ':root' && THEME_INDEPENDENT.has(token)) continue
      offenders.push(`${token}（声明于 ${declaredIn.join(', ') || '（无）'}）`)
    }
    expect(offenders, `.pm-* 规则消费了未在四套主题中一致声明的令牌（部分主题会拿到别的主题的值）：\n${offenders.join('\n')}`).toEqual([])
  })
})

describe('令牌层 §3.1 / §3.3：实值令牌四主题各一份', () => {
  it('--vcs-renamed 四套主题各一份且逐值正确', () => {
    expect(THEMES.map(t => decl(ruleBody(t), '--vcs-renamed')))
      .toEqual(['#7c3aed', '#a78bfa', '#9b8bd8', '#8b5cf6'])
  })

  const CODE_TOKENS = [
    '--code-keyword', '--code-string', '--code-comment', '--code-number',
    '--code-type', '--code-function', '--code-ident', '--code-punct',
  ] as const

  it('8 个语法令牌在四套主题块内各有一份字面值', () => {
    for (const token of CODE_TOKENS) {
      for (const theme of THEMES) {
        const value = decl(ruleBody(theme), token)
        expect(value, `${token} @ ${theme}`).toMatch(/^#[0-9a-fA-F]{3,8}$/)
      }
    }
  })

  it('语法色逐值正确（§3.3 表）', () => {
    const expected: Record<(typeof CODE_TOKENS)[number], string[]> = {
      '--code-keyword': ['#af00db', '#c586c0', '#d3a6f0', '#a0349e'],
      '--code-string': ['#a31515', '#ce9178', '#f0a58c', '#a83232'],
      '--code-comment': ['#008000', '#6a9955', '#7ba87b', '#4f7a4f'],
      '--code-number': ['#098658', '#b5cea8', '#a9d9a4', '#2f7d5a'],
      '--code-type': ['#267f99', '#4ec9b0', '#5fd0c6', '#1d6b78'],
      '--code-function': ['#795e26', '#dcdcaa', '#e8cf8a', '#8a6a1a'],
      '--code-ident': ['#001080', '#9cdcfe', '#a3c9f0', '#28427e'],
      '--code-punct': ['#383a42', '#d4d4d4', '#e8edf2', '#3C2E2D'],
    }
    for (const [token, values] of Object.entries(expected)) {
      expect(THEMES.map(t => decl(ruleBody(t), token)), token).toEqual(values)
    }
  })

  it('既有令牌未被改动（--surface / --warning / --error 保持原值）', () => {
    expect(decl(ruleBody(':root'), '--surface')).toBe('#ffffff')
    expect(decl(ruleBody(':root'), '--warning')).toBe('#f59e0b')
    expect(decl(ruleBody('.dark'), '--warning')).toBe('#d4a021')
    expect(decl(ruleBody('.dark'), '--error')).toBe('#c45c5c')
    expect(decl(ruleBody('.yuanshandai'), '--warning')).toBe('#c9953a')
  })
})
