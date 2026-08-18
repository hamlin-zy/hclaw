// @vitest-environment jsdom
import {describe, expect, it, beforeEach, vi} from 'vitest'
import {applyThemeClass} from '../../../src/renderer/lib/theme'

beforeEach(() => {
    // 清空上次用例残留的 class 与 inline 变量
    document.documentElement.className = ''
    document.documentElement.removeAttribute('style')
})

describe('applyThemeClass（主题 class 切换）', () => {
    it("'dark' → 加 dark、移除其他主题 class", () => {
        document.documentElement.classList.add('yuanshandai')
        applyThemeClass('dark')
        expect(document.documentElement.classList.contains('dark')).toBe(true)
        expect(document.documentElement.classList.contains('yuanshandai')).toBe(false)
        expect(document.documentElement.classList.contains('shiyangjin')).toBe(false)
    })

    it("'light' → 移除全部主题 class", () => {
        document.documentElement.classList.add('dark')
        applyThemeClass('light')
        expect(document.documentElement.classList.contains('dark')).toBe(false)
        expect(document.documentElement.classList.contains('yuanshandai')).toBe(false)
        expect(document.documentElement.classList.contains('shiyangjin')).toBe(false)
    })

    it("'yuanshandai' / 'shiyangjin' → 正确加对应 class", () => {
        applyThemeClass('yuanshandai')
        expect(document.documentElement.classList.contains('yuanshandai')).toBe(true)
        applyThemeClass('shiyangjin')
        expect(document.documentElement.classList.contains('shiyangjin')).toBe(true)
        expect(document.documentElement.classList.contains('yuanshandai')).toBe(false)
    })

    it('连续切换：dark → light 正确清除', () => {
        applyThemeClass('dark')
        applyThemeClass('light')
        expect(document.documentElement.classList.contains('dark')).toBe(false)
    })

    it('清除内联 CSS 变量（让 globals.css 选择器接管）', () => {
        document.documentElement.style.setProperty('--surface', '#1e1e1e')
        applyThemeClass('dark')
        expect(document.documentElement.style.getPropertyValue('--surface')).toBe('')
    })
})
