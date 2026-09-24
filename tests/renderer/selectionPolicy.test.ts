import {describe, it, expect} from 'vitest'
import {readFileSync} from 'fs'
import {join} from 'path'
import {SELECTION_WHITELIST, findMissingAnchors} from './helpers/selectionWhitelist'

// 边界说明：本护栏是静态校验，只检查两条规则在 globals.css 中的存在性与先后顺序，
// 以及清单挂点在源码文本里是否命中，不解析 CSS 层叠结果。
// 因此「在 globals.css 后半段追加一条类级 user-select: none !important 把白名单压掉」
// 这类退化它发现不了（护栏仍全绿），只能靠真机验收单兜底。
const ROOT = process.cwd()
const CSS_PATH = 'src/renderer/styles/globals.css'
const CSS = readFileSync(join(ROOT, CSS_PATH), 'utf-8')

/** 策略锚点注释标记：规则内容由这两个标记定位，避免解析整个 CSS */
const MARK_DEFAULT = '[selection-policy] 窗口级默认'
const MARK_WHITELIST = '[selection-policy] 白名单'

/** 规则体缩进：globals.css 全文件统一 2 空格 */
const INDENT = '  '

/**
 * 取标记注释之后紧邻的那条规则，返回「选择器段」与「声明行数组」。
 *
 * 两段都**不含注释文本**：标记注释里本就逐条写着 input / textarea /
 * [contenteditable] / .cm-editor / .select-text，若拿包含注释的整段文本做
 * 子串断言，注释会替选择器"作证"，把选择器里的关键词删掉测试仍是绿的。
 * 声明同样按整行精确匹配（含缩进），子串匹配会被 -webkit- 版本满足。
 */
function ruleAfter(mark: string): {selector: string; decls: string[]} {
  const i = CSS.indexOf(mark)
  expect(i, `缺少标记 ${mark}`).toBeGreaterThan(-1)
  const open = CSS.indexOf('{', i)
  expect(open, `标记 ${mark} 之后找不到规则开括号`).toBeGreaterThan(-1)
  const close = CSS.indexOf('}', open)
  expect(close, `标记 ${mark} 之后找不到规则闭括号`).toBeGreaterThan(-1)
  // 规则选择器位于标记注释闭合处与开括号之间（两条规则体内均无嵌套花括号）
  const commentEnd = CSS.lastIndexOf('*/', open)
  const selectorStart = commentEnd === -1 ? i : commentEnd + 2
  return {
    selector: CSS.slice(selectorStart, open).trim().replace(/\s+/g, ' '),
    decls: CSS.slice(open + 1, close).split('\n'),
  }
}

describe('选区策略：CSS 规则', () => {
  it('存在窗口级默认规则，且含标准与 -webkit- 两条 user-select: none 声明', () => {
    const rule = ruleAfter(MARK_DEFAULT)
    expect(rule.selector).toBe('body')
    expect(rule.decls).toContain(`${INDENT}user-select: none;`)
    expect(rule.decls).toContain(`${INDENT}-webkit-user-select: none;`)
  })

  it('存在白名单规则，选择器含全部兜底关键词，且两条 user-select: text 声明齐备', () => {
    const rule = ruleAfter(MARK_WHITELIST)
    for (const kw of ['input', 'textarea', '[contenteditable]', '.cm-editor', '.select-text']) {
      expect(rule.selector, `白名单选择器缺少 ${kw}`).toContain(kw)
    }
    expect(rule.decls).toContain(`${INDENT}user-select: text;`)
    expect(rule.decls).toContain(`${INDENT}-webkit-user-select: text;`)
  })

  it('白名单规则必须位于默认规则之后（顺序即优先级）', () => {
    const def = CSS.indexOf(MARK_DEFAULT)
    const white = CSS.indexOf(MARK_WHITELIST)
    expect(def).toBeGreaterThan(-1)
    expect(white).toBeGreaterThan(def)
  })
})

describe('选区策略：白名单挂点完整性', () => {
  it('清单里每个挂点都在源码中带上了 select-text', () => {
    const srcByFile = new Map<string, string>()
    for (const a of SELECTION_WHITELIST) {
      if (!srcByFile.has(a.file)) {
        srcByFile.set(a.file, readFileSync(join(ROOT, a.file), 'utf-8'))
      }
    }
    const missing = findMissingAnchors(srcByFile)
    const detail = missing.map(m => `${m.label} (${m.file} :: ${m.marker})`).join('\n')
    expect(missing, `以下挂点未挂 select-text:\n${detail}`).toEqual([])
  })

  it('自检：清单本身非空且条目字段完整', () => {
    expect(SELECTION_WHITELIST.length).toBeGreaterThan(0)
    for (const a of SELECTION_WHITELIST) {
      expect(a.file, a.label).toMatch(/^src\/renderer\//)
      expect(a.marker.length, a.label).toBeGreaterThan(0)
      expect(a.label.length, a.label).toBeGreaterThan(0)
    }
  })
})
