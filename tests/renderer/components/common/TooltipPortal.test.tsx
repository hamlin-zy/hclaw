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

    it('居中放置会越过窗口右缘时：tooltip 右缘钳制对齐窗口内缘（右下角按钮溢出回归）', () => {
        const {container} = render(
            <>
                <TooltipPortal/>
                <button title="折叠右侧面板 (Ctrl+Shift+B)" data-testid="target">
                    <svg/>
                </button>
            </>,
        )
        const btn = container.querySelector('[data-testid="target"]')!
        // 模拟右下角按钮：jsdom 视口宽 1024，按钮 left=974, width=40 → 居中锚点 x=994，
        // tooltip 宽 200 → 居中时右缘 1094 > 1024-8=1016，必须钳制到窗口右缘内
        vi.spyOn(btn, 'getBoundingClientRect').mockReturnValue({
            left: 974, top: 900, right: 1014, bottom: 930, width: 40, height: 30,
            x: 974, y: 900, toJSON: () => ({}),
        } as DOMRect)
        fireEvent.mouseOver(btn)
        const tipEl = document.querySelector('.tooltip-portal') as HTMLElement
        expect(tipEl.textContent).toContain('折叠右侧面板')
        Object.defineProperty(tipEl, 'offsetWidth', {value: 200, configurable: true})
        // 触发重渲染以执行 useLayoutEffect 钳制
        fireEvent.mouseOver(btn)
        // 右缘钳制：改用右缘锚定（left:auto + right:TOOLTIP_EDGE_MARGIN），浮层从
        // 右缘向左展开 → shrink-to-fit 可用宽度变为整个视口宽，不再被
        // 「视口宽 − left」压到 min-content 逐字换行（本 bug 的根因）
        expect(tipEl.style.left).toBe('auto')
        expect(tipEl.style.right).toBe('8px')
        // X 方向位移必须取消（translateX(-100%) / -50% 会让文本继续压在窄空间里），
        // 仅保留 Y 翻转（top=900 已越过 jsdom 视口底部 768 → placement=above）
        expect(tipEl.style.transform).toBe('translateY(-100%)')
    })

    it('右缘钳制且位于元素下方：取消 X 位移但保留下方定位（Y 翻转语义不回归）', () => {
        const {container} = render(
            <>
                <TooltipPortal/>
                <button title="刷新" data-testid="target">
                    <svg/>
                </button>
            </>,
        )
        const btn = container.querySelector('[data-testid="target"]')!
        // 贴右缘但仍在视口上半部：x=920，tooltip 宽 200 → 右缘 1020 > 1016 需右缘钳制；
        // spaceBelow = 768 - 130 = 638 → placement=below
        vi.spyOn(btn, 'getBoundingClientRect').mockReturnValue({
            left: 900, top: 100, right: 940, bottom: 130, width: 40, height: 30,
            x: 900, y: 100, toJSON: () => ({}),
        } as DOMRect)
        fireEvent.mouseOver(btn)
        const tipEl = document.querySelector('.tooltip-portal') as HTMLElement
        Object.defineProperty(tipEl, 'offsetWidth', {value: 200, configurable: true})
        fireEvent.mouseOver(btn)
        expect(tipEl.style.left).toBe('auto')
        expect(tipEl.style.right).toBe('8px')
        // below 路径无 Y 位移，X 位移同样取消
        expect(tipEl.style.transform).toBe('none')
        expect(tipEl.style.top).toBe('136px')
    })

    // ⚠️ 现状特征锁定，**不是期望语义**（既有 gap，见 task-ba3ef213）：
    // leftEdge 分支返回 left:8，而 placement='left' 的 transform 恒为 translate(-100%,-50%)，
    // 几何上浮层占据 [-w+8, 8] → 几乎整体落在窗口左缘之外，与「钳制到窗口内缘」的字面意图相反。
    // 修该 bug 时本用例必须一并修改，并在真实 Chrome 中复测（jsdom 无布局引擎）。
    it('data-tooltip-placement="left" 溢出窗口左缘：落到 leftEdge 分支（现状特征，既有 gap）', () => {
        const {container} = render(
            <>
                <TooltipPortal/>
                <button title="定位" data-tooltip-placement="left" data-testid="target">
                    <svg/>
                </button>
            </>,
        )
        const btn = container.querySelector('[data-testid="target"]')!
        // 贴窗口左缘：x = rect.left - 6 = 0，tooltip 宽 200 → 右缘锚定时左缘 -200 越界
        vi.spyOn(btn, 'getBoundingClientRect').mockReturnValue({
            left: 6, top: 300, right: 34, bottom: 330, width: 28, height: 30,
            x: 6, y: 300, toJSON: () => ({}),
        } as DOMRect)
        fireEvent.mouseOver(btn)
        const tipEl = document.querySelector('.tooltip-portal') as HTMLElement
        Object.defineProperty(tipEl, 'offsetWidth', {value: 200, configurable: true})
        fireEvent.mouseOver(btn)
        // leftEdge：右缘锚定到窗口内缘 8px，left 路径的 translate(-100%, -50%) 保留
        expect(tipEl.style.left).toBe('8px')
        expect(tipEl.style.right).toBe('auto')
        expect(tipEl.style.transform).toBe('translate(-100%, -50%)')
    })

    it('默认居中且不越界：保持 translateX(-50%) 居中（不回归）', () => {
        const {container} = render(
            <>
                <TooltipPortal/>
                <button title="刷新" data-testid="target">
                    <svg/>
                </button>
            </>,
        )
        const btn = container.querySelector('[data-testid="target"]')!
        vi.spyOn(btn, 'getBoundingClientRect').mockReturnValue({
            left: 400, top: 100, right: 440, bottom: 130, width: 40, height: 30,
            x: 400, y: 100, toJSON: () => ({}),
        } as DOMRect)
        fireEvent.mouseOver(btn)
        const tipEl = document.querySelector('.tooltip-portal') as HTMLElement
        // 窄浮层：x=420 居中 → 410..430，未越右缘（>1016）也未越过元素左缘（minX=400）
        Object.defineProperty(tipEl, 'offsetWidth', {value: 20, configurable: true})
        fireEvent.mouseOver(btn)
        expect(tipEl.style.left).toBe('420px')
        expect(tipEl.style.right).toBe('auto')
        expect(tipEl.style.transform).toBe('translateX(-50%)')
    })

    it('默认居中：下方空间不足时翻转到元素上方（translate(-50%,-100%)）', () => {
        const {container} = render(
            <>
                <TooltipPortal/>
                <button title="刷新" data-testid="target">
                    <svg/>
                </button>
            </>,
        )
        const btn = container.querySelector('[data-testid="target"]')!
        // bottom=730 → spaceBelow = 38 < 42 → placement=above
        vi.spyOn(btn, 'getBoundingClientRect').mockReturnValue({
            left: 400, top: 700, right: 440, bottom: 730, width: 40, height: 30,
            x: 400, y: 700, toJSON: () => ({}),
        } as DOMRect)
        fireEvent.mouseOver(btn)
        const tipEl = document.querySelector('.tooltip-portal') as HTMLElement
        Object.defineProperty(tipEl, 'offsetWidth', {value: 20, configurable: true})
        fireEvent.mouseOver(btn)
        expect(tipEl.style.transform).toBe('translate(-50%, -100%)')
    })

    it('浮层宽度契约：max-content + maxWidth 上限，且保留 pre-line 多行能力（未用 nowrap）', () => {
        const {container} = render(
            <>
                <TooltipPortal/>
                <button title="在文件树中定位当前文件" data-testid="target">
                    <svg/>
                </button>
            </>,
        )
        const btn = container.querySelector('[data-testid="target"]')!
        fireEvent.mouseOver(btn)
        const tipEl = document.querySelector('.tooltip-portal') as HTMLElement
        // 宽度取内容自然宽，与「视口宽 − left」解耦；长文案由 maxWidth 兜底换行
        expect(tipEl.style.width).toBe('max-content')
        expect(tipEl.style.maxWidth).toContain('320px')
        expect(tipEl.style.maxWidth).toContain('100vw')
        // 多行长 label 仍依赖 pre-line 换行，绝不能引入 nowrap
        expect(tipEl.style.whiteSpace).toBe('pre-line')
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
