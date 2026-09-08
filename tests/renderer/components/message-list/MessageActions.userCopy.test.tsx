// @vitest-environment jsdom
/**
 * 用户消息复制按钮测试
 *
 * 覆盖：
 * 1. 点击复制按钮 → clipboard.writeText 收到 message.content 正文（不含附件）
 * 2. 复制成功后派发 'hclaw-message-copied' 事件 → MessageList 展示 CopyToast
 * 3. 复制按钮不依赖 agent 运行状态（running 时仍可点击）
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, fireEvent, waitFor} from '@testing-library/react'
import MessageList from '../../../../src/renderer/components/message-list/MessageList'

const {mockConversationState, mockAgentState} = vi.hoisted(() => ({
    mockConversationState: {
        messagesMap: {} as Record<string, any[]>,
        loadedMessages: [] as any[],
        activeConversationId: 'conv-1' as string | null,
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

vi.mock('../../../../src/renderer/stores/conversationStore', () => ({
    useConversationStore: Object.assign(
        (selector: (s: typeof mockConversationState) => unknown) => selector(mockConversationState),
        {getState: () => mockConversationState},
    ),
}))

vi.mock('../../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: (selector: (s: typeof mockAgentState) => unknown) => selector(mockAgentState),
}))

const USER_MESSAGE = {
    id: 'msg-1',
    role: 'user',
    content: '帮我修这个 bug',
    timestamp: Date.now(),
    attachments: [{id: 'att-1', name: 'screenshot.png', type: 'image/png', size: 100, path: 'E:\\tmp\\screenshot.png', isImage: true}],
}

beforeEach(() => {
    mockAgentState.convAgentStates = {}
    mockConversationState.messagesMap = {}
    vi.stubGlobal('IntersectionObserver', class {
        observe() {}
        unobserve() {}
        disconnect() {}
    })
    vi.stubGlobal('MutationObserver', class {
        observe() {}
        disconnect() {}
    })
    // rAF 不同步执行：InterleavedContent 流式分支 tick→rAF(tick) 同步递归会栈溢出；
    // 本测试不断言滚动定位，rAF 回调无需执行
    vi.stubGlobal('requestAnimationFrame', () => 0)
    Element.prototype.scrollIntoView = vi.fn() as any
    Element.prototype.scrollTo = vi.fn() as any
    Object.defineProperty(navigator, 'clipboard', {
        value: {writeText: vi.fn().mockResolvedValue(undefined)},
        configurable: true,
        writable: true,
    })
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

/** 渲染含一条用户消息的 MessageList */
function renderWithUserMessage() {
    mockConversationState.messagesMap = {'conv-1': [USER_MESSAGE]}
    return render(<MessageList conversationId="conv-1"/>)
}

function getCopyButton() {
    return document.querySelector('[data-name="message-actions-copy-button"]') as HTMLButtonElement
}

describe('用户消息复制按钮', () => {
    it('点击复制正文，不含附件路径', async () => {
        renderWithUserMessage()
        fireEvent.click(getCopyButton())
        await waitFor(() => {
            expect(navigator.clipboard.writeText).toHaveBeenCalledWith('帮我修这个 bug')
        })
    })

    it('复制成功后展示 CopyToast 提示', async () => {
        renderWithUserMessage()
        expect(document.querySelector('[role="status"]')).toBeNull()
        fireEvent.click(getCopyButton())
        await waitFor(() => {
            expect(document.querySelector('[role="status"]')?.textContent).toContain('已复制')
        })
    })

    it('agent 运行中仍可点击复制', async () => {
        mockAgentState.convAgentStates = {
            'conv-1': {agentState: {status: 'running', phase: 'responding', mode: 'auto'}},
        }
        renderWithUserMessage()
        const btn = getCopyButton()
        expect(btn.disabled).toBe(false)
        fireEvent.click(btn)
        await waitFor(() => {
            expect(navigator.clipboard.writeText).toHaveBeenCalledWith('帮我修这个 bug')
        })
    })

    it('复制失败时不派发事件（无 Toast）', async () => {
        ;(navigator.clipboard.writeText as any).mockRejectedValue(new Error('denied'))
        renderWithUserMessage()
        fireEvent.click(getCopyButton())
        await new Promise(r => setTimeout(r, 50))
        expect(document.querySelector('[role="status"]')).toBeNull()
    })
})
