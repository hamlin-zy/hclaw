// @vitest-environment jsdom
/**
 * MarkdownRenderer × mermaid 集成契约
 *
 * 契约：**无语言标注**的 mermaid 代码块（``` 后直接 flowchart TB）也必须渲染为流程图。
 *
 * 为什么必须测这条：无标注围栏由 `pre` 分支处理，若不在此处识别 mermaid，
 * 它会被渲染成普通 <pre> 纯文本。本用例锁住「pre 分支嗅探 → MermaidBlock」这条链路。
 *
 * 判别力：若移除 pre 分支的 isMermaidSource 判定，svg 不会出现，用例失败。
 */
import {afterEach, describe, expect, it, vi} from 'vitest'
import {cleanup, render, waitFor} from '@testing-library/react'

vi.mock('mermaid', () => ({
    default: {
        initialize: vi.fn(),
        parse: vi.fn(async () => true),
        render: vi.fn(async () => ({svg: '<svg data-testid="mmd-svg"></svg>'})),
    },
}))

vi.mock('@/renderer/stores/settingsStore', () => ({
    useSettingsStore: () => ({settings: {linkOpening: {mode: 'ask'}}}),
}))

import MarkdownRenderer from '@/renderer/components/message-list/MarkdownRenderer'

afterEach(() => cleanup())

describe('MarkdownRenderer mermaid 集成', () => {
    it('无语言标注的 flowchart 块渲染为流程图', async () => {
        const md = '前置说明\n\n```\nflowchart TB\n  A[开始] --> B[结束]\n```\n'

        const {container} = render(<MarkdownRenderer>{md}</MarkdownRenderer>)

        await waitFor(() => {
            expect(container.querySelector('svg[data-testid="mmd-svg"]')).not.toBeNull()
        })
        // 前置正文照常渲染
        expect(container.textContent).toContain('前置说明')
    })
})