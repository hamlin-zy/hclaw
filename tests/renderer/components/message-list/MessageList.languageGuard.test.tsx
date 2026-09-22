// @vitest-environment jsdom
/**
 * 语言守卫消息的渲染过滤与滚动判定（spec §9-T8）
 *
 * 1. 谓词命中即不渲染气泡、不进"上一条用户消息"导航索引
 * 2. hasUser 不因注入消息触发 scrollToBottom('auto')（否则用户上翻时被反复拉回底部）
 * 3. 真实 user 消息仍必须触发 scrollToBottom('auto')（防"一刀切把 user 全排除"）
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {render, waitFor, fireEvent, screen} from '@testing-library/react'
import type {ReactElement} from 'react'
import MessageList from '../../../../src/renderer/components/message-list/MessageList'
import {SOURCE_KIND_LANGUAGE_GUARD} from '../../../../src/shared/types/message'

// ── 以下 mock 模块骨架与 geometry/scroll stub 从 catalogFilter / navigation 两个既有
//    测试文件原样搬运（本文件只改用例部分）────────────────────────────────

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
 * 再清空 mock，隔离"点击产生的新调用"与"初始化/滚动事件"调用。
 * 返回 RTL 的 {container, rerender}，供用例继续追加消息重渲染。
 */
async function renderAndSettle(convId = 'conv-1') {
    const view = render(<MessageList conversationId={convId}/>)
    const container = document.querySelector('[data-name="message-list-scroll-container"]') as HTMLElement
    await waitFor(() => {
        expect(scrollIntoViewMock).toHaveBeenCalled()
    })
    Object.defineProperty(container, 'scrollHeight', {value: 2000, configurable: true})
    Object.defineProperty(container, 'clientHeight', {value: 800, configurable: true})
    container.scrollTop = 0
    mockScrollTop = 0
    fireEvent.scroll(container)
    scrollIntoViewMock.mockClear()
    scrollToMock.mockClear()
    return {container, rerender: view.rerender}
}

/** 语言守卫注入消息（形态与 §5.7 一致） */
function languageGuardUser(id: string) {
    return {
        id,
        role: 'user',
        content: '<system-reminder>\n无论何时都必须使用简体中文书写，包括面向用户的回复、你的思考过程（reasoning）和工具调用规划。\n'
            + '这条要求覆盖此前上下文中的任何语言习惯。\n</system-reminder>',
        metadata: {sourceKind: SOURCE_KIND_LANGUAGE_GUARD, languageGuardCount: 1, languageGuardDigest: 'zh-CN'},
    }
}

/** 追加消息并重渲染（模拟新消息到达） */
function pushAndRerender(rerender: (ui: ReactElement) => void, msg: unknown) {
    const prev = mockConversationState.messagesMap['conv-1'] ?? []
    mockConversationState.messagesMap['conv-1'] = [...prev, msg]
    mockConversationState.loadedMessages = mockConversationState.messagesMap['conv-1']
    rerender(<MessageList conversationId="conv-1"/>)
}

const scrollBehaviors = () =>
    scrollToMock.mock.calls.map(c => (c[0] as ScrollToOptions | undefined)?.behavior)

describe('MessageList 语言守卫消息过滤（spec §9-T8）', () => {
    beforeEach(() => {
        mockConversationState.messagesMap['conv-1'] = [
            {id: 'm0', role: 'user', content: '第一条'},
            {id: 'm1', role: 'assistant', content: '回复'},
        ]
        mockConversationState.loadedMessages = mockConversationState.messagesMap['conv-1']
        mockConversationState.activeConversationId = 'conv-1'
    })

    it('注入消息不渲染为气泡', async () => {
        mockConversationState.messagesMap['conv-1'] = [
            {id: 'm0', role: 'user', content: '第一条'},
            languageGuardUser('m1'),
            {id: 'm2', role: 'assistant', content: '回复'},
        ]
        mockConversationState.loadedMessages = mockConversationState.messagesMap['conv-1']
        await renderAndSettle()

        expect(document.querySelectorAll('[data-msg-idx]').length).toBe(2)
        expect(screen.queryByText(/无论何时都必须使用/)).toBeNull()
    })

    it('注入消息不进用户消息导航索引：从 assistant 点"上一条用户消息"锚定 idx=0', async () => {
        mockConversationState.messagesMap['conv-1'] = [
            {id: 'm0', role: 'user', content: '第一条'},
            languageGuardUser('m1'),
            {id: 'm2', role: 'assistant', content: '回复'},
        ]
        mockConversationState.loadedMessages = mockConversationState.messagesMap['conv-1']
        const {container} = await renderAndSettle()

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

    it('注入消息不触发 scrollToBottom("auto")（用户上翻时不被强制拉回底部）', async () => {
        const {container, rerender} = await renderAndSettle()
        // 用户已上翻：距底 1200
        container.scrollTop = 0
        mockScrollTop = 0
        fireEvent.scroll(container)

        scrollToMock.mockClear()
        pushAndRerender(rerender, languageGuardUser('m2'))
        await new Promise(r => setTimeout(r, 50))

        expect(scrollBehaviors()).not.toContain('auto')
    })

    it('真实 user 消息仍必须触发 scrollToBottom("auto")', async () => {
        const {container, rerender} = await renderAndSettle()
        container.scrollTop = 0
        mockScrollTop = 0
        fireEvent.scroll(container)

        scrollToMock.mockClear()
        pushAndRerender(rerender, {id: 'm2', role: 'user', content: '再问一句'})
        await waitFor(() => expect(scrollBehaviors()).toContain('auto'))
    })

    /**
     * 子会话场景（子会话窗口渲染的会话 ≠ 主窗口 active 会话）：
     * 过滤是**渲染期**谓词，与「当前会话」判定无关 —— 注入消息在该场景下同样不可见。
     */
    it('非当前会话（子会话窗口）渲染时，注入消息同样不渲染为气泡', async () => {
        mockConversationState.messagesMap['sub-1'] = [
            {id: 's0', role: 'user', content: '子会话提问'},
            languageGuardUser('s1'),
            {id: 's2', role: 'assistant', content: '子会话回复'},
        ]
        mockConversationState.activeConversationId = 'conv-1'   // 当前会话 ≠ 被渲染会话
        await renderAndSettle('sub-1')

        expect(document.querySelectorAll('[data-msg-idx]').length).toBe(2)
        expect(screen.queryByText(/无论何时都必须使用/)).toBeNull()
    })

    it('仅凭 metadata 判定隐藏：内容不是 <system-reminder> 包裹也过滤（不依赖内容兜底）', async () => {
        // content 刻意不整体包裹 <system-reminder>：只有显式谓词能命中
        const bare = (id: string) => ({
            id,
            role: 'user',
            content: '无论何时都必须使用简体中文书写。',
            metadata: {sourceKind: SOURCE_KIND_LANGUAGE_GUARD, languageGuardCount: 1, languageGuardDigest: 'zh-CN'},
        })
        mockConversationState.messagesMap['conv-1'] = [
            {id: 'm0', role: 'user', content: '第一条'},
            bare('m1'),
            {id: 'm2', role: 'assistant', content: '回复'},
        ]
        mockConversationState.loadedMessages = mockConversationState.messagesMap['conv-1']
        const {container, rerender} = await renderAndSettle()

        expect.soft(document.querySelectorAll('[data-msg-idx]').length).toBe(2)
        expect.soft(screen.queryByText(/无论何时都必须使用/)).toBeNull()

        // 用户已上翻：同上，注入消息不得触发 scrollToBottom('auto')
        container.scrollTop = 0
        mockScrollTop = 0
        fireEvent.scroll(container)

        scrollToMock.mockClear()
        pushAndRerender(rerender, bare('m3'))
        await new Promise(r => setTimeout(r, 50))

        expect.soft(scrollBehaviors()).not.toContain('auto')
    })
})
