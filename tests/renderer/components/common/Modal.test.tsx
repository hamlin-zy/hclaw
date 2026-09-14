// @vitest-environment jsdom
/**
 * Modal 组件测试
 *
 * 覆盖：open=false 不渲染、aria 语义、Esc 关闭、遮罩点击关闭（面板内点击不关）、
 * 打开初始 focus 与关闭后焦点回归触发元素。
 */
import {describe, it, expect, vi, afterEach} from 'vitest'
import {render, screen, fireEvent, cleanup} from '@testing-library/react'
import {useState} from 'react'
import {Modal} from '@/renderer/components/common/Modal'

afterEach(() => {
    cleanup()
    vi.clearAllMocks()
})

/** 受控宿主：外置触发按钮 + 弹窗内一个可聚焦元素 */
function Host({onClose = vi.fn()}: {onClose?: () => void}) {
    const [open, setOpen] = useState(false)
    return (
        <>
            <button type="button" onClick={() => setOpen(true)}>打开弹窗</button>
            <Modal
                open={open}
                ariaLabel="测试弹窗"
                onClose={() => {
                    setOpen(false)
                    onClose()
                }}
            >
                <button type="button">内部按钮</button>
                <span>正文内容</span>
            </Modal>
        </>
    )
}

describe('Modal', () => {
    it('open=false 不渲染任何内容', () => {
        render(<Modal open={false} onClose={vi.fn()} ariaLabel="测试弹窗"><span>正文</span></Modal>)

        expect(document.querySelector('[data-name="modal-panel"]')).toBeNull()
        expect(screen.queryByText('正文')).toBeNull()
    })

    it('open=true 渲染到 body，带 role/aria 语义与遮罩', () => {
        render(<Modal open onClose={vi.fn()} ariaLabel="测试弹窗"><span>正文</span></Modal>)

        const dialog = screen.getByRole('dialog')
        expect(dialog.getAttribute('aria-modal')).toBe('true')
        expect(dialog.getAttribute('aria-label')).toBe('测试弹窗')
        expect(document.body.contains(dialog)).toBe(true)
        expect(document.querySelector('[data-name="modal-backdrop"]')).toBeTruthy()
        expect(screen.getByText('正文')).toBeTruthy()
    })

    it('按 Esc 触发 onClose', () => {
        const onClose = vi.fn()
        render(<Modal open onClose={onClose} ariaLabel="测试弹窗"><span>正文</span></Modal>)

        fireEvent.keyDown(window, {key: 'Escape'})
        expect(onClose).toHaveBeenCalledTimes(1)

        // 其他按键不触发
        fireEvent.keyDown(window, {key: 'Enter'})
        expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('点击遮罩触发 onClose，点击面板内部不触发', () => {
        const onClose = vi.fn()
        render(<Modal open onClose={onClose} ariaLabel="测试弹窗"><button type="button">内部按钮</button></Modal>)

        fireEvent.click(screen.getByRole('button', {name: '内部按钮'}))
        expect(onClose).not.toHaveBeenCalled()

        fireEvent.click(document.querySelector('[data-name="modal-backdrop"]')!)
        expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('打开时初始 focus 到首个可聚焦元素，关闭后焦点回归触发元素', () => {
        render(<Host />)
        const trigger = screen.getByRole('button', {name: '打开弹窗'})

        trigger.focus()
        expect(document.activeElement).toBe(trigger)

        fireEvent.click(trigger)
        expect(document.activeElement).toBe(screen.getByRole('button', {name: '内部按钮'}))

        fireEvent.keyDown(window, {key: 'Escape'})
        expect(document.querySelector('[data-name="modal-panel"]')).toBeNull()
        expect(document.activeElement).toBe(trigger)
    })

    it('Esc 与遮罩关闭都会回调 onClose（宿主侧关闭）', () => {
        const onClose = vi.fn()
        render(<Host onClose={onClose} />)

        fireEvent.click(screen.getByRole('button', {name: '打开弹窗'}))
        fireEvent.click(document.querySelector('[data-name="modal-backdrop"]')!)

        expect(onClose).toHaveBeenCalledTimes(1)
        expect(document.querySelector('[data-name="modal-panel"]')).toBeNull()
    })
})
