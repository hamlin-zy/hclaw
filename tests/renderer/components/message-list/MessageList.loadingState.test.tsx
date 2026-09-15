// @vitest-environment jsdom
/**
 * MessageList 未加载态回归测试（渲染层加固第 4 项）
 *
 * 背景：首屏水合（loadMessagesInitial）不经过 loadingMoreMap；切到未缓存会话时
 * `messagesMap[convId]` 为 undefined，旧实现用 `|| []` 把它折叠成空数组 → 先闪一次
 * `<WelcomeMessage/>`，数据到达后才切到真实内容。
 *
 * 修复后必须区分三态：
 *  · messagesMap[convId] === undefined → 未加载（显示加载态）
 *  · messagesMap[convId] === []        → 已加载且确实为空（显示 WelcomeMessage）
 *  · 有内容                            → 正常渲染
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {render, screen} from '@testing-library/react'
import MessageList from '../../../../src/renderer/components/message-list/MessageList'

const {mockConversationState, mockAgentState} = vi.hoisted(() => ({
    mockConversationState: {
        messagesMap: {} as Record<string, any[]>,
        loadedMessages: [] as any[],
        activeConversationId: null as string | null,
        hasMoreMap: {} as Record<string, boolean>,
        loadingMoreMap: {} as Record<string, boolean>,
        currentWorkspacePath: null as string | null,
        workspaces: {} as Record<string, any>,
    },
    mockAgentState: {
        convAgentStates: {} as Record<string, any>,
        streamingMessageId: null as string | null,
        agentState: {status: 'idle', phase: 'idle', mode: 'auto'} as {status: string; phase: string; mode: string},
        errorMessage: null as string | null,
    },
}))

vi.mock('../../../../src/renderer/stores/conversationStore', () => ({
    useConversationStore: Object.assign(
        (selector: (s: typeof mockConversationState) => unknown) => selector(mockConversationState),
        {getState: () => mockConversationState},
    ),
}))

vi.mock('../../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: (selector: (s: typeof mockAgentState) => unknown) => selector(mockAgentState),
}))

beforeEach(() => {
    mockConversationState.messagesMap = {}
    mockConversationState.loadedMessages = []
    mockConversationState.activeConversationId = 'conv-1'
    mockConversationState.hasMoreMap = {}
    mockConversationState.loadingMoreMap = {}
    mockConversationState.currentWorkspacePath = null
    mockConversationState.workspaces = {}
    mockAgentState.convAgentStates = {}

    vi.stubGlobal('IntersectionObserver', class {
        observe() {}
        unobserve() {}
        disconnect() {}
        root = null
        rootMargin = ''
        thresholds = []
        takeRecords(): IntersectionObserverEntry[] { return [] }
    })
    vi.stubGlobal('MutationObserver', class {
        observe() {}
        disconnect() {}
        takeRecords(): MutationRecord[] { return [] }
    })
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0 })
    Element.prototype.scrollIntoView = vi.fn()
    Element.prototype.scrollTo = vi.fn()
})

const WELCOME_TEXT = '欢迎使用 HClaw'

describe('4) MessageList 未加载态（消除欢迎页闪烁）', () => {
    it('messagesMap[convId] === undefined → 渲染加载态，不渲染 WelcomeMessage', () => {
        delete mockConversationState.messagesMap['conv-1']
        render(<MessageList conversationId="conv-1"/>)

        expect(document.querySelector('[data-name="message-list-loading"]')).toBeTruthy()
        expect(screen.queryByText(WELCOME_TEXT)).toBeNull()
    })

    it('messagesMap[convId] === [] → 渲染 WelcomeMessage，不残留加载态', () => {
        mockConversationState.messagesMap['conv-1'] = []
        render(<MessageList conversationId="conv-1"/>)

        expect(screen.getByText(WELCOME_TEXT)).toBeTruthy()
        expect(document.querySelector('[data-name="message-list-loading"]')).toBeNull()
    })

    it('有内容 → 正常渲染消息，既无加载态也无 WelcomeMessage', () => {
        mockConversationState.messagesMap['conv-1'] = [
            {id: 'm0', role: 'user', content: '你好', timestamp: 1},
        ]
        mockConversationState.loadedMessages = mockConversationState.messagesMap['conv-1']
        render(<MessageList conversationId="conv-1"/>)

        expect(document.querySelector('[data-name="message-list-loading"]')).toBeNull()
        expect(screen.queryByText(WELCOME_TEXT)).toBeNull()
        expect(screen.getByText('你好')).toBeTruthy()
    })

    it('未指定 conversationId（全局模式）保持旧行为：空 messages 直接渲染 WelcomeMessage', () => {
        mockConversationState.loadedMessages = []
        render(<MessageList/>)

        expect(screen.getByText(WELCOME_TEXT)).toBeTruthy()
        expect(document.querySelector('[data-name="message-list-loading"]')).toBeNull()
    })
})
