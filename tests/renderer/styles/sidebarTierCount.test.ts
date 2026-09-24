import {describe, it, expect} from 'vitest'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'

/**
 * 紧档（<200）条数列隐藏（spec §5.3.4「依次让位」）：
 * 窄档（narrow）已藏条数列，紧档（tight）必须继承 —— CSS 规则级守卫。
 */
describe('is-tight 继承条数列隐藏', () => {
    it('globals.css 含 .is-tight [data-name="section-count"] { display: none; }', () => {
        const css = readFileSync(join(__dirname, '../../../src/renderer/styles/globals.css'), 'utf8')
        expect(css).toContain('.is-tight [data-name="section-count"]')
        // 同款口径：narrow 档的既有规则必须在场（判别力锚点）
        expect(css).toContain('.is-narrow [data-name="section-count"]')
    })
})
