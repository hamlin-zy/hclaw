// tests/renderer/zIndexLayering.test.ts
/**
 * 防复发护栏：bg-enabled 毛玻璃豁免选择器 ↔ 固定定位弹窗层级（D2）
 *
 * 成因（本次复核实证）：globals.css 的毛玻璃豁免规则用
 *   `.bg-enabled .fixed.inset-0[class*="z-[999"]`
 * 命中「固定定位弹窗容器层」，但组件层级本轮从 z-[99998]/z-[99999] 提升为
 * z-[200000]/z-[200001]（ConfirmDialog / MCPErrorHelper），选择器不再命中 →
 * 开启自定义背景时弹窗遮罩的毛玻璃未被取消，同时注释仍写旧值。
 *
 * 本测试固化三条不变量：
 *   1. 豁免选择器的 z 前缀覆盖当前全部弹窗层级取值（含 z-[200000]/z-[200001]）；
 *   2. 不再残留窄前缀 `class*="z-[999"` 的过时选择器（改为分段前缀后消除）；
 *   3. ConfirmDialog ↔ MCPErrorHelper 的遮罩层 / 主体层取值同值不可漂移。
 *
 * 形式对齐 tests/renderer/themeTokenSync.test.ts：读源码做文本契约断言，不依赖真实布局。
 */
import {describe, it, expect} from 'vitest'
import {readFileSync, readdirSync} from 'fs'
import {join} from 'path'

const ROOT = process.cwd()
const CSS_PATH = join(ROOT, 'src/renderer/styles/globals.css')
const CSS = readFileSync(CSS_PATH, 'utf-8')

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

/** 豁免规则的选择器行：`.bg-enabled .fixed.inset-0[class*="z-[…"]` */
const selectorLines = CSS.split('\n').filter(l => l.includes('.bg-enabled .fixed.inset-0[class*='))

/** 选择器里的 z 前缀（如 `z-[9`、`z-[100`、`z-[20000`） */
const prefixes = selectorLines
  .map(l => l.match(/class\*="(z-\[[^"]*)"/)?.[1])
  .filter((p): p is string => !!p)

/** 某个完整类名（如 `z-[200001]`）是否被任一选择器前缀覆盖 */
const covers = (cls: string) => prefixes.some(p => cls.startsWith(p))

/** 毛玻璃豁免规则的注释块（用于断言层级说明已同步真实取值） */
const exemptComment = CSS.match(/\/\* 固定定位的弹窗容器层[\s\S]*?\*\//)?.[0] ?? ''

describe('globals.css — bg-enabled 毛玻璃豁免选择器（D2 契约）', () => {
  it('选择器前缀覆盖顶层确认弹窗层级 z-[200000] / z-[200001]', () => {
    expect(prefixes.length).toBeGreaterThan(0)
    expect(covers('z-[200000]')).toBe(true)
    expect(covers('z-[200001]')).toBe(true)
  })

  it('不再残留窄前缀 z-[999 的过时选择器', () => {
    expect(selectorLines.some(l => l.includes('class*="z-[999'))).toBe(false)
    expect(CSS).not.toMatch(/\[class\*="z-\[999/)
  })

  it('注释已同步为真实层级取值（含 z-[200000] / z-[200001]）', () => {
    expect(exemptComment).toContain('z-[200000]')
    expect(exemptComment).toContain('z-[200001]')
  })

  it('全部 fixed inset-0 弹窗容器的数字层级都被豁免选择器命中', () => {
    const zValues = new Set<string>()
    for (const file of walkSources(join(ROOT, 'src/renderer'))) {
      for (const line of readFileSync(file, 'utf-8').split('\n')) {
        if (!line.includes('fixed') || !line.includes('inset-0')) continue
        for (const m of line.matchAll(/z-\[(\d+)/g)) zValues.add(m[1])
      }
    }
    // 防空扫：清点集必须非空（否则断言会退化成空真）
    expect(zValues.size).toBeGreaterThan(0)
    const uncovered = [...zValues].filter(v => !covers(`z-[${v}]`))
    expect(uncovered).toEqual([])
  })
})

describe('ConfirmDialog ↔ MCPErrorHelper 层级约定（同值不可漂移）', () => {
  const CD = readFileSync(join(ROOT, 'src/renderer/components/ConfirmDialog.tsx'), 'utf-8')
  const ME = readFileSync(join(ROOT, 'src/renderer/components/dialogs/MCPErrorHelper.tsx'), 'utf-8')

  const MASK_RE = /fixed inset-0 bg-black\/40 backdrop-blur-sm z-\[(\d+)\]/
  const BODY_RE = /fixed inset-0 flex items-center justify-center p-4 pointer-events-none z-\[(\d+)\]/

  const cdMask = CD.match(MASK_RE)?.[1]
  const cdBody = CD.match(BODY_RE)?.[1]
  const meMask = ME.match(MASK_RE)?.[1]
  const meBody = ME.match(BODY_RE)?.[1]

  it('两文件的遮罩层 / 主体层取值逐一相等', () => {
    expect(cdMask).toBeTruthy()
    expect(cdBody).toBeTruthy()
    expect(cdMask).toBe(meMask)
    expect(cdBody).toBe(meBody)
  })

  it('遮罩层在下、主体层在上：200000 / 200001，且与 CSS 豁免前缀一致', () => {
    expect(cdMask).toBe('200000')
    expect(cdBody).toBe('200001')
    expect(Number(cdBody)).toBeGreaterThan(Number(cdMask))
    expect(covers(`z-[${cdMask}]`)).toBe(true)
    expect(covers(`z-[${cdBody}]`)).toBe(true)
  })
})
