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
import {cleanup, render, waitFor} from '@testing-library/react'

const parseMock = vi.fn(async () => true)
const renderMock = vi.fn(async () => ({svg: '<svg data-testid="mmd-svg"></svg>'}))
const initializeMock = vi.fn()

vi.mock('mermaid', () => ({
    default: {
        initialize: initializeMock,
        parse: parseMock,
        render: renderMock,
    },
}))

import {MermaidBlock} from '@/renderer/components/message-list/MermaidBlock'

/**
 * 复刻组件的 id 生成规则（与 MermaidBlock.tsx 的 hashString 一致），
 * 用于独立推导 mermaid 内部临时容器的 id（`d` + `<id>`）。
 */
function hashString(input: string): string {
    let h = 5381
    for (let i = 0; i < input.length; i++) {
        h = ((h << 5) + h + input.charCodeAt(i)) | 0
    }
    return (h >>> 0).toString(36)
}

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
        // 独立推导期望 id：CODE + isDark=true → 后缀 'd'（不得更改 id 生成规则）
        const expectedId = `mermaid-${hashString(CODE + 'd')}`

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
        // 且 body 不残留 mermaid 的孤儿容器
        expect(document.body.querySelector(`#d${expectedId}`)).toBeNull()
    })
})