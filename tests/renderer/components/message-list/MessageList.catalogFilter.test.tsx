// @vitest-environment jsdom
/**
 * MessageList 能力目录消息过滤与状态行测试
 *
 * 覆盖：
 * 1. [user, catalog-user, assistant] → 仅渲染 2 个气泡，状态行挂在 assistant 上方
 * 2. "上一条用户消息"导航从 assistant 跳到第一个 user（跳过 catalog）
 * 3. catalog 位于会话末尾（无后续 assistant）→ 不挂载状态行、组件树不崩溃
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {render, waitFor, fireEvent, screen} from '@testing-library/react'
import MessageList from '../../../../src/renderer/components/message-list/MessageList'
import {SOURCE_KIND_CATALOG} from '../../../../src/shared/types/message'

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

vi.mock('../../../../src/renderer/stores/conversationStore', () => ({
    useConversationStore: Object.assign(
        (selector: (s: typeof mockConversationState) => unknown) => selector(mockConversationState),
        {getState: () => mockConversationState},
    ),
}))

vi.mock('../../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: (selector: (s: typeof mockAgentState) => unknown) => selector(mockAgentState),
}))

const ROW_HEIGHT = 80
let mockScrollTop = 0
let scrollIntoViewMock: ReturnType<typeof vi.fn>

beforeEach(() => {
    mockConversationState.messagesMap = {}
    mockConversationState.loadedMessages = []
    mockConversationState.activeConversationId = null
    mockConversationState.hasMoreMap = {}
    mockConversationState.loadingMoreMap = {}
    mockAgentState.convAgentStates = {}
    mockAgentState.errorMessage = null
    mockScrollTop = 0

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

    scrollIntoViewMock = vi.fn(function (this: Element) {
        const idx = this.getAttribute('data-msg-idx')
        if (idx !== null) mockScrollTop = Number(idx) * ROW_HEIGHT
    })
    Element.prototype.scrollIntoView = scrollIntoViewMock as any
    Element.prototype.scrollTo = vi.fn() as any

    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        const isContainer = this.getAttribute?.('data-name') === 'message-list-scroll-container'
        if (isContainer) return {top: 0, bottom: 800, left: 0, right: 500, width: 500, height: 800, x: 0, y: 0} as DOMRect
        const idxAttr = this.getAttribute?.('data-msg-idx')
        if (idxAttr !== null) {
            const docTop = Number(idxAttr) * ROW_HEIGHT
            const top = docTop - mockScrollTop
            return {top, bottom: top + ROW_HEIGHT, left: 0, right: 500, width: 500, height: ROW_HEIGHT, x: 0, y: top} as DOMRect
        }
        return {top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0} as DOMRect
    })
})

function catalogUser(id: string) {
    return {
        id,
        role: 'user',
        content: '<capability-catalog>...</capability-catalog>',
        metadata: {
            sourceKind: SOURCE_KIND_CATALOG,
            catalogEntries: [{name: 'a', type: 'skill', description: 'd'}],
        },
    }
}

async function renderAndSettle(convId = 'conv-1') {
    render(<MessageList conversationId={convId}/>)
    const container = document.querySelector('[data-name="message-list-scroll-container"]') as HTMLElement
    await waitFor(() => expect(scrollIntoViewMock).toHaveBeenCalled())
    Object.defineProperty(container, 'scrollHeight', {value: 2000, configurable: true})
    Object.defineProperty(container, 'clientHeight', {value: 800, configurable: true})
    container.scrollTop = 0
    mockScrollTop = 0
    fireEvent.scroll(container)
    scrollIntoViewMock.mockClear()
    return container
}

describe('MessageList 能力目录过滤与状态行', () => {
    it('仅渲染 user/assistant 气泡，catalog 消息被过滤且状态行挂在 assistant 上方', async () => {
        mockConversationState.messagesMap['conv-1'] = [
            {id: 'm0', role: 'user', content: '第一条'},
            catalogUser('m1'),
            {id: 'm2', role: 'assistant', content: '回复'},
        ]
        mockConversationState.loadedMessages = mockConversationState.messagesMap['conv-1']
        mockConversationState.activeConversationId = 'conv-1'

        await renderAndSettle()

        // 仅 2 个气泡行
        expect(document.querySelectorAll('[data-msg-idx]').length).toBe(2)
        expect(screen.queryByText(/capability-catalog/)).toBeNull()
        // 状态行存在
        expect(screen.getByText(/已加载能力目录（1 项）/)).toBeTruthy()
    })

    it('上一条用户消息导航跳过 catalog：从 assistant 处点击回到 idx=0 的 user', async () => {
        mockConversationState.messagesMap['conv-1'] = [
            {id: 'm0', role: 'user', content: '第一条'},
            catalogUser('m1'),
            {id: 'm2', role: 'assistant', content: '回复'},
        ]
        mockConversationState.loadedMessages = mockConversationState.messagesMap['conv-1']
        mockConversationState.activeConversationId = 'conv-1'

        const container = await renderAndSettle()
        // 视口顶部在 idx=2（assistant）
        container.scrollTop = 160
        mockScrollTop = 160
        fireEvent.scroll(container)

        const prevBtn = document.querySelector('[aria-label="上一条用户消息"]') as HTMLButtonElement
        await waitFor(() => expect(prevBtn).toBeTruthy())
        fireEvent.click(prevBtn)

        await waitFor(() => {
            expect(scrollIntoViewMock.mock.calls.length).toBeGreaterThan(0)
            expect(scrollIntoViewMock.mock.instances[0].getAttribute('data-msg-idx')).toBe('0')
        })
    })

    it('catalog 位于会话末尾时不挂载状态行且组件树不崩溃', async () => {
        mockConversationState.messagesMap['conv-1'] = [
            {id: 'm0', role: 'user', content: '第一条'},
            {id: 'm1', role: 'assistant', content: '回复'},
            catalogUser('m2'),
        ]
        mockConversationState.loadedMessages = mockConversationState.messagesMap['conv-1']
        mockConversationState.activeConversationId = 'conv-1'

        await renderAndSettle()

        expect(document.querySelectorAll('[data-msg-idx]').length).toBe(2)
        expect(screen.queryByText(/已加载能力目录/)).toBeNull()
    })

    it('新目录消息 metadata.catalogEntries 为空时从 content 解析条目数（Important-2 回归）', async () => {
        mockConversationState.messagesMap['conv-1'] = [
            {id: 'm0', role: 'user', content: '第一条'},
            {
                id: 'm1',
                role: 'user',
                content: '<system-reminder>\n\n<available_skills>\n- [skill] `alpha`: Do A\n- [skill] `beta`: Do B\n</available_skills>\n</system-reminder>',
                metadata: {sourceKind: SOURCE_KIND_CATALOG, catalogEntries: [], catalogDigest: 'x'},
            },
            {id: 'm2', role: 'assistant', content: '回复'},
        ]
        mockConversationState.loadedMessages = mockConversationState.messagesMap['conv-1']
        mockConversationState.activeConversationId = 'conv-1'

        await renderAndSettle()

        // 状态行计数来自 content 解析，而非固定 0 项
        expect(screen.getByText(/已加载能力目录（2 项）/)).toBeTruthy()
    })
})
