// @vitest-environment jsdom
/**
 * MermaidBlock 渲染 / 降级契约
 *
 * 契约：
 * 1. mermaid 渲染成功 → 容器内注入 <svg>，且不残留原始源码。
 * 2. mermaid.parse 失败（语法错误）→ 降级为普通代码块，源码可读。
 * 3. mermaid.render reject → 同样降级。
 *
 * 判别力：若去掉降级分支，用例 2/3 会因找不到源码文本而失败；
 * 若成功路径未注入 svg，用例 1 失败。
 */
import {afterEach, describe, expect, it, vi} from 'vitest'
import {act} from 'react'
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

const parseMock = vi.fn(async (_code: unknown) => true)
const renderMock = vi.fn(async (_id: unknown, _code: unknown) => ({svg: '<svg data-testid="mmd-svg"></svg>'}))
const initializeMock = vi.fn()

vi.mock('mermaid', () => ({
    default: {
        initialize: initializeMock,
        parse: parseMock,
        render: renderMock,
    },
}))

import {MermaidBlock} from '@/renderer/components/message-list/MermaidBlock'

afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    parseMock.mockImplementation(async () => true)
    renderMock.mockImplementation(async () => ({svg: '<svg data-testid="mmd-svg"></svg>'}))
})

const CODE = 'flowchart TB\n  A[开始] --> B[结束]'

/** 贴近真实的 mermaid 输出：width="100%" + style="max-width: Npx"，用于全屏链路用例 */
const REALISTIC_SVG = '<svg id="x" width="100%" style="max-width: 120px" viewBox="0 0 120 60"><g></g></svg>'

/** react-zoom-pan-pinch 内容层的内联 transform（缩放/平移的唯一可观测落点） */
function contentStyle(container: HTMLElement): string {
    return container.querySelector<HTMLElement>('.react-transform-component')?.getAttribute('style') ?? ''
}

/**
 * 动态 mock SVGElement.getBoundingClientRect（jsdom 无布局）。
 * 传 getter 而非定值，便于同一用例内切换「宽扁 → 高」验证 D1 残留。
 */
function installSvgRect(getHeight: () => number): () => void {
    const orig = SVGElement.prototype.getBoundingClientRect
    SVGElement.prototype.getBoundingClientRect = vi.fn(() => {
        const height = getHeight()
        return {
            width: 700, height, x: 0, y: 0, top: 0, left: 0, right: 700, bottom: height,
            toJSON: () => ({}),
        }
    }) as unknown as typeof SVGElement.prototype.getBoundingClientRect
    return () => {
        SVGElement.prototype.getBoundingClientRect = orig
    }
}

describe('MermaidBlock', () => {
    it('渲染成功时注入 svg，且不再显示原始源码', async () => {
        const {container} = render(<MermaidBlock code={CODE} isDark/>)

        await waitFor(() => {
            expect(container.querySelector('svg[data-testid="mmd-svg"]')).not.toBeNull()
        })
        expect(initializeMock).toHaveBeenCalled()
        // 成功路径不应把 mermaid 源码当纯文本残留
        expect(container.textContent).not.toContain('flowchart TB')
        // 控件样式常量回归守卫：复制按钮须保留基础 token（A1 提取后不得丢 token）
        const copyBtn = container.querySelector('[data-name="mermaid-block-copy"]')
        expect(copyBtn).not.toBeNull()
        expect(copyBtn).toHaveClass('px-2', 'py-1', 'text-xs', 'rounded')
    })

    it('mermaid.parse 抛错时降级为代码块（源码可读）', async () => {
        parseMock.mockImplementation(async () => {
            throw new Error('Parse error')
        })

        const {container} = render(<MermaidBlock code={CODE} isDark/>)

        await waitFor(() => {
            expect(container.textContent).toContain('flowchart TB')
        })
        expect(container.querySelector('svg[data-testid="mmd-svg"]')).toBeNull()
    })

    it('mermaid.render reject 时降级为代码块', async () => {
        renderMock.mockImplementation(async () => {
            throw new Error('Render error')
        })

        const {container} = render(<MermaidBlock code={CODE} isDark/>)

        await waitFor(() => {
            expect(container.textContent).toContain('flowchart TB')
        })
    })

    it('mermaid.render 失败时清理遗留在 body 的临时容器（#d<id>）', async () => {
        renderMock.mockImplementation(async (...args: unknown[]) => {
            // 模拟 mermaid v12 失败路径：错误 SVG 先落入 #d<id> 并插入 document.body，再抛错
            const orphan = document.createElement('div')
            orphan.id = `d${String(args[0])}`
            orphan.textContent = 'mermaid error svg'
            document.body.appendChild(orphan)
            throw new Error('Render error')
        })

        const {container} = render(<MermaidBlock code={CODE} isDark/>)

        // 仍然降级为代码块（既有断言口径）
        await waitFor(() => {
            expect(container.textContent).toContain('flowchart TB')
        })
        // 从 render 调用捕获实际使用的 id，验证对应的 #d<id> 已被清理
        const usedId = String(renderMock.mock.calls[0]?.[0] ?? '')
        expect(usedId).toBeTruthy()
        expect(document.body.querySelector(`#d${CSS.escape(usedId)}`)).toBeNull()
    })

    it('两个 MermaidBlock 用相同 code 时 render 调用获得不同 id（防 DOM 冲突）', async () => {
        const {rerender} = render(<div><MermaidBlock code={CODE} isDark/></div>)
        await waitFor(() => expect(renderMock.mock.calls.length).toBe(1))

        // 追加第二个实例：rerender 会走 React reconciliation，
        // 第一个实例 props 未变 memo bail out，只新增第二个实例的 useEffect
        rerender(
            <div>
                <MermaidBlock code={CODE} isDark/>
                <MermaidBlock code={CODE} isDark/>
            </div>,
        )
        await waitFor(() => expect(renderMock.mock.calls.length).toBe(2))

        const ids = renderMock.mock.calls.map(c => String(c[0]))
        // 同 code + 同主题的两个实例必须拿到不同 id，否则 mermaid 内部 #d<id> 会撞车
        expect(ids[0]).not.toBe(ids[1])
        expect(ids[0]).toMatch(/^mermaid-/)
        expect(ids[1]).toMatch(/^mermaid-/)
    })

    it('render 永远不响应时不再永久 loading（看门狗强制降级）', async () => {
        vi.useFakeTimers()
        try {
            renderMock.mockImplementation(() => new Promise(() => {}))
            const {container} = render(<MermaidBlock code={CODE} isDark/>)
            // 让 async IIFE 走完 import/parse 到达 render 挂起
            for (let i = 0; i < 10; i++) await Promise.resolve()
            // 推进 timer 到超时后，act 包裹确保 React flush state 更新
            await act(async () => {
                vi.advanceTimersByTime(4500)
            })
            expect(container.textContent).toContain('flowchart TB')
        } finally {
            vi.useRealTimers()
        }
    })

    it('流式期间 render 挂起 → 第一次超时保持 loading（抑制 partial 闪烁）', async () => {
        vi.useFakeTimers()
        try {
            renderMock.mockImplementation(() => new Promise(() => {}))
            const {container} = render(<MermaidBlock code={CODE} isDark isStreaming/>)
            for (let i = 0; i < 10; i++) await Promise.resolve()
            await act(async () => {
                vi.advanceTimersByTime(4500)
            })
            // 4s 后仍在 loading（timer 已消费但 status 保持）
            expect(container.textContent).toContain('渲染流程图…')
            expect(container.textContent).not.toContain('flowchart TB')
        } finally {
            vi.useRealTimers()
        }
    })

    it('流式期间 render 挂起超过二次看门 → 强制降级（防永久 loading）', async () => {
        vi.useFakeTimers()
        try {
            renderMock.mockImplementation(() => new Promise(() => {}))
            const {container} = render(<MermaidBlock code={CODE} isDark isStreaming/>)
            for (let i = 0; i < 10; i++) await Promise.resolve()
            await act(async () => {
                vi.advanceTimersByTime(4500)
            })
            // 4.5s：仍 loading
            expect(container.textContent).toContain('渲染流程图…')
            await act(async () => {
                vi.advanceTimersByTime(4000)
            })
            // 8.5s：二次看门触发，强制降级为 error
            expect(container.textContent).toContain('flowchart TB')
        } finally {
            vi.useRealTimers()
        }
    })

    it('宽扁图（渲染高度 < 280px）自动抬高 wrapper 最小高度至 280px', async () => {
        // jsdom 无布局：mock getBoundingClientRect 返回 100px 高（宽扁图）
        const orig = SVGElement.prototype.getBoundingClientRect
        SVGElement.prototype.getBoundingClientRect = vi.fn(() => ({
            width: 700, height: 100, x: 0, y: 0,
            top: 0, left: 0, right: 700, bottom: 100,
            toJSON: () => ({}),
        }))
        try {
            const {container} = render(<MermaidBlock code={CODE} isDark/>)
            await waitFor(() => {
                expect(container.querySelector('svg[data-testid="mmd-svg"]')).not.toBeNull()
            })
            // rAF 回调设置 wrapperMinH=280 → wrapperStyle.minHeight=280px
            await waitFor(() => {
                const styled = container.querySelector<HTMLElement>('[style*="min-height"]')
                expect(styled).not.toBeNull()
                expect(styled!.style.minHeight).toBe('280px')
            })
        } finally {
            SVGElement.prototype.getBoundingClientRect = orig
        }
    })

    it('TransformComponent wrapper 具备 overflow-hidden（防超宽 svg 溢出消息气泡）', async () => {
        const {container} = render(<MermaidBlock code={CODE} isDark/>)

        await waitFor(() => {
            expect(container.querySelector('svg[data-testid="mmd-svg"]')).not.toBeNull()
        })
        // react-zoom-pan-pinch 把 wrapperClass 应用到内部包裹 div
        // 断言页面中存在同时含 overflow-hidden 的 div（wrapper 类名的关键回归守卫）
        const divs = container.querySelectorAll('div')
        expect(
            Array.from(divs).some(d => (d.className ?? '').includes('overflow-hidden')),
        ).toBe(true)
    })
})

describe('MermaidBlock 缩放 transform 契约', () => {
    it('宽扁图（height=100）→ scale(2.8) + translate(0px, -90px)，wrapper 抬高至 280px', async () => {
        const restore = installSvgRect(() => 100)
        try {
            const {container} = render(<MermaidBlock code={CODE} isDark/>)
            await waitFor(() => {
                const styled = container.querySelector<HTMLElement>('[style*="min-height"]')
                expect(styled?.style.minHeight).toBe('280px')
                expect(contentStyle(container)).toContain('scale(2.8)')
                expect(contentStyle(container)).toContain('translate(0px, -90px)')
            })
        } finally {
            restore()
        }
    })

    it('高图（height=1000 ≥ 280）→ 不缩放（scale(1)），wrapper 保持 80px', async () => {
        const restore = installSvgRect(() => 1000)
        try {
            const {container} = render(<MermaidBlock code={CODE} isDark/>)
            await waitFor(() => {
                expect(container.querySelector('svg[data-testid="mmd-svg"]')).not.toBeNull()
                const styled = container.querySelector<HTMLElement>('[style*="min-height"]')
                expect(styled?.style.minHeight).toBe('80px')
                expect(contentStyle(container)).toContain('scale(1)')
                expect(contentStyle(container)).not.toContain('scale(2.8)')
            })
        } finally {
            restore()
        }
    })

    it('极扁图（height=20）→ 缩放被 maxScale=5 截断', async () => {
        const restore = installSvgRect(() => 20)
        try {
            const {container} = render(<MermaidBlock code={CODE} isDark/>)
            await waitFor(() => {
                const styled = container.querySelector<HTMLElement>('[style*="min-height"]')
                expect(styled?.style.minHeight).toBe('280px')
                expect(contentStyle(container)).toContain('scale(5)')
                expect(contentStyle(container)).toContain('translate(0px, -130px)')
            })
        } finally {
            restore()
        }
    })

    it('零高图（height=0）→ 不缩放、不抛错', async () => {
        const restore = installSvgRect(() => 0)
        try {
            const {container} = render(<MermaidBlock code={CODE} isDark/>)
            await waitFor(() => {
                expect(container.querySelector('svg[data-testid="mmd-svg"]')).not.toBeNull()
                const styled = container.querySelector<HTMLElement>('[style*="min-height"]')
                expect(styled?.style.minHeight).toBe('80px')
                expect(contentStyle(container)).toContain('scale(1)')
            })
        } finally {
            restore()
        }
    })

    it('D1 回归：宽扁图缩放后切到新 code（高图）不残留旧 transform', async () => {
        let height = 100
        const restore = installSvgRect(() => height)
        try {
            const {container, rerender} = render(<MermaidBlock code={CODE} isDark/>)
            await waitFor(() => {
                expect(contentStyle(container)).toContain('scale(2.8)')
            })

            // 切换为新 code 且该图高度 ≥ MIN_HEIGHT：rAF 走早退分支，旧 transform 必须已被 effect 复位
            height = 1000
            rerender(<MermaidBlock code={`${CODE}\n  %% 高图`} isDark/>)

            await waitFor(() => {
                const styled = container.querySelector<HTMLElement>('[style*="min-height"]')
                expect(styled?.style.minHeight).toBe('80px')
                expect(contentStyle(container)).toContain('scale(1)')
                expect(contentStyle(container)).not.toContain('scale(2.8)')
            })
        } finally {
            restore()
        }
    })
})

describe('MermaidBlock 全屏预览链路', () => {
    it('ready → 点全屏 → 预览 svg 撑满容器 → 关闭 → 主视图 svg 保留', async () => {
        renderMock.mockImplementation(async () => ({svg: REALISTIC_SVG}))
        const {container} = render(<MermaidBlock code={CODE} isDark/>)

        await waitFor(() => {
            expect(container.querySelector('[data-name="mermaid-block-fullscreen"]')).not.toBeNull()
        })

        fireEvent.click(container.querySelector('[data-name="mermaid-block-fullscreen"]')!)

        // ImagePreviewModal 经 portal 挂到 document.body，断言须走 document
        await waitFor(() => {
            expect(document.querySelector('[data-name="image-preview-modal-div"]')).not.toBeNull()
        })
        const previewSvg = document.querySelector<SVGElement>(
            '[data-name="image-preview-modal-div"] .select-none svg',
        )
        expect(previewSvg).not.toBeNull()
        // 预览注入的是改写后的 svg：100%×100% 撑满确定尺寸的预览容器（等比适配靠 preserveAspectRatio）
        expect(previewSvg!.style.width).toBe('100%')
        expect(previewSvg!.style.height).toBe('100%')

        fireEvent.click(screen.getByTitle('关闭 (ESC)'))

        await waitFor(() => {
            expect(document.querySelector('[data-name="image-preview-modal-div"]')).toBeNull()
        })
        // 关闭预览不得清掉主视图注入的 svg
        expect(container.querySelector('[data-name="mermaid-block-svg"] svg')).not.toBeNull()
    })

    it('全屏打开不污染主视图 svg 的内联样式', async () => {
        renderMock.mockImplementation(async () => ({svg: REALISTIC_SVG}))
        const {container} = render(<MermaidBlock code={CODE} isDark/>)

        await waitFor(() => {
            expect(container.querySelector('[data-name="mermaid-block-fullscreen"]')).not.toBeNull()
        })
        const readMainStyle = () => container.querySelector('[data-name="mermaid-block-svg"] svg')?.getAttribute('style') ?? ''
        // 主视图用原始 svg（width="100%" + max-width），预览专用的 100%×100% 样式不得反注回主视图
        expect(readMainStyle()).toBe('max-width: 120px')

        fireEvent.click(container.querySelector('[data-name="mermaid-block-fullscreen"]')!)
        await waitFor(() => {
            expect(document.querySelector('[data-name="image-preview-modal-div"]')).not.toBeNull()
        })
        expect(readMainStyle()).toBe('max-width: 120px')
        expect(readMainStyle()).not.toContain('height')
    })

    it('error 态（render 抛错且非流式）不提供全屏按钮', async () => {
        renderMock.mockImplementation(async () => {
            throw new Error('Render error')
        })
        const {container} = render(<MermaidBlock code={CODE} isDark/>)

        await waitFor(() => {
            expect(container.textContent).toContain('flowchart TB')
        })
        expect(container.querySelector('[data-name="mermaid-block-fullscreen"]')).toBeNull()
    })
})