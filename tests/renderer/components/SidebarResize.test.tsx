// @vitest-environment jsdom
/**
 * SidebarResizeHandle 拖拽调宽单测
 *
 * 手柄 + 拖拽协议已抽成小组件（App.tsx 真实接线见 :753-760 附近）：
 * Harness 复刻 App 的挂载方式 —— 手柄放在 data-name="left-sidebar-card" 内、
 * 仅展开态渲染；拖拽期直改 DOM style，mouseup 一次性提交 clamp 后的 px。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, fireEvent, cleanup} from '@testing-library/react'
import {SidebarResizeHandle} from '../../../src/renderer/components/sidebar/SidebarResizeHandle'
import {SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH} from '../../../src/renderer/stores/sidebarStore'

function Harness({collapsed, onResizeEnd}: {collapsed: boolean; onResizeEnd: (w: number) => void}) {
    return (
        <div
            data-name="left-sidebar-card"
            style={{width: collapsed ? '36px' : '256px'}}
        >
            <div data-name="conversation-sidebar-inner" style={{width: '256px'}}/>
            {!collapsed && <SidebarResizeHandle onResizeEnd={onResizeEnd}/>}
        </div>
    )
}

describe('SidebarResizeHandle', () => {
    let resizeSpy: ReturnType<typeof vi.fn<(w: number) => void>>

    beforeEach(() => {
        resizeSpy = vi.fn()
        vi.spyOn(window, 'dispatchEvent')
        // jsdom 无布局引擎：mock 卡片 rect，模拟初始 256px 宽
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
            width: 256, height: 600, top: 0, left: 0, bottom: 600, right: 256, x: 0, y: 0,
            toJSON: () => ({}),
        } as DOMRect)
    })
    afterEach(() => {
        cleanup()
        vi.restoreAllMocks()
    })

    function drag(handle: Element, dx: number) {
        fireEvent.mouseDown(handle, {button: 0, clientX: 300})
        fireEvent.mouseMove(document, {clientX: 300 + dx})
        fireEvent.mouseUp(document)
    }

    it('拖拽正常范围：mouseup 提交 clamp 后宽度并派发 resize（供 positionDrawer 重算）', () => {
        const {getByDataName} = renderHarness(resizeSpy)
        drag(getByDataName('sidebar-resize-handle'), 50)
        expect(resizeSpy).toHaveBeenCalledWith(306) // 256 + 50
        expect(window.dispatchEvent).toHaveBeenCalledWith(new Event('resize'))
    })

    it('拖到 <180：clamp 到下限', () => {
        const {getByDataName} = renderHarness(resizeSpy)
        drag(getByDataName('sidebar-resize-handle'), -200) // 256 - 200 = 56 < 180
        expect(resizeSpy).toHaveBeenCalledWith(SIDEBAR_MIN_WIDTH)
    })

    it('拖到 >480：clamp 到上限', () => {
        const {getByDataName} = renderHarness(resizeSpy)
        drag(getByDataName('sidebar-resize-handle'), 500) // 256 + 500 = 756 > 480
        expect(resizeSpy).toHaveBeenCalledWith(SIDEBAR_MAX_WIDTH)
    })

    it('非左键不触发拖拽', () => {
        const {getByDataName} = renderHarness(resizeSpy)
        fireEvent.mouseDown(getByDataName('sidebar-resize-handle'), {button: 2, clientX: 300})
        fireEvent.mouseMove(document, {clientX: 500})
        fireEvent.mouseUp(document)
        expect(resizeSpy).not.toHaveBeenCalled()
    })

    it('折叠态不渲染手柄', () => {
        const {container} = render(<Harness collapsed onResizeEnd={resizeSpy}/>)
        expect(container.querySelector('[data-name="sidebar-resize-handle"]')).toBeNull()
    })
})

function renderHarness(onResizeEnd: (w: number) => void) {
    const utils = render(<Harness collapsed={false} onResizeEnd={onResizeEnd}/>)
    return {
        ...utils,
        getByDataName: (name: string) => utils.container.querySelector(`[data-name="${name}"]`) as HTMLElement,
    }
}
