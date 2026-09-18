/**
 * 调度窗口（ui-09）· 偏好降低动效（设计契约 M5）
 *
 * 判据原文：「必须尊重 `prefers-reduced-motion`：该媒体查询下关闭 M1 的 ② 与 ③」。
 *
 * ⚠️ 本文件是**规则级**证据，不是渲染级证据。它只证明 `globals.css` 里确实存在一条
 * `@media (prefers-reduced-motion: reduce)` 规则、且该规则关闭了 Tailwind 的 `animate-spin`
 * 类名。它**不**证明浏览器在该偏好下真的算出了 `animation: none`——那需要真实样式引擎
 * （jsdom 不做层叠与媒体查询求值，任何在此处的「运行时」断言都是假绿）。
 * 之所以仍采用静态扫描：契约的判定方式是「无该覆盖即不通过」，而「覆盖」本身是
 * 可机械判定的源文本事实；把它钉住即可防止静默删除。
 *
 * 为什么 scope 是「所有 reduced-motion 块」而不是某一个块：M5 是全局承诺，
 * 规则落在哪个块里不重要，重要的是**存在**一条覆盖 `animate-spin` 的规则；
 * 若日后有人把它挪进只作用于别处的选择器，本测试的「覆盖块」集合里就再也找不到它。
 */
import {describe, it, expect} from 'vitest'
import {readFileSync} from 'fs'
import {join} from 'path'

const ROOT = process.cwd()
const CSS = join(ROOT, 'src/renderer/styles/globals.css')

/** 注释里的「示例代码」不是规则：先剥注释再解析 */
function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** 取出全部 `@media (prefers-reduced-motion: reduce) { … }` 的规则体（花括号配平）。 */
function reducedMotionBodies(css: string): string[] {
    const marker = '@media (prefers-reduced-motion: reduce)'
    const out: string[] = []
    let from = 0
    for (;;) {
        const at = css.indexOf(marker, from)
        if (at === -1) return out
        const start = css.indexOf('{', at)
        if (start === -1) return out
        let depth = 0
        let end = -1
        for (let i = start; i < css.length; i++) {
            if (css[i] === '{') depth++
            else if (css[i] === '}') {
                depth--
                if (depth === 0) {
                    end = i
                    break
                }
            }
        }
        if (end === -1) return out
        out.push(css.slice(start + 1, end))
        from = end + 1
    }
}

/** 本窗口内使用 `animate-spin` 的站点（M1 ③ 加载指示器）。 */
const SPIN_SITES = [
    'src/renderer/components/common/Switch.tsx',
    'src/renderer/components/ConfirmDialog.tsx',
    'src/renderer/components/dialogs/ScheduleListStates.tsx',
    'src/renderer/components/dialogs/ScheduleConversationsPanel.tsx',
    'src/renderer/components/dialogs/ScheduleScriptLogPanel.tsx',
]

const css = stripComments(readFileSync(CSS, 'utf-8'))

describe('偏好降低动效：媒体查询覆盖（M5）', () => {
    const bodies = reducedMotionBodies(css)

    it('globals.css 里存在 prefers-reduced-motion 覆盖块', () => {
        expect(
            bodies.length,
            'globals.css 里找不到任何 `@media (prefers-reduced-motion: reduce)` 规则块——M5 判定为「无该覆盖即不通过」',
        ).toBeGreaterThan(0)
    })

    it('覆盖块关闭 Tailwind 的 animate-spin（M1 ③ 加载指示器）', () => {
        const all = bodies.join('\n')
        const rule = /\.animate-spin\s*\{[^}]*animation\s*:\s*none\b/.exec(all)
        expect(
            rule?.[0],
            'reduced-motion 覆盖块里没有 `.animate-spin { animation: none; }`：' +
                'Tailwind 的 animate-spin 在本仓原先零覆盖（只有 Project Manager 作用域的 .pm-spin），\n' +
                `现有覆盖块内容：\n${all.trim()}`,
        ).toBeTruthy()
    })

    it('规则不是空转：本窗口确实有 animate-spin 站点', () => {
        const hitting = SPIN_SITES.filter(f => readFileSync(join(ROOT, f), 'utf-8').includes('animate-spin'))
        expect(
            hitting.length,
            '本窗口一处 animate-spin 都没有了——若确已移除，请一并删除上面那条规则级守卫（M5 不再需要它）',
        ).toBeGreaterThan(0)
    })
})
