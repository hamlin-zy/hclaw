// @vitest-environment jsdom
/**
 * MessageList 右下角「会话来源导航」按钮测试
 *
 * 覆盖：
 * 1. 子会话（有 parentConvId）→ 常驻显示「←父会话」，点击切换到父会话
 * 2. 交接会话（有 handoffFromConvId）→ 常驻显示「←前会话」，点击切换到来源会话
 * 3. 普通会话 → 不渲染任何来源按钮
 * 4. 同时具备两种来源 → 两个按钮并排显示
 *
 * 来源按钮与滚动位置无关（常驻），不依赖 showScrollBtn。
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {render, waitFor, fireEvent} from '@testing-library/react'
import MessageList from '../../../../src/renderer/components/message-list/MessageList'

const {mockConversationState, mockAgentState} = vi.hoisted(() => ({
    mockConversationState: {
        messagesMap: {} as Record<string, any[]>,
        loadedMessages: [] as any[],
        activeConversationId: null as string | null,
        hasMoreMap: {} as Record<string, boolean>,
        loadingMoreMap: {} as Record<string, boolean>,
        currentWorkspacePath: '/ws' as string | null,
        workspaces: {} as Record<string, {lastOpenedAt: number; conversations: any[]}>,
        setActiveConversation: vi.fn(),
    },
    mockAgentState: {
        convAgentStates: {} as Record<string, any>,
        streamingMessageId: null as string | null,
        agentState: {status: 'idle', phase: 'idle', mode: 'auto'},
        errorMessage: null as string | null,
        isThinkingAfterTools: false,
    },
}))

vi.mock('../../../../src/renderer/stores/conversationStore', () => ({
    useConversationStore: Object.assign(
        (selector: (s: typeof mockConversationState) => unknown) => selector(mockConversationState),
        {getState: () => mockConversationState},
    ),
}))

vi.mock('../../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: (selector: (s: typeof mockAgentState) => unknown) =>
        selector(mockAgentState),
}))

beforeEach(() => {
    vi.clearAllMocks()
    mockConversationState.messagesMap = {}
    mockConversationState.loadedMessages = []
    mockConversationState.activeConversationId = null
    mockConversationState.hasMoreMap = {}
    mockConversationState.loadingMoreMap = {}
    mockConversationState.currentWorkspacePath = '/ws'
    mockConversationState.workspaces = {}

    vi.stubGlobal('IntersectionObserver', class {
        observe() {}
        unobserve() {}
        disconnect() {}
        root = null; rootMargin = ''; thresholds = []
        takeRecords(): IntersectionObserverEntry[] { return [] }
    })
    vi.stubGlobal('MutationObserver', class {
        observe() {}
        disconnect() {}
        takeRecords(): MutationRecord[] { return [] }
    })
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
        cb(0)
        return 0
    })
    Element.prototype.scrollIntoView = vi.fn()
    Element.prototype.scrollTo = vi.fn()
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        return {top: 0, bottom: 800, left: 0, right: 500, width: 500, height: 800, x: 0, y: 0} as DOMRect
    })
})

/** 种子最小会话：两条消息 + 指定来源字段 */
function seedOriginConversation(origin: {parentConvId?: string; handoffFromConvId?: string}) {
    mockConversationState.messagesMap['conv-child'] = [
        {id: 'm0', role: 'user', content: '第一条'},
        {id: 'm1', role: 'assistant', content: '回复'},
    ]
    mockConversationState.loadedMessages = mockConversationState.messagesMap['conv-child']
    mockConversationState.activeConversationId = 'conv-child'
    mockConversationState.workspaces['/ws'] = {
        lastOpenedAt: 1,
        conversations: [{id: 'conv-child', title: '子会话', preview: '', createdAt: 1, updatedAt: 1, ...origin}],
    }
}

async function renderChild() {
    render(<MessageList conversationId="conv-child"/>)
    await waitFor(() => {
        expect(document.querySelector('[data-msg-idx="0"]')).toBeTruthy()
    })
}

describe('MessageList 会话来源导航按钮', () => {
    it('子会话：常驻显示「←父会话」，点击切换到父会话', async () => {
        seedOriginConversation({parentConvId: 'conv-parent'})
        await renderChild()

        const btn = document.querySelector('[aria-label="←父会话"]') as HTMLButtonElement
        expect(btn).toBeTruthy()

        fireEvent.click(btn)
        expect(mockConversationState.setActiveConversation).toHaveBeenCalledWith('conv-parent')
    })

    it('交接会话：常驻显示「←前会话」，点击切换到来源会话', async () => {
        seedOriginConversation({handoffFromConvId: 'conv-source'})
        await renderChild()

        const btn = document.querySelector('[aria-label="←前会话"]') as HTMLButtonElement
        expect(btn).toBeTruthy()

        fireEvent.click(btn)
        expect(mockConversationState.setActiveConversation).toHaveBeenCalledWith('conv-source')
    })

    it('普通会话：不渲染来源按钮', async () => {
        seedOriginConversation({})
        await renderChild()

        expect(document.querySelector('[aria-label="←父会话"]')).toBeNull()
        expect(document.querySelector('[aria-label="←前会话"]')).toBeNull()
    })

    it('同时具备父子与交接来源：两个按钮并排显示', async () => {
        seedOriginConversation({parentConvId: 'conv-parent', handoffFromConvId: 'conv-source'})
        await renderChild()

        expect(document.querySelector('[aria-label="←父会话"]')).toBeTruthy()
        expect(document.querySelector('[aria-label="←前会话"]')).toBeTruthy()
    })

    it('未向上滚动时也显示（常驻，与 showScrollBtn 无关）', async () => {
        seedOriginConversation({parentConvId: 'conv-parent'})
        await renderChild()

        // 未触发 scroll 事件 → showScrollBtn=false；三个圆形导航钮不存在，
        // 但「←父会话」仍渲染
        expect(document.querySelector('[aria-label="回到底部"]')).toBeNull()
        expect(document.querySelector('[aria-label="←父会话"]')).toBeTruthy()
    })
})
