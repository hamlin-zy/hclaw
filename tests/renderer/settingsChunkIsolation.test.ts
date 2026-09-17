// tests/renderer/settingsChunkIsolation.test.ts
/**
 * 设置页 chunk 隔离 — 源码级契约护栏（spec §6.2 / §6.6）
 *
 * 为什么需要它：
 *   设置子树「脱出泛 chunk、非设置窗口不再携带设置页代码」（perf 提交）靠两件事同时成立——
 *   ① vite manualChunks 里 `settings/` 规则排在泛 `/components/` 规则**之前**（后者会把
 *      设置页整棵子树吸进 components-ui，设置窗口与主窗口共享 → 主窗口也打包设置页）；
 *   ② 设置子树**没有静态越界引用**（静态 import 会让它重新进入某个同步 chunk；
 *      唯一允许的外部入口是 ConfigDialogWindow 的**动态** import）。
 *   两者都是「没人会故意改坏、但一次顺手重构就会静默回退」的形态，且构建产物不在单测范围内
 *   （本测试不跑构建），故以源码文本 + 引用关系钉住。
 *
 * 为什么平铺在 tests/renderer/ 根？
 *   仓库惯例：跨切面的护栏平铺在根目录（themeTokenSync / noNativeDialogs / priceEditing /
 *   tokenCompliance.capabilityPages 一类），按关注点新开子目录不成体系。
 *
 * 作用域口径：断言 ② 遍历 `src/**`（排除设置子树自身）——「静态 import 设置子树」在全仓任何
 *   位置都不该出现。注意：`src/main/settings/**`（主进程写后传播助手）是**另一个**目录，
 *   与本护栏无关，靠「解析后落在 renderer 设置子树内」判定区分，不做 `/settings/` 泛匹配。
 */
import {describe, expect, it} from 'vitest'
import {readdirSync, readFileSync, statSync} from 'fs'
import {dirname, join, resolve} from 'path'

const ROOT = join(__dirname, '../..')
const SETTINGS_SUBTREE = 'src/renderer/components/settings'

/** 递归收集目录下所有 .ts/.tsx 的仓库相对路径（/ 分隔） */
function walk(relDir: string): string[] {
    const out: string[] = []
    for (const name of readdirSync(join(ROOT, relDir))) {
        const rel = `${relDir}/${name}`
        if (statSync(join(ROOT, rel)).isDirectory()) out.push(...walk(rel))
        else if (/\.tsx?$/.test(name)) out.push(rel)
    }
    return out
}

/** 静态模块说明符：`from '…'`（含 export … from）与副作用 `import '…'`；动态 `import('…')` 不匹配 */
function staticSpecifiers(src: string): string[] {
    return [
        ...src.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g),
        ...src.matchAll(/\bimport\s*['"]([^'"]+)['"]/g),
    ].map(m => m[1])
}

/** 说明符是否指向 renderer 设置子树（相对路径按文件所在目录解析） */
function targetsSettingsSubtree(specifier: string, fromFile: string): boolean {
    if (specifier.startsWith('.')) {
        const abs = resolve(ROOT, dirname(fromFile), specifier).replace(/\\/g, '/')
        return abs.startsWith(join(ROOT, SETTINGS_SUBTREE).replace(/\\/g, '/') + '/')
    }
    return specifier.includes('components/settings/')
}

describe('设置页 chunk 隔离（源码级契约）', () => {
    it('vite：settings/ 规则排在泛 /components/ 规则之前（否则设置页被吸进 components-ui）', () => {
        const src = readFileSync(join(ROOT, 'vite.renderer.config.mjs'), 'utf8')
        const settingsIdx = src.indexOf("id.includes('/components/settings/')")
        const genericIdx = src.indexOf("id.includes('/components/')")
        expect(settingsIdx, 'vite.renderer.config.mjs 缺少 settings 子树规则').toBeGreaterThan(-1)
        expect(genericIdx, 'vite.renderer.config.mjs 缺少泛 /components/ 规则').toBeGreaterThan(-1)
        expect(
            settingsIdx,
            'settings 规则必须排在泛 /components/ 规则之前：manualChunks 是顺序 if 链，规则一旦被前移到后面（或 settings 规则被删），设置页就会落进 components-ui 同步 chunk',
        ).toBeLessThan(genericIdx)
    })

    it('settings 子树无静态越界引用（唯一外部入口是 ConfigDialogWindow 的动态 import）', () => {
        const offenders = walk('src')
            .filter(f => !f.startsWith(`${SETTINGS_SUBTREE}/`))
            .map(f => ({f, src: readFileSync(join(ROOT, f), 'utf8')}))
            .flatMap(({f, src}) =>
                staticSpecifiers(src)
                    .filter(s => targetsSettingsSubtree(s, f))
                    .map(s => `${f}: ${s}`),
            )
        expect(
            offenders,
            `以下位置**静态**引用了设置子树——静态引用会把它拉回同步 chunk，破坏「非设置窗口不携带设置页代码」：\n${offenders.join('\n')}`,
        ).toEqual([])

        // 正向钉住唯一允许的入口：动态 import（不写死行号，宽松匹配 import( + settings 路径）
        const entry = readFileSync(join(ROOT, 'src/renderer/components/ConfigDialogWindow.tsx'), 'utf8')
        expect(
            /import\(\s*['"][^'"]*settings\/[^'"]*['"]/.test(entry),
            'ConfigDialogWindow.tsx 里对 settings 子树的动态 import 不见了——设置窗口将无法按需加载设置页',
        ).toBe(true)
    })
})
