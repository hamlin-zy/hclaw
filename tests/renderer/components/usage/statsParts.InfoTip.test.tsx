// @vitest-environment jsdom
/**
 * InfoTip 横向锚边回归测试
 *
 * 背景：浮层宽 288px（w-72），旧实现恒为右对齐（right-0，向左展开）。
 * 触发器贴近窗口左缘时（工具栏「本周 / 本月」的 ? 图标 left ≈ 157），
 * 浮层左边界 = 173 - 288 = -115 → 溢出到窗口左侧外不可见。
 * 期望：左侧空间不足时自动改为左对齐（left-0，向右展开）。
 */
import {describe, it, expect} from 'vitest'
import {render, screen, fireEvent} from '@testing-library/react'
import {InfoTip} from '../../../../src/renderer/components/usage/statsParts'

/** getBoundingClientRect 桩：仅 left / right 参与锚边判断 */
const rectOf = (left: number, width = 16): DOMRect => ({
    left, right: left + width, width, top: 0, bottom: width, height: width, x: left, y: 0,
    toJSON: () => ({}),
}) as DOMRect

describe('InfoTip 横向锚边', () => {
    it('触发器贴近窗口左缘 → 浮层左对齐（left-0），不再向左溢出窗口', () => {
        render(<InfoTip text="口径说明"/>)
        const tip = screen.getByText('口径说明')
        const trigger = tip.parentElement as HTMLElement
        // 默认右对齐（向左展开）
        expect(tip.className).toContain('right-0')

        // 模拟工具栏「本周」图标位置：距窗口左缘 40px，左侧空间不足以容纳 288px 浮层
        trigger.getBoundingClientRect = () => rectOf(40)
        fireEvent.mouseEnter(trigger)

        expect(tip.className).toContain('left-0')
        expect(tip.className).not.toContain('right-0')
    })

    it('触发器左侧空间充足 → 保持右对齐', () => {
        render(<InfoTip text="口径说明"/>)
        const tip = screen.getByText('口径说明')
        const trigger = tip.parentElement as HTMLElement

        // 窗口宽 1024：触发器 left = 700，左侧空间充足
        trigger.getBoundingClientRect = () => rectOf(700)
        fireEvent.mouseEnter(trigger)

        expect(tip.className).toContain('right-0')
        expect(tip.className).not.toContain('left-0')
    })

    it('口径文案随浮层常驻 DOM（hover 仅切换可见性），锚边切换不影响文案渲染', () => {
        render(<InfoTip text="口径说明"/>)
        expect(screen.getByText('口径说明')).toBeTruthy()
    })
})
