// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {render, screen, waitFor} from '@testing-library/react'
import MessageList from '../../../../src/renderer/components/message-list/MessageList'

// ── 依赖 mock：静态 store（selector 每次返回同一引用） ──
const {mockConversationState, mockAgentState} = vi.hoisted(() => ({
    mockConversationState: {
        messagesMap: {},
        loadedMessages: [],
        activeConversationId: null,
        hasMoreMap: {},
        loadingMoreMap: {},
    },
    mockAgentState: {
        convAgentStates: {},
        streamingMessageId: null,
    },
}))

vi.mock('../../../../src/renderer/stores/conversationStore', () => ({
    useConversationStore: (selector: (s: typeof mockConversationState) => unknown) =>
        selector(mockConversationState),
}))

vi.mock('../../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: (selector: (s: typeof mockAgentState) => unknown) =>
        selector(mockAgentState),
}))

// framer-motion 在 jsdom 下依赖 ResizeObserver/PointerEvents，渲染真实动画无需
// vi.mock('framer-motion') — MessageList 仅使用 motion 的静态类名与过渡样式。
// 但 MutationObserver / IntersectionObserver 需要 polyfill：
class MockIntersectionObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
    root = null
    rootMargin = ''
    thresholds = []
    takeRecords(): IntersectionObserverEntry[] { return [] }
}

class MockMutationObserver {
    observe() {}
    disconnect() {}
    takeRecords(): MutationRecord[] { return [] }
}

beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
    vi.stubGlobal('MutationObserver', MockMutationObserver)
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
        cb(0)
        return 0
    })
    // Element.prototype.scrollIntoView / scrollTo 在 jsdom 未实现
    Element.prototype.scrollIntoView = vi.fn()
    Element.prototype.scrollTo = vi.fn()
})

describe('MessageList hooks 稳定性（Task 8/9 修复条件 Hook 后的回归）', () => {
    it('无 conversationId 模式连续渲染 2 次不抛错（Hook 顺序稳定）', () => {
        const {rerender} = render(<MessageList />)
        expect(() => rerender(<MessageList />)).not.toThrow()
    })

    it('有 conversationId 模式渲染不抛错', () => {
        expect(() => render(<MessageList conversationId="conv-1" />)).not.toThrow()
    })

    it('两种模式切换渲染不抛错', () => {
        const {rerender} = render(<MessageList />)
        expect(() => rerender(<MessageList conversationId="conv-1" />)).not.toThrow()
        expect(() => rerender(<MessageList />)).not.toThrow()
    })

    it('空消息时渲染欢迎界面', async () => {
        render(<MessageList />)
        await waitFor(() => {
            expect(screen.getByText('欢迎使用 HClaw')).toBeTruthy()
        })
    })
})
