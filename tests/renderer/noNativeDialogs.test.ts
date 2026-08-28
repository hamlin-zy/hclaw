import {describe, it, expect} from 'vitest'
import {readFileSync, readdirSync} from 'fs'
import {join} from 'path'

/** 递归收集目录下所有 .ts/.tsx 文件 */
function walk(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
            out.push(...walk(full))
        } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
            out.push(full)
        }
    }
    return out
}

describe('renderer 无原生弹窗残留', () => {
    it('无 window.confirm / alert / prompt 调用', () => {
        const offenders = walk(join(__dirname, '../../src/renderer'))
            .map(f => ({f, src: readFileSync(f, 'utf8')}))
            .filter(({src}) => /window\.(confirm|alert|prompt)\s*\(/.test(src))
        expect(offenders.map(o => o.f)).toEqual([])
    })

    it('无裸 alert( / prompt( 调用（不含属性访问如 .alert(，及自研 confirm 组件）', () => {
        const offenders = walk(join(__dirname, '../../src/renderer'))
            .map(f => ({f, src: readFileSync(f, 'utf8')}))
            .filter(({src}) => /(^|[^.\w])(alert|prompt)\s*\(/.test(src))
        expect(offenders.map(o => o.f)).toEqual([])
    })
})
