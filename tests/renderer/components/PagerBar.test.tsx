// @vitest-environment jsdom
/** 分页控制条（spec §5.4 / F13 / A4 / Review Focus 1） */
import {describe, it, expect, vi, afterEach} from 'vitest'
import {render, fireEvent, cleanup} from '@testing-library/react'
import {PagerBar, PagerBarProps} from '../../../src/renderer/components/sidebar/PagerBar'

afterEach(cleanup)
const setup = (over: Record<string, unknown> = {}) => {
    const onChange = vi.fn()
    const props = {listKey: 'section' as const, count: 6, defaultCount: 6, step: 10, total: 20, onChange, ...over} as unknown as PagerBarProps
    const utils = render(<PagerBar {...props}/>)
    const q = (n: string) => utils.container.querySelector(`[data-name="${n}"]`) as HTMLButtonElement | null
    return {onChange, q}
}

describe('PagerBar', () => {
    it('按钮盒 h-[16px]（2026-09-24 用户反馈：控制条整体再压一档），不再靠 p-0.5 自撑 ≈22px 高', () => {
        const {q} = setup({count: 16})
        const btn = q('pager-expand')!
        expect(btn.className).toContain('h-[16px]')
        expect(btn.className).toContain('w-6')
        expect(btn.className).not.toContain('p-0.5')
    })

    it('默认态：∧∧ 不渲染，∧∧∧ 渲染但 disabled，∨∨ 可点', () => {
        const {q} = setup()
        expect(q('pager-collapse')).toBeNull()
        expect(q('pager-reset')!.disabled).toBe(true)
        expect(q('pager-expand')!.disabled).toBe(false)
    })

    it('已翻页态：三枚齐出，按步长增减、复位回默认', () => {
        const {onChange, q} = setup({count: 16})
        fireEvent.click(q('pager-expand')!)
        expect(onChange).toHaveBeenCalledWith(26)
        fireEvent.click(q('pager-collapse')!)
        expect(onChange).toHaveBeenCalledWith(6)
        fireEvent.click(q('pager-reset')!)
        expect(onChange).toHaveBeenCalledWith(6)
        expect(q('pager-reset')!.disabled).toBe(false)
    })

    it('无页可翻时不渲染 ∨∨（不挂永远点不动的灰图标）', () => {
        const {q} = setup({count: 20, total: 20})
        expect(q('pager-expand')).toBeNull()
        expect(q('pager-collapse')).not.toBeNull()
    })

    it('总数为 0 时 ∨∨/∧∧ 均不渲染、∧∧∧ disabled（Review Focus 1）', () => {
        const {q} = setup({count: 0, total: 0})
        expect(q('pager-expand')).toBeNull()
        expect(q('pager-collapse')).toBeNull()
        expect(q('pager-reset')!.disabled).toBe(true)
    })

    it('三枚均为原生 button 且带 aria-label（A4）', () => {
        const {q} = setup({count: 16})
        expect(q('pager-expand')!.tagName).toBe('BUTTON')
        expect(q('pager-expand')!.getAttribute('aria-label')).toBe('展开下一页')
        expect(q('pager-collapse')!.getAttribute('aria-label')).toBe('收起一页')
        expect(q('pager-reset')!.getAttribute('aria-label')).toBe('回到默认条数')
    })

    it('三枚按钮的悬停提示挂在包裹层 title（与 aria-label 同文案）—— 由全局 TooltipPortal 接管', () => {
        // 2026-09-24 用户反馈：三枚此前只有 aria-label，悬停无提示，用户看不出图标作用。
        // 契约与 IconButton 一致（label 同时作 aria-label 与 title）；
        // title 必须在**包裹层**上：disabled 的 button 不接收 mouseover，挂在按钮上会漏掉置灰态
        //（∧∧∧ 未翻页时恒为 disabled —— 正是最常见的悬停对象）。
        const {q} = setup({count: 16})
        for (const [name, label] of [
            ['pager-expand', '展开下一页'],
            ['pager-collapse', '收起一页'],
            ['pager-reset', '回到默认条数'],
        ] as const) {
            const btn = q(name)!
            expect(btn.getAttribute('aria-label')).toBe(label)
            const holder = btn.parentElement as HTMLElement
            // 改前红：包裹层不存在（button 直接挂在容器下），title 为 null
            expect(holder.getAttribute('title')).toBe(label)
            expect(holder.className).toContain('inline-flex')
            expect(btn.getAttribute('title')).toBeNull()
        }
    })

    it('三枚按钮内容均为 SVG 图标（判别力：原为文字速记 ∨∨/∧∧/∧∧∧，改前该断言红）', () => {
        const {q} = setup({count: 16})
        for (const name of ['pager-expand', 'pager-collapse', 'pager-reset']) {
            const btn = q(name)!
            const svg = btn.querySelector('svg')
            expect(svg).not.toBeNull()
            expect(svg!.getAttribute('viewBox')).toBe('0 0 16 16')
            expect(svg!.getAttribute('aria-hidden')).toBe('true')
            expect(btn.textContent!.trim()).toBe('') // 不再含文字字符
        }
    })
})
