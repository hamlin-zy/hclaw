// @vitest-environment jsdom
/**
 * MenuDialog 卸载清理对称性 · 回归护栏
 *
 * 缺陷：resize 路径有 resizeCleanupRef + 卸载兜底，拖拽移动路径没有 → 拖拽中卸载会残留
 * document 上的 mousemove/mouseup 监听，并把 `body.style.userSelect = 'none'` 留在页面上
 * （文本永久不可选中，直到下一次拖拽结束）。
 * 本测试锁定「拖拽中卸载 = 监听移除 + body 样式复位」，与 resize 路径逐项对称。
 */
import {describe, it, expect, vi, afterEach} from 'vitest'
import {render, fireEvent, cleanup} from '@testing-library/react'
import MenuDialog from '../../../../src/renderer/components/MenuDialog'

afterEach(() => {
    cleanup()
    document.body.style.userSelect = ''
    vi.restoreAllMocks()
})

/** 记录 document 上的监听注册/注销（透传真实实现，避免影响 jsdom 行为） */
function spyDocListeners() {
    const added: Array<[string, unknown]> = []
    const removed: Array<[string, unknown]> = []
    const origAdd = document.addEventListener.bind(document)
    const origRemove = document.removeEventListener.bind(document)
    vi.spyOn(document, 'addEventListener').mockImplementation(((t: string, fn: unknown, o?: unknown) => {
        added.push([t, fn])
        origAdd(t, fn as EventListener, o as AddEventListenerOptions)
    }) as typeof document.addEventListener)
    vi.spyOn(document, 'removeEventListener').mockImplementation(((t: string, fn: unknown, o?: unknown) => {
        removed.push([t, fn])
        origRemove(t, fn as EventListener, o as EventListenerOptions)
    }) as typeof document.removeEventListener)
    return {added, removed}
}

function renderDialog() {
    return render(
        <MenuDialog isOpen title="标题" onClose={() => {}}>
            <div data-testid="body-内容" />
        </MenuDialog>,
    )
}

describe('MenuDialog / 拖拽移动中的卸载清理', () => {
    it('拖拽中卸载 → 移除 mousemove/mouseup 监听并复位 body.userSelect', () => {
        const {added, removed} = spyDocListeners()
        const {container, unmount} = renderDialog()

        const titleBar = container.querySelector('h2')!.parentElement as HTMLElement
        fireEvent.mouseDown(titleBar, {clientX: 10, clientY: 10})

        // 拖拽已开始：body 被锁成不可选中
        expect(document.body.style.userSelect).toBe('none')
        const moveAdded = added.filter(([t]) => t === 'mousemove')
        const upAdded = added.filter(([t]) => t === 'mouseup')
        expect(moveAdded.length).toBeGreaterThan(0)
        expect(upAdded.length).toBeGreaterThan(0)

        unmount()

        const moveRemoved = removed.filter(([t]) => t === 'mousemove').map(([, fn]) => fn)
        const upRemoved = removed.filter(([t]) => t === 'mouseup').map(([, fn]) => fn)
        // 注册过的处理器必须逐个注销（同一函数引用）
        for (const [, fn] of moveAdded) expect(moveRemoved).toContain(fn)
        for (const [, fn] of upAdded) expect(upRemoved).toContain(fn)
        // body 内联样式不得残留
        expect(document.body.style.userSelect).toBe('')
    })

    it('正常结束拖拽（mouseup）后 body 样式同样复位，且卸载时不重复注销', () => {
        const {removed} = spyDocListeners()
        const {container, unmount} = renderDialog()

        const titleBar = container.querySelector('h2')!.parentElement as HTMLElement
        fireEvent.mouseDown(titleBar, {clientX: 10, clientY: 10})
        fireEvent.mouseUp(document)

        expect(document.body.style.userSelect).toBe('')
        // 只统计拖拽相关通道（ESC 的 keydown 监听另有其 effect，与拖拽无关）
        const dragRemoved = () => removed.filter(([t]) => t === 'mousemove' || t === 'mouseup').length
        const afterUp = dragRemoved()
        unmount()
        // 已终结的拖拽不再产生额外注销（dragCleanupRef 已置空）
        expect(dragRemoved()).toBe(afterUp)
    })
})
