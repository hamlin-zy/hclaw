// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {render, screen, waitFor} from '@testing-library/react'
import MessageList from '../../../../src/renderer/components/message-list/MessageList'

// ── 依赖 mock：静态 store（selector 每次返回同一引用） ──
const {mockConversationState, mockAgentState} = vi.hoisted(() => ({
    mockConversationState: {
        messagesMap: {} as Record<string, any[]>,
        loadedMessages: [] as any[],
        activeConversationId: null as string | null,
        hasMoreMap: {} as Record<string, boolean>,
        loadingMoreMap: {} as Record<string, boolean>,
    },
    mockAgentState: {
        convAgentStates: {} as Record<string, any>,
        streamingMessageId: null as string | null,
        agentState: {status: 'idle', phase: 'idle', mode: 'auto'} as {status: string; phase: string; mode: string},
        errorMessage: null as string | null,
        isThinkingAfterTools: false,
    },
}))

// ── 辅助：注入一条 assistant 消息，使 lastAssistantId 非空（statusNote 有气泡可挂载） ──
function seedAssistantMessage(convId: string, msgId = 'msg-1') {
    mockConversationState.messagesMap[convId] = [
        {id: msgId, role: 'assistant', content: ''},
    ]
    mockConversationState.loadedMessages = [
        {id: msgId, role: 'assistant', content: ''},
    ]
    mockConversationState.activeConversationId = convId
    mockAgentState.convAgentStates[convId] = {
        streamingMessageId: msgId,
        agentState: {status: 'running', phase: 'streaming', mode: 'auto'},
        errorMessage: null,
        executingToolsMessage: null,
        isThinkingAfterTools: false,
    }
}

vi.mock('../../../../src/renderer/stores/conversationStore', () => ({
    // MessageList 在 useEffect/回调中会调用 getState()（滚动加载/会话切换路径），
    // mock 需提供与真实 store 一致的 API，避免后续测试扩展时崩溃
    useConversationStore: Object.assign(
        (selector: (s: typeof mockConversationState) => unknown) => selector(mockConversationState),
        {getState: () => mockConversationState},
    ),
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

    // ── statusNote 文案覆盖（本次改动相关回归） ──

    it('executing_tools 阶段：statusNote 显示「本地工具执行中...」', async () => {
        seedAssistantMessage('conv-1')
        mockAgentState.convAgentStates['conv-1'].agentState.phase = 'executing_tools'
        render(<MessageList conversationId="conv-1" />)
        await waitFor(() => {
            expect(screen.getByText('本地工具执行中...')).toBeTruthy()
        })
    })

    it('阶段文案：服务商与模型以冒号+空格分隔', async () => {
        seedAssistantMessage('conv-1')
        mockAgentState.convAgentStates['conv-1'].agentState.phase = 'streaming'
        mockAgentState.convAgentStates['conv-1'].agentState.currentModelProvider = 'OpenRouter'
        mockAgentState.convAgentStates['conv-1'].agentState.currentModelName = 'dots-3-note-preview:free'
        render(<MessageList conversationId="conv-1" />)
        await waitFor(() => {
            expect(screen.getByText(/OpenRouter: dots-3-note-preview:free/)).toBeTruthy()
        })
    })
})
