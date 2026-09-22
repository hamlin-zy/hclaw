// @vitest-environment jsdom
/**
 * MessageList 滚动跟随回归测试：程序化滚动不得关闭「自动跟随」
 *
 * 覆盖缺陷：
 * 1. handleScroll 曾用「距底 > 100px」直接改写 userScrolledAwayRef，不区分
 *    用户滚动与程序化滚动 —— content-visibility:auto + 内容流式增长下，
 *    smooth 落点必然落后于过期目标 → 该 scroll 事件把开关置真
 *    → 「回到底部」后新内容一渲染又脱底，且只能靠手滚到底/发用户消息恢复。
 * 2. goToBottom 收敛循环最后一跳 `if (n >= 2) return` 在 setTimeout 之前，
 *    超出预算后不再校验、也无瞬时对齐兜底 → 目标持续过期时永远到不了底。
 *
 * jsdom 无布局引擎：手工给容器装上可控几何（scrollHeight/clientHeight/scrollTop），
 * scrollTo 只记录不产生位移，用于模拟「smooth 目标过期、落点不动」。
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'
import type {ReactElement} from 'react'
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

let scrollToMock: ReturnType<typeof vi.fn>

beforeEach(() => {
    mockConversationState.messagesMap = {}
    mockConversationState.loadedMessages = []
    mockConversationState.activeConversationId = null
    mockConversationState.hasMoreMap = {}
    mockConversationState.loadingMoreMap = {}
    mockAgentState.convAgentStates = {}
    mockAgentState.errorMessage = null

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

    // scrollTo / scrollIntoView：只记录，不产生真实位移（jsdom 无滚动引擎；
    // 「落点不动」正是 content-visibility 目标过期场景的等价模拟）
    scrollToMock = vi.fn()
    Element.prototype.scrollTo = scrollToMock as any
    Element.prototype.scrollIntoView = vi.fn() as any

    // 几何：容器 top=0/bottom=800；行按 idx*80 排列，随 scrollTop 位移
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        const isContainer = this.getAttribute?.('data-name') === 'message-list-scroll-container'
        if (isContainer) return {top: 0, bottom: 800, left: 0, right: 500, width: 500, height: 800, x: 0, y: 0} as DOMRect
        const idxAttr = this.getAttribute?.('data-msg-idx')
        if (idxAttr !== null && idxAttr !== undefined) {
            const top = Number(idxAttr) * 80
            return {top, bottom: top + 80, left: 0, right: 500, width: 500, height: 80, x: 0, y: top} as DOMRect
        }
        return {top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0} as DOMRect
    })
})

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

/** 追加一条 assistant 消息并触发重渲染（模拟流式新消息 / 新消息落库） */
function appendAssistantAndRerender(
    rerender: (ui: ReactElement) => void,
    id: string,
    content = '新回复',
) {
    const prev = mockConversationState.messagesMap['conv-1'] ?? []
    mockConversationState.messagesMap['conv-1'] = [...prev, {id, role: 'assistant', content}]
    mockConversationState.loadedMessages = mockConversationState.messagesMap['conv-1']
    rerender(<MessageList conversationId="conv-1"/>)
}

/** 容器几何注入（jsdom 无布局引擎）：scrollTop 需可读回，故用存取器而非固定值 */
function injectGeometry(
    container: HTMLElement,
    init: {scrollHeight: number; clientHeight: number; scrollTop: number},
) {
    let scrollTop = init.scrollTop
    let scrollHeight = init.scrollHeight
    Object.defineProperty(container, 'scrollHeight', {
        configurable: true,
        get: () => scrollHeight,
        set: (v: number) => { scrollHeight = v },
    })
    Object.defineProperty(container, 'clientHeight', {value: init.clientHeight, configurable: true})
    Object.defineProperty(container, 'scrollTop', {
        configurable: true,
        get: () => scrollTop,
        set: (v: number) => { scrollTop = v },
    })
    return {
        setScrollTop: (v: number) => { scrollTop = v },
        setScrollHeight: (v: number) => { scrollHeight = v },
    }
}

/** 渲染 + 等待初始化滚动 settle（避免初始化滚动的 scrollTo 调用混入断言） */
async function renderAndSettle() {
    const {rerender} = render(<MessageList conversationId="conv-1"/>)
    const container = document.querySelector('[data-name="message-list-scroll-container"]') as HTMLElement
    expect(container).toBeTruthy()
    await new Promise(r => setTimeout(r, 80))
    scrollToMock.mockClear()
    return {container, rerender}
}

describe('MessageList 自动跟随（回到底部后不脱底）', () => {
    it('程序化平滑滚动落点落后不得关闭自动跟随', async () => {
        seedConversation()
        const {container, rerender} = await renderAndSettle()
        const geo = injectGeometry(container, {scrollHeight: 2000, clientHeight: 800, scrollTop: 1200})
        // 距底 0 → 处于底部（away=false）
        fireEvent.scroll(container)
        await waitFor(() => {
            expect(document.querySelector('[aria-label="回到底部"]')).toBeNull()
        })

        // 新 assistant 消息 → 自动跟随（smooth）
        appendAssistantAndRerender(rerender, 'm4')
        await waitFor(() => {
            expect(scrollToMock).toHaveBeenCalledWith({top: 2000, behavior: 'smooth'})
        })

        // 模拟「程序化平滑滚动落点落后」：内容增长到 2400，落点仍在 1200（距底 400，无用户输入）
        geo.setScrollHeight(2400)
        geo.setScrollTop(1200)
        fireEvent.scroll(container)

        scrollToMock.mockClear()
        appendAssistantAndRerender(rerender, 'm5')
        // 跟随开关不得被这次程序化 scroll 事件关闭 → 仍应自动跟随
        await waitFor(() => {
            expect(scrollToMock).toHaveBeenCalledWith({top: 2400, behavior: 'smooth'})
        })
    })

    it('用户主动滚动仍必须关闭自动跟随', async () => {
        seedConversation()
        const {container, rerender} = await renderAndSettle()
        const geo = injectGeometry(container, {scrollHeight: 2000, clientHeight: 800, scrollTop: 1200})
        fireEvent.scroll(container) // 处于底部

        // 用户主动上翻（wheel 输入意图）→ 距底 800
        fireEvent.wheel(container)
        geo.setScrollTop(400)
        fireEvent.scroll(container)

        scrollToMock.mockClear()
        appendAssistantAndRerender(rerender, 'm4')
        await new Promise(r => setTimeout(r, 50))
        expect(scrollToMock).not.toHaveBeenCalled()
    })

    it('回到底部：超出收敛预算后强制瞬时对齐', async () => {
        seedConversation()
        const {container} = await renderAndSettle()
        injectGeometry(container, {scrollHeight: 2000, clientHeight: 800, scrollTop: 0})
        // 非底部：距底 1200 → 显示「回到底部」
        fireEvent.scroll(container)
        let bottomBtn: HTMLButtonElement | null = null
        await waitFor(() => {
            bottomBtn = document.querySelector('[aria-label="回到底部"]') as HTMLButtonElement
            expect(bottomBtn).toBeTruthy()
        })

        // scrollTo spy 只记录、不改动 scrollTop（模拟目标过期 / 落点不动）
        fireEvent.click(bottomBtn!)

        await waitFor(() => {
            expect(container.scrollTop).toBe(1200) // scrollHeight - clientHeight
        }, {timeout: 1500})
    })

    it('滚轮向上单格（位移不超过按钮阈值）必须立即打断跟随', async () => {
        seedConversation()
        const {container, rerender} = await renderAndSettle()
        const geo = injectGeometry(container, {scrollHeight: 2000, clientHeight: 800, scrollTop: 1200})
        // 距底 0 → 处于底部（away=false）
        fireEvent.scroll(container)
        await waitFor(() => {
            expect(document.querySelector('[aria-label="回到底部"]')).toBeNull()
        })

        // 用户上滚一格：位移仅 100px（恰在「回到底部」按钮阈值内），但已不是真正到底
        fireEvent.wheel(container)
        geo.setScrollTop(1100)
        fireEvent.scroll(container)

        scrollToMock.mockClear()
        appendAssistantAndRerender(rerender, 'm4')
        await new Promise(r => setTimeout(r, 50))
        // 跟随必须已被打断：不得回拉
        expect(scrollToMock).not.toHaveBeenCalled()
    })

    it('用户滚回真正底部后恢复自动跟随', async () => {
        seedConversation()
        const {container, rerender} = await renderAndSettle()
        const geo = injectGeometry(container, {scrollHeight: 2000, clientHeight: 800, scrollTop: 1200})
        fireEvent.scroll(container) // 处于底部

        // 先接管：滚到距底 800
        fireEvent.wheel(container)
        geo.setScrollTop(400)
        fireEvent.scroll(container)
        scrollToMock.mockClear()
        appendAssistantAndRerender(rerender, 'm4')
        await new Promise(r => setTimeout(r, 50))
        expect(scrollToMock).not.toHaveBeenCalled()

        // 再滚回真正底部（距底 0）→ 交还自动跟随
        geo.setScrollTop(1200)
        fireEvent.scroll(container)

        scrollToMock.mockClear()
        appendAssistantAndRerender(rerender, 'm5')
        await waitFor(() => {
            expect(scrollToMock).toHaveBeenCalledWith({top: 2000, behavior: 'smooth'})
        })
    })
})
