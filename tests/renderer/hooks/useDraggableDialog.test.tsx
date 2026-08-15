// @vitest-environment jsdom
/**
 * useDraggableDialog hook 测试
 *
 * 保护：全局对话框拖拽逻辑。
 * - 居中定位（visible 触发，rAF 后按 offsetWidth/offsetHeight 计算）
 * - 边界约束（拖拽不超出视口，8px 边距）
 * - 拖拽坐标更新（dragStart → mousemove → 位置跟随）
 * - 位置持久化（storageKey 时从 localStorage 恢复/保存）
 *
 * 依赖 window/document/localStorage 事件，jsdom 已提供；
 * requestAnimationFrame mock 为同步执行以测试居中定位。
 */
import {describe, expect, it, vi, beforeEach, afterEach} from 'vitest'
import {renderHook, act} from '@testing-library/react'
import {useDraggableDialog} from '../../../src/renderer/hooks/useDraggableDialog'

/** 模拟 dialogRef 指向的 DOM 元素（提供 offsetWidth/offsetHeight） */
function makeDialogEl(offsetWidth: number, offsetHeight: number) {
    return {offsetWidth, offsetHeight} as HTMLDivElement
}

/** 构造 mouse drag start 事件（React synthetic event 需要的字段） */
function makeDragStart(clientX: number, clientY: number) {
    return {clientX, clientY} as React.MouseEvent
}

/** 派发 document 原生 mousemove */
function fireMouseMove(clientX: number, clientY: number) {
    act(() => {
        document.dispatchEvent(new MouseEvent('mousemove', {clientX, clientY, bubbles: true}))
    })
}

describe('useDraggableDialog', () => {
    beforeEach(() => {
        // rAF 同步执行，便于断言居中定位结果
        vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
            cb(0)
            return 1
        })
        window.localStorage.clear()
    })

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('无 storageKey 且不可见 → 初始位置 (0,0)，不居中', () => {
        const {result} = renderHook(() => useDraggableDialog({visible: false}))
        expect(result.current.position).toEqual({x: 0, y: 0})
        expect(result.current.isDragging).toBe(false)
    })

    it('visible 变 true → 按 offsetWidth 居中定位（带边界约束）', () => {
        const {result, rerender} = renderHook(
            ({visible}) => useDraggableDialog({visible}),
            {initialProps: {visible: false}},
        )
        result.current.dialogRef.current = makeDialogEl(200, 100)

        rerender({visible: true})

        // jsdom 默认视口 1024x768
        // 居中 x = max((1024-200)/2, 8) = 412，y = max((768-100)/2, 80) = 334
        expect(result.current.position).toEqual({x: 412, y: 334})
    })

    it('对话框高度超过视口 → 居中 y 被边界约束到 minY=8', () => {
        const {result, rerender} = renderHook(
            ({visible}) => useDraggableDialog({visible}),
            {initialProps: {visible: false}},
        )
        // 对话框高度超过视口 → 居中 y = max((768-2000)/2, 80) = 80，
        // 但 maxY = max(8, 768-2000-8) = 8，clamp 后落到 minY=8
        result.current.dialogRef.current = makeDialogEl(200, 2000)

        rerender({visible: true})

        expect(result.current.position.y).toBe(8)
    })

    it('storageKey 且 localStorage 有已存位置 → 初始位置使用已存值', () => {
        window.localStorage.setItem('test-pos', JSON.stringify({x: 100, y: 200}))
        const {result} = renderHook(() => useDraggableDialog({visible: true, storageKey: 'test-pos'}))
        expect(result.current.position).toEqual({x: 100, y: 200})
    })

    it('storageKey 但 localStorage 数据非法 → 回退居中定位', () => {
        window.localStorage.setItem('test-pos', 'not-json')
        const {result, rerender} = renderHook(
            ({visible}) => useDraggableDialog({visible, storageKey: 'test-pos'}),
            {initialProps: {visible: false}},
        )
        // 非法 JSON 被忽略，挂载元素后走居中定位
        result.current.dialogRef.current = makeDialogEl(200, 100)
        rerender({visible: true, storageKey: 'test-pos'})
        expect(result.current.position).toEqual({x: 412, y: 334})
    })

    it('拖拽：dragStart 后 mousemove 更新位置（相对起始点）', () => {
        const {result} = renderHook(() => useDraggableDialog({visible: false}))

        // 初始在 (0,0)，从 (50,50) 拖到 (120,80) → delta (70,30)
        act(() => {
            result.current.handleDragStart(makeDragStart(50, 50))
        })
        expect(result.current.isDragging).toBe(true)

        fireMouseMove(120, 80)

        expect(result.current.position).toEqual({x: 70, y: 30})
    })

    it('拖拽超出视口 → 位置被边界约束（8px 边距）', () => {
        const {result} = renderHook(() => useDraggableDialog({visible: false}))
        result.current.dialogRef.current = makeDialogEl(200, 100)

        act(() => {
            result.current.handleDragStart(makeDragStart(100, 100))
        })

        // 拖到视口外：maxX = 1024-200-8 = 816，maxY = 768-100-8 = 660
        fireMouseMove(5000, 5000)

        expect(result.current.position).toEqual({x: 816, y: 660})

        // 拖到负方向：minX = minY = 8
        fireMouseMove(-5000, -5000)

        expect(result.current.position).toEqual({x: 8, y: 8})
    })

    it('mouseup 结束拖拽并保存位置到 localStorage', () => {
        const {result} = renderHook(() => useDraggableDialog({visible: false, storageKey: 'drag-pos'}))

        act(() => {
            result.current.handleDragStart(makeDragStart(0, 0))
        })
        fireMouseMove(300, 400)

        act(() => {
            document.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}))
        })

        expect(result.current.isDragging).toBe(false)
        // 保存的是结束时的 positionRef（最后 move 的位置）
        expect(window.localStorage.getItem('drag-pos')).toBe(JSON.stringify({x: 300, y: 400}))
    })

    it('无 storageKey 时 mouseup 不写 localStorage', () => {
        const {result} = renderHook(() => useDraggableDialog({visible: false}))

        act(() => {
            result.current.handleDragStart(makeDragStart(0, 0))
        })
        fireMouseMove(100, 100)
        act(() => {
            document.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}))
        })

        expect(window.localStorage.length).toBe(0)
    })
})
