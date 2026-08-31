// @vitest-environment jsdom
/**
 * TooltipPortal — hover 事件语义回归测试
 *
 * 修复前：mouseover/mouseout 在元素与子元素之间移动时也成对触发，
 * 按钮内部（状态点/文案 span/svg 箭头）微微移动即触发 mouseout →
 * setTooltip(null) 隐藏 → 随后的 mouseover 再显示，表现为 tooltip
 * "hover 闪一下就消失"。
 *
 * 修复方案：引入 mouseenter/mouseleave 语义（relatedTarget 判断）——
 * 鼠标在元素内部（含子元素）移动不隐藏、不重置；只有真正离开元素才隐藏。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, fireEvent, cleanup, act} from '@testing-library/react'
import TooltipPortal from '../../../../src/renderer/components/common/TooltipPortal'

/** 渲染 portal + 一个带 title 的按钮（内含子元素，模拟方案选择器按钮结构） */
function renderSubject() {
    const {container} = render(
        <>
            <TooltipPortal/>
            <button title="完整提示文本" data-testid="target">
                <span data-testid="child">子元素</span>
            </button>
        </>,
    )
    const btn = container.querySelector('[data-testid="target"]')!
    const child = container.querySelector('[data-testid="child"]')!
    // portal 挂载在 document.body（render 容器之外），需从 body 查询
    const tip = () => document.querySelector('.tooltip-portal')
    return {btn, child, tip}
}

beforeEach(() => cleanup())
afterEach(() => cleanup())

describe('TooltipPortal hover 语义', () => {
    it('hover 进入显示 tooltip，并移除原生 title 避免双提示', () => {
        const {btn, tip} = renderSubject()
        fireEvent.mouseOver(btn)
        expect(tip()!.textContent).toContain('完整提示文本')
        // 原生 title 被接管（否则与主题化 tooltip 双显示）
        expect(btn.getAttribute('title')).toBeNull()
    })

    it('鼠标移到元素内部子元素：mouseout 不隐藏 tooltip（闪一下消失回归）', () => {
        const {btn, child, tip} = renderSubject()
        fireEvent.mouseOver(btn)
        expect(tip()!.textContent).toContain('完整提示文本')
        // 按钮 → 子元素：mouseout 的 relatedTarget 在按钮内 → 视为内部移动
        fireEvent.mouseOut(btn, {relatedTarget: child})
        expect(tip()!.textContent).toContain('完整提示文本')
        // 子元素 → 按钮：mouseover 的 relatedTarget 在按钮内 → 不重置
        fireEvent.mouseOver(child, {relatedTarget: btn})
        expect(tip()!.textContent).toContain('完整提示文本')
    })

    it('鼠标真正离开元素：隐藏 tooltip 并恢复原生 title', () => {
        const {btn, tip} = renderSubject()
        const outside = document.createElement('div')
        document.body.appendChild(outside)
        fireEvent.mouseOver(btn)
        expect(tip()!.textContent).toContain('完整提示文本')
        // 按钮 → 外部元素：relatedTarget 不在按钮内 → 隐藏 + 恢复 title
        fireEvent.mouseOut(btn, {relatedTarget: outside})
        // opacity 0 时内容仍占位（'' 清空）
        expect(tip()!.textContent).toBe('')
        expect(btn.getAttribute('title')).toBe('完整提示文本')
        outside.remove()
    })

    it('无 title 的空白区域 mouseover：延迟隐藏定时器不残留后续显示', () => {
        const {btn, tip} = renderSubject()
        const blank = document.createElement('div')
        document.body.appendChild(blank)
        fireEvent.mouseOver(btn)
        expect(tip()!.textContent).toContain('完整提示文本')
        // 移出到空白（无 title）：mouseout 命中按钮 → 隐藏
        fireEvent.mouseOut(btn, {relatedTarget: blank})
        expect(tip()!.textContent).toBe('')
        blank.remove()
    })

    it('移到命中选择器但无文本的元素：旧 tooltip 必须被隐藏（滞留回归）', () => {
        vi.useFakeTimers()
        try {
            const {container} = render(
                <>
                    <TooltipPortal/>
                    <button title="提示A" data-testid="a">A</button>
                    <span data-tooltip-active="1" data-testid="b">B</span>
                </>,
            )
            const a = container.querySelector('[data-testid="a"]')!
            const b = container.querySelector('[data-testid="b"]')!
            fireEvent.mouseOver(a)
            expect(document.querySelector('.tooltip-portal')!.textContent).toContain('提示A')
            // 悬停到命中选择器但无 tooltip 文本的元素（如重渲染后残留的
            // data-tooltip-active 标记）：修复前 handleMouseOver 走 !text 提前
            // return，既不排隐藏 timer 也不清 tooltip → 旧 tooltip 永久滞留
            fireEvent.mouseOver(b)
            // setTooltip(null) 在 timer 回调中触发，需 act 包裹让 React 刷新 DOM
            act(() => {
                vi.advanceTimersByTime(150)
            })
            expect(document.querySelector('.tooltip-portal')!.textContent).toBe('')
            // 残留标记被清理：元素退出选择器命中范围
            expect(b.getAttribute('data-tooltip-active')).toBeNull()
        } finally {
            vi.useRealTimers()
        }
    })

    it('data-tooltip-placement="right"：tooltip 锚定元素右侧（折叠态图标场景）', () => {
        const {container} = render(
            <>
                <TooltipPortal/>
                <button title="任务历史" data-tooltip-placement="right" data-testid="collapse-icon">
                    <svg/>
                </button>
            </>,
        )
        const btn = container.querySelector('[data-testid="collapse-icon"]')!
        fireEvent.mouseOver(btn)
        const tipEl = document.querySelector('.tooltip-portal')!
        expect(tipEl.textContent).toContain('任务历史')
        // 右侧锚定：垂直居中（translateY(-50%)），水平不居中、左对齐向右延伸，
        // 窄条（36px）下长文本不会向左溢出窗口边缘
        expect(tipEl.getAttribute('style')).toContain('translateY(-50%)')
    })

    it('居中放置会越过元素左缘时：tooltip 左缘钳制对齐元素左缘（会话列表左溢出回归）', () => {
        const {container} = render(
            <>
                <TooltipPortal/>
                <button title="完整提示文本" data-testid="target">
                    <span>子元素</span>
                </button>
            </>,
        )
        const btn = container.querySelector('[data-testid="target"]')!
        // 模拟贴近窗口左缘的会话列表项：left=10, width=40 → 居中锚点 x=30，
        // tooltip 宽 200 → 居中时左缘 -70 < 10，必须钳制到元素左缘
        vi.spyOn(btn, 'getBoundingClientRect').mockReturnValue({
            left: 10, top: 100, right: 50, bottom: 130, width: 40, height: 30,
            x: 10, y: 100, toJSON: () => ({}),
        } as DOMRect)
        fireEvent.mouseOver(btn)
        const tipEl = document.querySelector('.tooltip-portal') as HTMLElement
        expect(tipEl.textContent).toContain('完整提示文本')
        Object.defineProperty(tipEl, 'offsetWidth', {value: 200, configurable: true})
        // 触发重渲染以执行 useLayoutEffect 钳制
        fireEvent.mouseOver(btn)
        expect(tipEl.style.left).toBe('10px')
        expect(tipEl.style.transform).not.toContain('-50%')
    })

    it('快速扫过多个无 title 元素后进入 icon：旧隐藏定时器不泄漏（闪现消失竞态）', () => {
        vi.useFakeTimers()
        try {
            const {container} = render(
                <>
                    <TooltipPortal/>
                    <button title="完整提示文本" data-testid="target">
                        <span data-testid="child">子元素</span>
                    </button>
                </>,
            )
            const btn = container.querySelector('[data-testid="target"]')!
            // 模拟从右侧快速进入：连续扫过两个无 title 元素（每个都设置 hideTimer）
            const blank1 = document.createElement('div')
            const blank2 = document.createElement('div')
            document.body.append(blank1, blank2)
            fireEvent.mouseOver(blank1)
            fireEvent.mouseOver(blank2)
            // 进入带 title 的图标：显示 tooltip，只清除最后一个 hideTimer
            fireEvent.mouseOver(btn)
            const tip = () => document.querySelector('.tooltip-portal')!
            expect(tip().textContent).toContain('完整提示文本')
            // 100ms 后旧 timer 若泄漏会 setTooltip(null) → tooltip 消失（闪一下根因）
            vi.advanceTimersByTime(150)
            expect(tip().textContent).toContain('完整提示文本')
        } finally {
            vi.useRealTimers()
        }
    })
})
