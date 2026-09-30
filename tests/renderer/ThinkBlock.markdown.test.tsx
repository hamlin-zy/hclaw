// @vitest-environment jsdom
/**
 * ThinkBlock 思考块 markdown 渲染回归守卫
 *
 * 契约：思考块内容与正文一致，必须走 MarkdownRenderer 解析；
 * 同时保留等宽字体外观（font-mono）。
 *
 * 判别力：若渲染退回 <pre>{content}</pre> 纯文本，本用例的 h1/strong 断言必然失败。
 */
import {describe, expect, it, vi} from 'vitest'
import {render} from '@testing-library/react'
import type {ThinkBlock as ThinkBlockType} from '@shared/types'

// ── 依赖隔离：store 只提供渲染所需的最小状态 ──
vi.mock('@/renderer/stores/agentStore', () => ({
    useAgentStore: (selector: (s: {messageDisplayMode: string}) => unknown) => selector({messageDisplayMode: 'normal'}),
}))

vi.mock('@/renderer/stores/themeStore', () => ({
    useThemeStore: (selector: (s: {theme: string}) => unknown) => selector({theme: 'light'}),
}))

vi.mock('@/renderer/stores/settingsStore', () => ({
    useSettingsStore: () => ({settings: {linkOpening: {mode: 'ask'}, ui: {theme: 'light'}}}),
}))

import ThinkBlock from '@/renderer/components/ThinkBlock'

const MARKDOWN_CONTENT = '# 思考标题\n\n**加粗结论** 与 `行内代码`\n\n- 列表项\n'

function makeThinkBlock(content: string, status: 'thinking' | 'complete' = 'complete'): ThinkBlockType {
    return {id: 'think-test', content, status, timestamp: 0}
}

describe('ThinkBlock markdown 渲染', () => {
    it('把 markdown 语法渲染为对应元素，而非纯文本', () => {
        const {container} = render(<ThinkBlock thinkBlock={makeThinkBlock(MARKDOWN_CONTENT)}/>)

        expect(container.querySelector('h1')).not.toBeNull()
        expect(container.querySelector('h1')!.textContent).toContain('思考标题')
        expect(container.querySelector('strong')).not.toBeNull()
        expect(container.querySelector('code')).not.toBeNull()
        expect(container.querySelector('li')).not.toBeNull()
        // 原文里的 markdown 标记不应作为纯文本残留
        expect(container.textContent).not.toContain('**加粗结论**')
    })

    it('保留等宽字体外观（font-mono 包裹层）', () => {
        const {container} = render(<ThinkBlock thinkBlock={makeThinkBlock(MARKDOWN_CONTENT)}/>)

        const wrapper = container.querySelector('.font-mono')
        expect(wrapper).not.toBeNull()
        // 等宽层必须真正包裹 markdown 输出，而非空壳
        expect(wrapper!.querySelector('h1')).not.toBeNull()
    })

    it('思考中且无内容时仍显示占位提示', () => {
        const {container} = render(<ThinkBlock thinkBlock={makeThinkBlock('', 'thinking')}/>)

        expect(container.textContent).toContain('正在思考')
        expect(container.querySelector('h1')).toBeNull()
    })
})