// @vitest-environment jsdom
import {describe, it, expect} from 'vitest'
import {computeModeAvailWidth} from '../../../src/renderer/components/InputToolbar'

/**
 * 模式组可用宽度纯函数。
 * jsdom 无布局引擎（clientWidth/scrollWidth 恒为 0），只能对纯函数断言真实窗口场景。
 * 公式：toolbar − min(statusText, 96) − rest − send − 28（间隙预算），下限 0。
 */
describe('computeModeAvailWidth', () => {
    it('用户实际窗口场景 {815, 190, 530, 24} → 137（≥117 → 两个折叠胶囊，不再整组隐藏）', () => {
        const w = computeModeAvailWidth({toolbarW: 815, statusTextW: 190, restW: 530, sendW: 24})
        expect(w).toBe(137)
        expect(w).toBeGreaterThanOrEqual(117) // level 1：两组折叠胶囊
    })

    it('状态文案短（60px）→ 不让渡额外空间之外的差异', () => {
        expect(computeModeAvailWidth({toolbarW: 815, statusTextW: 60, restW: 530, sendW: 24})).toBe(173)
    })

    it('状态文案超长按 STATUS_MAX_RESERVE(96) 封顶（190 与 1000 同结果）', () => {
        const a = computeModeAvailWidth({toolbarW: 815, statusTextW: 190, restW: 530, sendW: 24})
        const b = computeModeAvailWidth({toolbarW: 815, statusTextW: 1000, restW: 530, sendW: 24})
        expect(a).toBe(137)
        expect(b).toBe(137)
    })

    it('窗口极窄 → 下限 0（不为负）', () => {
        expect(computeModeAvailWidth({toolbarW: 300, statusTextW: 190, restW: 530, sendW: 24})).toBe(0)
    })

    it('宽窗口（1200）→ 完整展开档（≥243）', () => {
        const w = computeModeAvailWidth({toolbarW: 1200, statusTextW: 190, restW: 530, sendW: 24})
        expect(w).toBe(522)
        expect(w).toBeGreaterThanOrEqual(243) // level 0：完整展开
    })
})
