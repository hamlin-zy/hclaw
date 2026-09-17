// @vitest-environment jsdom
/**
 * ModelSchemeDialog 侧边栏宽度拖拽 · 卸载清理对称性回归护栏
 *
 * 缺陷：startResizing 在 document 上挂 mousemove/mouseup，并把 body.style.cursor 锁成
 * 'col-resize'，但没有卸载兜底 → 拖拽进行中卸载组件会残留 document 监听，且 body 内联
 * 光标永久停在 col-resize（整个窗口光标错乱，直到下一次拖拽结束才复位）。
 * 本测试锁定「拖拽中卸载 = 监听移除 + body 光标复位」，与 MenuDialog 的 dragCleanupRef 范式对称。
 */
import {describe, it, expect, vi, afterEach} from 'vitest'
import {render, fireEvent, cleanup} from '@testing-library/react'
import ModelSchemeDialog from '../../../../src/renderer/components/dialogs/ModelSchemeDialog'

afterEach(() => {
    cleanup()
    document.body.style.cursor = ''
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

/** 侧边栏右缘的拖拽手柄（唯一带 col-resize 光标的元素） */
function getResizeHandle(container: HTMLElement): HTMLElement {
    const handle = container.querySelector('.cursor-col-resize')
    expect(handle).toBeTruthy()
    return handle as HTMLElement
}

describe('ModelSchemeDialog / 侧边栏宽度拖拽中的卸载清理', () => {
    it('拖拽中卸载 → 移除 mousemove/mouseup 监听并复位 body.cursor', () => {
        const {added, removed} = spyDocListeners()
        const {container, unmount} = render(<ModelSchemeDialog/>)

        fireEvent.mouseDown(getResizeHandle(container), {clientX: 10, clientY: 10})

        // 拖拽已开始：body 光标被锁
        expect(document.body.style.cursor).toBe('col-resize')
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
        // body 光标不得残留 col-resize
        expect(document.body.style.cursor).toBe('default')
    })

    it('正常结束拖拽（mouseup）后光标复位，卸载时不重复注销', () => {
        const {removed} = spyDocListeners()
        const {container, unmount} = render(<ModelSchemeDialog/>)

        fireEvent.mouseDown(getResizeHandle(container), {clientX: 10, clientY: 10})
        fireEvent.mouseUp(document)

        expect(document.body.style.cursor).toBe('default')
        const dragRemoved = () => removed.filter(([t]) => t === 'mousemove' || t === 'mouseup').length
        const afterUp = dragRemoved()
        unmount()
        // 已终结的拖拽不再产生额外注销（cleanup ref 已置空）
        expect(dragRemoved()).toBe(afterUp)
    })
})
