// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {render, screen, fireEvent} from '@testing-library/react'
import SubAgentViewer from '../../../../src/renderer/components/message-list/SubAgentViewer'

// ── 依赖 mock ──
// MarkdownRenderer 依赖 react-markdown/syntax-highlighter/settingsStore/MediaPlayer 等，
// mock 成本高，降级为纯文本容器（SubAgentViewer 只在结果输出处透传字符串）
vi.mock('../../../../src/renderer/components/message-list/MarkdownRenderer', () => ({
    default: ({children}: { children: string }) => <div data-testid="markdown">{children}</div>,
}))

// 定义 mock 流条目（SubAgentViewer 展开/折叠验证的目标数据）
const streamEntries = [
    {type: 'thinking' as const, timestamp: 1000, content: '正在思考...'},
    {type: 'text' as const, timestamp: 2000, content: '这是正文内容'},
]

beforeEach(() => {
    // SubAgentViewer 用 createPortal(document.body) 渲染，jsdom 支持
    // scrollIntoView（自动滚动锚点）
    Element.prototype.scrollIntoView = vi.fn()
})

describe('SubAgentViewer toggle（Task 4 改写的折叠/展开分支）', () => {
    it('详细输出页：思考块默认展开，点击后折叠', () => {
        render(
            <SubAgentViewer
                title="子Agent测试"
                subAgentStream={streamEntries}
                onClose={vi.fn()}
            />,
        )

        // 默认 activeTab=stream（有 entries），思考内容可见
        expect(screen.getByText('正在思考...')).toBeTruthy()

        // 点击"思考过程"折叠按钮 → 内容隐藏
        fireEvent.click(screen.getByText('思考过程'))
        expect(screen.queryByText('正在思考...')).toBeNull()
    })

    it('再次点击"思考过程"展开恢复内容', () => {
        render(
            <SubAgentViewer
                title="子Agent测试"
                subAgentStream={streamEntries}
                onClose={vi.fn()}
            />,
        )

        fireEvent.click(screen.getByText('思考过程'))
        expect(screen.queryByText('正在思考...')).toBeNull()

        fireEvent.click(screen.getByText('思考过程'))
        expect(screen.getByText('正在思考...')).toBeTruthy()
    })
})
