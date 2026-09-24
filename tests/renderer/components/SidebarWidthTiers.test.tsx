// @vitest-environment jsdom
/** 窄宽度降级（spec §5.3.4 / V4 / C5） */
import {describe, it, expect} from 'vitest'
import {widthTier} from '../../../src/renderer/lib/sidebarWidthTier'
import {SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MIN_WIDTH} from '../../../src/renderer/stores/sidebarStore'

describe('宽度档位', () => {
    it('≥320 完整 / 270–319 窄 / <270 极窄（阈值按项目名最小可用宽度重算）', () => {
        expect(widthTier(480)).toBe('full')
        expect(widthTier(320)).toBe('full')
        expect(widthTier(319)).toBe('narrow')
        expect(widthTier(270)).toBe('narrow')
        expect(widthTier(269)).toBe('tight')
        expect(widthTier(180)).toBe('tight')
    })

    it('默认宽度 320 落在 full（段头条数常显）；下限 180 落在 tight（C5）', () => {
        expect(SIDEBAR_DEFAULT_WIDTH).toBe(320)
        expect(widthTier(SIDEBAR_DEFAULT_WIDTH)).toBe('full')
        expect(widthTier(SIDEBAR_MIN_WIDTH)).toBe('tight')
    })
})
