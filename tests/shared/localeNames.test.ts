/**
 * locale → 母语显示名映射（spec §6.4）
 *
 * worker 侧（注入文案 "Reply to the user in 简体中文"）与渲染端设置页共用本表；
 * 关键契约：任何输入都能得到可读串，绝不返回 undefined 以外的半成品 ——
 * undefined 是"跳过注入"的信号，不是"渲染成 'undefined'"。
 */
import {describe, expect, it} from 'vitest'
import {localeDisplayName, SELECTABLE_LOCALES, SYSTEM_LOCALE, systemLocaleLabel} from '@shared/localeNames'

describe('localeDisplayName', () => {
    it('精确命中', () => {
        expect(localeDisplayName('zh-CN')).toBe('简体中文')
        expect(localeDisplayName('en')).toBe('English')
    })

    it('子标签回退：en-GB → en', () => {
        expect(localeDisplayName('en-GB')).toBe('English')
        expect(localeDisplayName('ja-JP')).toBe('日本語')
    })

    it('表外 locale 回退原始串（宁可英文串也不给 undefined）', () => {
        expect(localeDisplayName('xx-YY')).toBe('xx-YY')
    })

    it('原型链键名不泄漏：Object.prototype 成员不被当作命中', () => {
        // 回归：查表若走原型链，'constructor' 会返回函数、'__proto__' 会返回对象，
        // 而调用方把非空结果直接冻结进文案（"Reply to the user in …"）——
        // 故此处断言契约本身：结果只能是 undefined（跳过注入）或原样回显的输入串。
        for (const key of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
            const result = localeDisplayName(key)
            expect(result === undefined || typeof result === 'string', key).toBe(true)
            if (typeof result === 'string') expect(result, key).toBe(key)
        }
        // 未命中且无子标签的未知 locale 仍回退为自身
        expect(localeDisplayName('xx')).toBe('xx')
    })

    it('空值返回 undefined：调用方据此跳过注入', () => {
        expect(localeDisplayName(undefined)).toBeUndefined()
        expect(localeDisplayName(null)).toBeUndefined()
        expect(localeDisplayName('')).toBeUndefined()
        expect(localeDisplayName('   ')).toBeUndefined()
    })
})

describe('SELECTABLE_LOCALES', () => {
    it('每项 value 均在映射表内且 label 非空（设置页下拉不出现空标签）', () => {
        expect(SELECTABLE_LOCALES.length).toBeGreaterThanOrEqual(2)
        for (const item of SELECTABLE_LOCALES) {
            expect(localeDisplayName(item.value), item.value).toBe(item.label)
            expect(item.label.length).toBeGreaterThan(0)
        }
    })

    it('手选项收敛为「简体中文 + 英语」（跟随系统由哨兵项另行提供）', () => {
        expect(SELECTABLE_LOCALES.map(o => o.value)).toEqual(['zh-CN', 'en'])
        expect(SELECTABLE_LOCALES.map(o => o.label)).toEqual(['简体中文', 'English'])
    })
})

describe('SYSTEM_LOCALE / systemLocaleLabel', () => {
    it('哨兵不落进 localeDisplayName 的回退链：取不到显示名 → 调用方跳过注入', () => {
        // 回归：若哨兵走上「表外 locale 原样回显」分支，worker 会注入 "Reply to the user in system"
        expect(localeDisplayName(SYSTEM_LOCALE)).toBeUndefined()
    })

    it('标签带当前系统语言显示名', () => {
        expect(systemLocaleLabel('zh-CN')).toBe('跟随系统(简体中文)')
        expect(systemLocaleLabel('en-US')).toBe('跟随系统(English)')
        expect(systemLocaleLabel('fr-FR')).toBe('跟随系统(Français)')
    })

    it('系统语言未知时退化为纯标签，不渲染 (undefined)', () => {
        expect(systemLocaleLabel(undefined)).toBe('跟随系统')
        expect(systemLocaleLabel(null)).toBe('跟随系统')
        expect(systemLocaleLabel('')).toBe('跟随系统')
        expect(systemLocaleLabel('   ')).toBe('跟随系统')
    })
})
