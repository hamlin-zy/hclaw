// @vitest-environment jsdom
/**
 * ImagePreviewModal 组件契约
 *
 * 组件经 createPortal 挂到 document.body，断言一律走 document / screen，不用 render 的 container。
 *
 * 契约：
 * 1. src 模式：渲染 <img>；Esc 触发 onClose；右键菜单存在时 Esc 只关菜单不关弹窗；卸载恢复 body overflow。
 * 2. svgContent 模式：走 div + innerHTML（不渲染 <img>），右键菜单不产生（imageMode 门）。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {cleanup, fireEvent, render, screen} from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

import ImagePreviewModal from '@/renderer/components/common/ImagePreviewModal'

const MODAL = '[data-name="image-preview-modal-div"]'
const MENU_ITEM = '[data-name="image-preview-modal-copy-image-button"]'

beforeEach(() => {
    // jsdom 无 navigator.clipboard；组件右键菜单分支会写剪贴板，先装最小桩
    Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {writeText: vi.fn(async () => {})},
    })
})

afterEach(() => {
    cleanup()
    vi.clearAllMocks()
})

describe('ImagePreviewModal - src 模式', () => {
    it('渲染 img 且 src 正确', () => {
        render(<ImagePreviewModal src="blob:preview-1" alt="示例图" onClose={vi.fn()}/>)

        const img = document.querySelector<HTMLImageElement>('img')
        expect(img).not.toBeNull()
        expect(img!.getAttribute('src')).toBe('blob:preview-1')
        expect(img!.getAttribute('alt')).toBe('示例图')
    })

    it('按 Escape 触发 onClose', () => {
        const onClose = vi.fn()
        render(<ImagePreviewModal src="blob:preview-1" alt="示例图" onClose={onClose}/>)

        fireEvent.keyDown(window, {key: 'Escape'})

        expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('右键菜单已打开时，Escape 只关菜单、不触发 onClose', () => {
        const onClose = vi.fn()
        render(<ImagePreviewModal src="blob:preview-1" alt="示例图" onClose={onClose}/>)

        fireEvent.contextMenu(document.querySelector(MODAL)!, {clientX: 30, clientY: 40})
        expect(document.querySelector(MENU_ITEM)).not.toBeNull()

        fireEvent.keyDown(window, {key: 'Escape'})

        expect(document.querySelector(MENU_ITEM)).toBeNull()
        expect(onClose).not.toHaveBeenCalled()
    })

    it('卸载后恢复 document.body 滚动', () => {
        const {unmount} = render(<ImagePreviewModal src="blob:preview-1" alt="示例图" onClose={vi.fn()}/>)
        expect(document.body.style.overflow).toBe('hidden')

        unmount()

        expect(document.body.style.overflow).toBe('')
    })
})

describe('ImagePreviewModal - svgContent 模式', () => {
    const SVG = '<svg id="mmd" style="width:100%;height:100%;display:block"><g></g></svg>'

    it('不渲染 img，容器 innerHTML 含传入 SVG 源码', () => {
        render(<ImagePreviewModal svgContent={SVG} alt="mermaid 流程图" onClose={vi.fn()}/>)

        expect(document.querySelector('img')).toBeNull()
        const host = document.querySelector<HTMLElement>(`${MODAL} .select-none`)
        expect(host).not.toBeNull()
        expect(host!.innerHTML).toContain('<svg')
        expect(host!.innerHTML).toContain('width:100%')
    })

    it('右键不产生图片操作菜单（imageMode 门）', () => {
        render(<ImagePreviewModal svgContent={SVG} alt="mermaid 流程图" onClose={vi.fn()}/>)

        fireEvent.contextMenu(document.querySelector(MODAL)!, {clientX: 10, clientY: 10})

        expect(document.querySelector(MENU_ITEM)).toBeNull()
        expect(document.querySelector('[data-name="image-preview-modal-context-menu-backdrop"]')).toBeNull()
        // 弹窗本体仍在（右键不该意外关闭）
        expect(screen.getByTitle('关闭 (ESC)')).toBeTruthy()
    })
})
