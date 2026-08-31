// @vitest-environment jsdom
import {describe, it, expect, vi} from 'vitest'
import {render, screen} from '@testing-library/react'
import MarkdownRenderer from '../../../../src/renderer/components/message-list/MarkdownRenderer'

// mock settingsStore（MarkdownRenderer 内部读取 linkOpening 设置）
vi.mock('../../../../src/renderer/stores/settingsStore', () => ({
    useSettingsStore: () => ({settings: {linkOpening: {mode: 'ask'}}}),
}))

describe('MarkdownRenderer user 消息 HTML 转义', () => {
    it('isUser=true 时 <select>具体问题 不渲染为下拉框，而是显示原始文本', () => {
        render(<MarkdownRenderer isUser>{'<select>具体问题'}</MarkdownRenderer>)
        // 不应产生真实 <select> 元素
        expect(document.querySelector('select')).toBeNull()
        // 原始文本应完整可见（零宽空格打断 HTML 语法，剥离后匹配）
        const text = document.body.textContent!.replace(/\u200B/g, '')
        expect(text).toContain('<select>')
        expect(text).toContain('具体问题')
    })

    it('isUser=true 时其他合法 HTML 标签（如 <b>）同样按纯文本显示', () => {
        render(<MarkdownRenderer isUser>{'<b>加粗问题</b>'}</MarkdownRenderer>)
        expect(document.querySelector('b')).toBeNull()
        expect(screen.getByText(/加粗问题/)).toBeTruthy()
    })
})
