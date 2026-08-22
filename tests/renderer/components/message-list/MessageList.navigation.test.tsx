// @vitest-environment jsdom
/**
 * MessageList 右下角悬浮按钮（上一条/下一条用户消息、回到底部）导航回归测试
 *
 * 覆盖 bug：
 * 1. content-visibility 占位与实际行高差异 → 单次 scrollIntoView 滚偏（"点击无效"）
 *    ——修复后为收敛式滚动（auto 首跳 + 偏差校验 + smooth 补跳）
 * 2. 回到底部单次 scrollTo(scrollHeight) 停中间 —— 修复后自动校验补跳
 *
 * jsdom 无布局引擎：通过 mock getBoundingClientRect 模拟
 * content-visibility 下"行高 80px"的几何（scrollTop 影响视口位置），
 * 验证目标行选择与滚动调用链。
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
    useAgentStore: (selector: (s: typeof mockAgentState) => unknown) =>
        selector(mockAgentState),
}))

// ── 几何 mock：每条消息行 80px 高、按 data-msg-idx 顺序排列 ──
const ROW_HEIGHT = 80
let mockScrollTop = 0
let scrollToMock: ReturnType<typeof vi.fn>
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
        // 模拟滚动：目标行滚到视口顶（更新 mockScrollTop，几何随之变化）
        const idx = this.getAttribute('data-msg-idx')
        if (idx !== null) mockScrollTop = Number(idx) * ROW_HEIGHT
    })
    Element.prototype.scrollIntoView = scrollIntoViewMock as any
    scrollToMock = vi.fn((opts?: ScrollToOptions | number) => {
        if (opts && typeof opts === 'object' && 'top' in opts) mockScrollTop = opts.top ?? 0
    })
    Element.prototype.scrollTo = scrollToMock as any

    // 几何：容器 top=0/bottom=800；行 top = idx*80 - scrollTop
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

/**
 * 渲染会话并等待初始化滚动（MutationObserver 方案 50ms 后 settle 触发一次 scrollIntoView）
 * 完成后模拟可滚动高度 + 触发 scroll 事件（让悬浮按钮 showScrollBtn 显示），
 * 再清空 mock，返回容器元素，隔离"点击产生的新调用"与"初始化/滚动事件"调用。
 */
async function renderAndSettle(convId = 'conv-1') {
    render(<MessageList conversationId={convId}/>)
    const container = document.querySelector('[data-name="message-list-scroll-container"]') as HTMLElement
    await waitFor(() => {
        expect(scrollIntoViewMock).toHaveBeenCalled()
    })
    // 模拟可滚动内容高度并触发滚动事件 → handleScroll → showScrollBtn=true
    Object.defineProperty(container, 'scrollHeight', {value: 2000, configurable: true})
    Object.defineProperty(container, 'clientHeight', {value: 800, configurable: true})
    container.scrollTop = 0
    mockScrollTop = 0
    fireEvent.scroll(container)
    scrollIntoViewMock.mockClear()
    scrollToMock.mockClear()
    return container
}

/** 会话：idx0=user, idx1=assistant, idx2=user, idx3=assistant */
function seedConversation() {
    mockConversationState.messagesMap['conv-1'] = [
        {id: 'm0', role: 'user', content: '第一条用户消息'},
        {id: 'm1', role: 'assistant', content: '回复 1'},
        {id: 'm2', role: 'user', content: '第二条用户消息'},
        {id: 'm3', role: 'assistant', content: '回复 2'},
    ]
    mockConversationState.loadedMessages = mockConversationState.messagesMap['conv-1']
    mockConversationState.activeConversationId = 'conv-1'
}

describe('MessageList 悬浮导航按钮', () => {
    it('上一条用户消息：从第二条用户消息处点击 → 滚动到第一条用户消息（idx=0）', async () => {
        seedConversation()
        // 视口顶部在 idx=2（第二条用户消息）处：scrollTop=160（2*80）
        const container = await renderAndSettle()
        container.scrollTop = 160
        mockScrollTop = 160
        fireEvent.scroll(container) // 更新 currentMsgIdx=2 → 上一条按钮可用

        const prevBtn = document.querySelector('[aria-label="上一条用户消息"]') as HTMLButtonElement
        await waitFor(() => {
            expect(prevBtn).toBeTruthy()
            expect(prevBtn.disabled).toBe(false)
        })
        fireEvent.click(prevBtn)

        // 首跳定位到 idx=0
        await waitFor(() => {
            expect(scrollIntoViewMock.mock.calls.length).toBeGreaterThan(0)
            expect(scrollIntoViewMock.mock.instances[0].getAttribute('data-msg-idx')).toBe('0')
        })
    })

    it('下一条用户消息：从第一条用户消息处点击 → 滚动到第二条用户消息（idx=2）', async () => {
        seedConversation()
        const container = await renderAndSettle()
        container.scrollTop = 0
        mockScrollTop = 0

        const nextBtn = document.querySelector('[aria-label="下一条用户消息"]') as HTMLButtonElement
        await waitFor(() => {
            expect(nextBtn).toBeTruthy()
        })
        fireEvent.click(nextBtn)

        await waitFor(() => {
            expect(scrollIntoViewMock.mock.calls.length).toBeGreaterThan(0)
            expect(scrollIntoViewMock.mock.instances[0].getAttribute('data-msg-idx')).toBe('2')
        })
    })

    it('已到第一条用户消息时点"上一条"不再滚动（无更早用户消息）', async () => {
        seedConversation()
        await renderAndSettle()
        // 视口顶 = idx0（第一条用户消息）

        const prevBtn = document.querySelector('[aria-label="上一条用户消息"]') as HTMLButtonElement
        await waitFor(() => {
            expect(prevBtn).toBeTruthy()
        })
        fireEvent.click(prevBtn)

        // 无更早用户消息 → 不产生新的滚动调用
        expect(scrollIntoViewMock.mock.calls.length).toBe(0)
    })

    it('回到底部：scrollTo 被调用且收敛校验无异常', async () => {
        seedConversation()
        await renderAndSettle()
        mockScrollTop = 0

        const bottomBtn = document.querySelector('[aria-label="回到底部"]') as HTMLButtonElement
        await waitFor(() => {
            expect(bottomBtn).toBeTruthy()
        })
        fireEvent.click(bottomBtn)

        // scrollTo 至少调用一次（auto 首跳）
        await waitFor(() => {
            expect(scrollToMock).toHaveBeenCalled()
        })
        // 收敛校验 timer（160ms 后二次检查；jsdom scrollHeight=0 → distFromBottom=0 不补跳）
        await new Promise(r => setTimeout(r, 250))
        expect(scrollToMock.mock.calls.length).toBeLessThanOrEqual(2)
    })
})
