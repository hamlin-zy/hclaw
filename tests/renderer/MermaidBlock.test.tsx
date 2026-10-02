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
import {cleanup, render, waitFor} from '@testing-library/react'

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

describe('MermaidBlock', () => {
    it('渲染成功时注入 svg，且不再显示原始源码', async () => {
        const {container} = render(<MermaidBlock code={CODE} isDark/>)

        await waitFor(() => {
            expect(container.querySelector('svg[data-testid="mmd-svg"]')).not.toBeNull()
        })
        expect(initializeMock).toHaveBeenCalled()
        // 成功路径不应把 mermaid 源码当纯文本残留
        expect(container.textContent).not.toContain('flowchart TB')
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