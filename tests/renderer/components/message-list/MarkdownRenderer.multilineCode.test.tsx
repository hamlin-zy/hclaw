// @vitest-environment jsdom
import {describe, it, expect, vi} from 'vitest'
import {render} from '@testing-library/react'
import MarkdownRenderer from '../../../../src/renderer/components/message-list/MarkdownRenderer'

// mock settingsStore（MarkdownRenderer 内部读取 linkOpening 设置）
vi.mock('../../../../src/renderer/stores/settingsStore', () => ({
    useSettingsStore: () => ({settings: {linkOpening: {mode: 'ask'}}}),
}))

describe('MarkdownRenderer 多行代码块', () => {
    it('无语言标注的围栏代码块保留换行（不经过行内样式分支）', () => {
        const art = ['┌──────┐', '│  A   │', '└──────┘'].join('\n')
        render(<MarkdownRenderer isUser={false}>{'```\n' + art + '\n```'}</MarkdownRenderer>)
        // 围栏代码块：文本直接渲染在 pre 内，不得走行内 code 分支（whitespace-nowrap/药丸背景）
        const pre = document.querySelector('pre')
        expect(pre).toBeTruthy()
        expect(pre!.className).toContain('whitespace-pre-wrap')
        expect(document.querySelector('pre > code')).toBeNull()
        expect(pre!.textContent).toBe('┌──────┐\n│  A   │\n└──────┘\n')
    })
})
