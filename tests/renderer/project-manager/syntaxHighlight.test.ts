// @vitest-environment jsdom
import {describe, it, expect} from 'vitest'
import {highlightLines, MAX_HIGHLIGHT_CHARS} from '../../../src/renderer/project-manager/lib/syntaxHighlight'
import type {LineToken} from '../../../src/renderer/project-manager/lib/syntaxHighlight'

/** 不变量：每行的 token 文本拼接 === 该行原文（无损覆盖） */
function expectLossless(content: string, tokens: LineToken[][]) {
  const lines = content.split('\n')
  expect(tokens.length, '行数应与 content.split("\\n") 一致').toBe(lines.length)
  lines.forEach((line, i) => {
    expect(tokens[i].map(t => t.text).join(''), `第 ${i} 行被切分破坏`).toBe(line)
  })
}

function has(tokens: LineToken[][], cls: string, text: string) {
  return tokens.some(line => line.some(t => t.cls === cls && t.text === text))
}

describe('highlightLines', () => {
  it('TS 内容按语法着色（关键字 / 数字）', async () => {
    const tokens = await highlightLines('const a: number = 1', 'a.ts')
    expect(tokens).not.toBeNull()
    expect(has(tokens!, 'pm-tok-keyword', 'const')).toBe(true)
    expect(tokens![0].some(t => t.cls === 'pm-tok-number')).toBe(true)
    expectLossless('const a: number = 1', tokens!)
  })

  it('无损不变量：多行块注释 / 模板字符串 / CRLF / 空行 / 单行 / 末尾无换行', async () => {
    const samples = [
      '/* 多行\n   块注释\n*/\nconst x = `模板\n字符串`',
      'a\r\nb\r\nc',
      'line1\n\nline3',
      'single',
      'a\nb\n',
      'const o = {a: 1, b: [true, null]}\n',
      '',
    ]
    for (const s of samples) {
      const tokens = await highlightLines(s, 'a.ts')
      expect(tokens, `样例未被着色: ${JSON.stringify(s)}`).not.toBeNull()
      expectLossless(s, tokens!)
    }
  })

  it('多行 token（块注释 / 模板字符串）跨行切开后每行仍落在正确的一侧', async () => {
    // 模板字符串跨行：第 1 行收尾 `aaa，第 2 行开头 bbb` + 「反引号」仍在 string 里
    const content = 'const x = `aaa\nbbb` + 1'
    const tokens = (await highlightLines(content, 'a.ts'))!
    expectLossless(content, tokens)
    expect(tokens[0].some(t => t.cls === 'pm-tok-string' && t.text === '`aaa')).toBe(true)
    expect(tokens[1].some(t => t.cls === 'pm-tok-string' && t.text === 'bbb`')).toBe(true)
    // 块注释同理：第 2 行的 'bbb */' 整体是注释，紧随其后的代码恢复各自的颜色
    const comment = '/* aaa\nbbb */ const y = 1'
    const ct = (await highlightLines(comment, 'a.ts'))!
    expectLossless(comment, ct)
    expect(ct[0].some(t => t.cls === 'pm-tok-comment' && t.text === '/* aaa')).toBe(true)
    expect(ct[1].some(t => t.cls === 'pm-tok-comment' && t.text === 'bbb */')).toBe(true)
    expect(ct[1].some(t => t.cls === 'pm-tok-keyword' && t.text === 'const')).toBe(true)
  })

  it('相邻同类的片段已合并（不产生碎片 span）', async () => {
    const tokens = (await highlightLines('const a = "x" + "y"\n/* c */ const b = 2', 'a.ts'))!
    for (const line of tokens) {
      for (let i = 1; i < line.length; i++) {
        expect(line[i].cls, `相邻同类片段未合并: ${JSON.stringify(line)}`).not.toBe(line[i - 1].cls)
      }
    }
  })

  it('未着色区间显式补 cls: "" 段（不变量因此无条件成立，渲染侧无需区分有无着色）', async () => {
    const tokens = (await highlightLines('const a = 1', 'a.ts'))!
    // 空白的间隙必须作为 cls:'' 的段存在，否则整行拼接对不上
    expect(tokens[0].some(t => t.cls === '')).toBe(true)
    expect(tokens[0].map(t => t.text).join('')).toBe('const a = 1')
  })

  it('json / css / html 各自可着色', async () => {
    expect((await highlightLines('{"a": 1}', 'a.json'))).not.toBeNull()
    expect((await highlightLines('a { color: red; }', 'a.css'))).not.toBeNull()
    expect((await highlightLines('<p>hi</p>', 'a.html'))).not.toBeNull()
  })

  // 回归：.tsx/.jsx 必须走 javascript({jsx: true})，与 lib/language.ts 的编辑器路径同源。
  // 用 javascriptLanguage（jsx 关闭）会把 JSX 标签当语法错误恢复 → 标签名不着 pm-tok-type，
  // 同一份 .tsx 在编辑器与 diff 里颜色不一致（该不一致由 verify 实测确认过）。
  it('.tsx / .jsx 启用 JSX 语法：标签名着 pm-tok-type，与编辑器同源', async () => {
    for (const p of ['a.tsx', 'a.jsx']) {
      const lines = await highlightLines('<div className="x">hi</div>', p)
      const cls = lines![0].map(tk => tk.cls)
      expect(cls, p).toContain('pm-tok-type')
      // 契约：编辑器里不报错的写法，diff 里也必须被正常着色（非全量 '' 兜底）
      expect(lines![0].some(tk => tk.cls !== ''), p).toBe(true)
    }
  })

  it('不支持的扩展名返回 null（.md / .txt / .yaml / 无扩展名）', async () => {
    for (const p of ['notes.md', 'readme.txt', 'config.yaml', 'Makefile', 'LICENSE', '.gitignore']) {
      expect(await highlightLines('const a = 1', p), p).toBeNull()
    }
  })

  it('超预算内容返回 null（不冻 UI）', async () => {
    expect(await highlightLines('x'.repeat(MAX_HIGHLIGHT_CHARS + 1), 'a.ts')).toBeNull()
    // 预算内且非代码文件仍按语言判定 → null（顺序无关，两种降级都不会抛错）
    expect(await highlightLines('x'.repeat(MAX_HIGHLIGHT_CHARS + 1), 'a.md')).toBeNull()
  })
})
