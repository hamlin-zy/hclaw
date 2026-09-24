/** 最近会话区高度 clamp（spec §5.6 / F12 / Review Focus 3） */
import {describe, it, expect} from 'vitest'
import {clampRecentHeight} from '../../../src/renderer/lib/recentHeight'

describe('clampRecentHeight', () => {
    it('上限 = 主列表高度的一半、下限 = 一行高度', () => {
        expect(clampRecentHeight(600, 800, 30)).toBe(400)
        expect(clampRecentHeight(5, 800, 30)).toBe(30)
        expect(clampRecentHeight(200, 800, 30)).toBe(200)
    })

    it('主列表极矮时仍不小于一行（不出现空壳）', () => {
        expect(clampRecentHeight(200, 40, 30)).toBe(30)
    })

    it('主列表高度为 0 时退回一行高度', () => {
        expect(clampRecentHeight(120, 0, 28)).toBe(28)
    })
})
