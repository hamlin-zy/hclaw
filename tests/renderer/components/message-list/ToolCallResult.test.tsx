// @vitest-environment jsdom
/**
 * ToolCallResult 渲染测试（I-1 补最小渲染覆盖）
 *
 * 锁定关键分支：空 output 守卫、标签文案（file_edit → 执行结果）、
 * data-find-exclude 标记、agent 不做 4000 截断、音频 URL → AudioPreviewPlayer。
 * MarkdownRenderer / AudioPreviewPlayer 被替换为最小桩，以便断言传入的 props。
 */
import {describe, it, expect, vi} from 'vitest'
import {render, screen} from '@testing-library/react'
import ToolCallResult from '../../../../src/renderer/components/message-list/ToolCallResult'

vi.mock('../../../../src/renderer/components/message-list/MarkdownRenderer', () => ({
    default: ({children}: {children: string}) => <div data-testid="md">{children}</div>,
}))
vi.mock('../../../../src/renderer/components/message-list/AudioPreviewPlayer', () => ({
    default: ({url, fileName}: {url: string; fileName?: string}) => (
        <div data-testid="audio" data-url={url} data-file={fileName}/>
    ),
}))

describe('ToolCallResult', () => {
    it('output 为空字符串 → 渲染 null', () => {
        const {container} = render(<ToolCallResult output=""/>)
        expect(container.firstChild).toBeNull()
    })

    it('默认 toolCallName → 标签为「输出」，且存在 data-find-exclude 标记', () => {
        const {container} = render(<ToolCallResult output="hello"/>)
        expect(screen.getByText('输出')).toBeTruthy()
        expect(container.querySelector('[data-find-exclude]')).not.toBeNull()
    })

    it("toolCallName='file_edit' → 标签为「执行结果」", () => {
        render(<ToolCallResult output="hello" toolCallName="file_edit"/>)
        expect(screen.getByText('执行结果')).toBeTruthy()
    })

    it('普通工具（bash）短文本 → 传给 MarkdownRenderer 的内容为 output 原文', () => {
        render(<ToolCallResult output={'line one\nline two'} toolCallName="bash"/>)
        expect(screen.getByTestId('md').textContent).toBe('line one\nline two')
    })

    it('普通工具（bash）长文本 → 截断到 4000 且以省略号结尾', () => {
        render(<ToolCallResult output={'x'.repeat(5000)} toolCallName="bash"/>)
        const text = screen.getByTestId('md').textContent ?? ''
        expect(text.length).toBe(4000)
        expect(text.endsWith('…')).toBe(true)
    })

    it("toolCallName='agent' → 原样 output（不做 4000 截断）", () => {
        const long = 'x'.repeat(5000)
        render(<ToolCallResult output={long} toolCallName="agent"/>)
        expect(screen.getByTestId('md').textContent).toBe(long)
    })

    it('output 含音频 URL → 渲染 AudioPreviewPlayer 并传入提取后的 url / fileName', () => {
        render(<ToolCallResult output="https://cdn.example.com/a.mp3?x=1"/>)
        const player = screen.getByTestId('audio')
        expect(player.getAttribute('data-url')).toBe('https://cdn.example.com/a.mp3?x=1')
        expect(player.getAttribute('data-file')).toBe('a.mp3')
    })

    it('output 不含音频特征 → 不渲染 AudioPreviewPlayer', () => {
        render(<ToolCallResult output="done"/>)
        expect(screen.queryByTestId('audio')).toBeNull()
    })
})
