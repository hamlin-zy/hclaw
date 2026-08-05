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

beforeEach(() => {
    // SubAgentViewer 用 createPortal(document.body) 渲染，jsdom 支持
    Element.prototype.scrollIntoView = vi.fn()
})

describe('SubAgentViewer（已完成 Agent 只展示最终输出）', () => {
    it('展示最终输出，不展示思考/工具执行等过程细节', () => {
        render(
            <SubAgentViewer
                title="子Agent测试"
                result={{success: true, output: '这是最终输出内容'}}
                onClose={vi.fn()}
            />,
        )

        // 最终输出可见
        expect(screen.getByText('最终输出')).toBeTruthy()
        expect(screen.getByText('这是最终输出内容')).toBeTruthy()

        // 不应出现思考过程/时间轴/详细输出等过程细节入口
        expect(screen.queryByText('思考过程')).toBeNull()
        expect(screen.queryByText('执行时间轴')).toBeNull()
        expect(screen.queryByText('详细输出')).toBeNull()
    })

    it('无输出时显示占位文案，且不渲染过程细节', () => {
        render(
            <SubAgentViewer
                title="子Agent测试"
                result={null}
                onClose={vi.fn()}
            />,
        )

        expect(screen.getByText('暂无最终输出')).toBeTruthy()
        expect(screen.queryByText('思考过程')).toBeNull()
        expect(screen.queryByText('执行时间轴')).toBeNull()
    })

    it('展示错误信息与 Token 用量', () => {
        render(
            <SubAgentViewer
                title="子Agent测试"
                result={{success: false, output: '', error: '执行失败'}}
                tokenUsage={{inputTokens: 100, outputTokens: 50, totalTokens: 150}}
                onClose={vi.fn()}
            />,
        )

        expect(screen.getByText('错误')).toBeTruthy()
        expect(screen.getByText('执行失败')).toBeTruthy()
        expect(screen.getByText(/TOTAL 150/)).toBeTruthy()
    })

    it('点击关闭按钮调用 onClose', () => {
        const onClose = vi.fn()
        render(
            <SubAgentViewer
                title="子Agent测试"
                result={{success: true, output: '输出'}}
                onClose={onClose}
            />,
        )

        fireEvent.click(screen.getByLabelText('关闭'))
        expect(onClose).toHaveBeenCalled()
    })
})
