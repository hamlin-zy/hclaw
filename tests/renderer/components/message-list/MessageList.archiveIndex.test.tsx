// @vitest-environment jsdom
/**
 * 归档卷索引消息的渲染过滤（Task 4 / R18）
 *
 * 索引消息与记忆消息共用 `sourceKind='memory'`（不新增 sourceKind 类别），
 * 靠 metadata 的 `archiveIndexDigest` 键区分：命中即不渲染气泡、不进"上一条用户消息"导航索引。
 * 两种形态都必须命中（否则重启后索引消息会渲染成用户气泡）：
 * ① 内存态：metadata 子对象；② DB 读回：metadata 展开到顶层。
 * 另锁一条：无 `archiveIndexDigest` 但整段被 <system-reminder> 包裹时，由内容兜底路径处理。
 *
 * mock 模块骨架与 geometry/scroll stub 从 MessageList.languageGuard.test.tsx 原样搬运。
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {render, waitFor, fireEvent, screen} from '@testing-library/react'
import type {ReactElement} from 'react'
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
    useAgentStore: (selector: (s: typeof mockAgentState) => unknown) => selector(mockAgentState),
}))

/** 每条消息行 80px 高、按 data-msg-idx 顺序排列 */
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
    Element.prototype.scrollTo = vi.fn((opts?: ScrollToOptions | number) => {
        if (opts && typeof opts === 'object' && 'top' in opts) mockScrollTop = opts.top ?? 0
    }) as any

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

/** 渲染会话并等待初始化滚动（与 languageGuard 用例同款） */
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
    return {container, rerender: view.rerender}
}

/** 正确五段结构：整段被 <system-reminder> 包裹（内容兜底路径也能命中） */
const INDEX_CONTENT = '<system-reminder>\n# 长期记忆索引（按需读取）\n\n- alpha：测试卷 A\n\n'
    + '任务涉及上述主题时，用 file_read 读取对应卷全文后再动手；清单只是地图，不要凭卷名臆断内容。\n</system-reminder>'

/**
 * R14 风险形态：尾行跑到包裹之外（指引行不在 <system-reminder> 内）。
 * 此时内容兜底路径失效（既不 startsWith+endsWith 同标签），**只有显式谓词**能拦下它
 * —— 本文件的主导性判据由该形态提供。
 */
const INDEX_CONTENT_BROKEN_WRAP = '<system-reminder>\n# 长期记忆索引（按需读取）\n\n- alpha：测试卷 A\n</system-reminder>\n'
    + '任务涉及上述主题时，用 file_read 读取对应卷全文后再动手；清单只是地图，不要凭卷名臆断内容。'

/** 形态①：内存态（metadata 子对象） */
function archiveIndexUser(id: string, content = INDEX_CONTENT_BROKEN_WRAP) {
    return {
        id,
        role: 'user',
        content,
        metadata: {sourceKind: 'memory', archiveIndexDigest: 'digest-1'},
    }
}

/** 形态②：DB 读回（metadata 展开到顶层，无 metadata 子对象） */
function archiveIndexUserFlattened(id: string, content = INDEX_CONTENT_BROKEN_WRAP) {
    return {
        id,
        role: 'user',
        content,
        sourceKind: 'memory',
        archiveIndexDigest: 'digest-1',
    }
}

/** 追加消息并重渲染 */
function pushAndRerender(rerender: (ui: ReactElement) => void, msg: unknown) {
    const prev = mockConversationState.messagesMap['conv-1'] ?? []
    mockConversationState.messagesMap['conv-1'] = [...prev, msg]
    mockConversationState.loadedMessages = mockConversationState.messagesMap['conv-1']
    rerender(<MessageList conversationId="conv-1"/>)
}

describe('MessageList 归档卷索引消息过滤（Task 4 / R18）', () => {
    beforeEach(() => {
        mockConversationState.messagesMap['conv-1'] = [
            {id: 'm0', role: 'user', content: '第一条'},
            {id: 'm1', role: 'assistant', content: '回复'},
        ]
        mockConversationState.loadedMessages = mockConversationState.messagesMap['conv-1']
        mockConversationState.activeConversationId = 'conv-1'
    })

    it('形态①（metadata 子对象，内容未整体包裹）：仅凭谓词即不渲染气泡，且不进用户消息导航', async () => {
        mockConversationState.messagesMap['conv-1'] = [
            {id: 'm0', role: 'user', content: '第一条'},
            archiveIndexUser('m1'),
            {id: 'm2', role: 'assistant', content: '回复'},
        ]
        mockConversationState.loadedMessages = mockConversationState.messagesMap['conv-1']
        const {container} = await renderAndSettle()

        expect(document.querySelectorAll('[data-msg-idx]').length).toBe(2)
        expect(screen.queryByText(/长期记忆索引/)).toBeNull()

        // 上一条用户消息导航必须锚定到 idx=0（索引消息不在索引集内）
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

    it('形态②（DB 读回展开到顶层，内容未整体包裹）：同样不渲染气泡', async () => {
        mockConversationState.messagesMap['conv-1'] = [
            {id: 'm0', role: 'user', content: '第一条'},
            archiveIndexUserFlattened('m1'),
            {id: 'm2', role: 'assistant', content: '回复'},
        ]
        mockConversationState.loadedMessages = mockConversationState.messagesMap['conv-1']
        await renderAndSettle()

        expect(document.querySelectorAll('[data-msg-idx]').length).toBe(2)
        expect(screen.queryByText(/长期记忆索引/)).toBeNull()
    })

    it('无 archiveIndexDigest 但整段被 <system-reminder> 包裹：内容兜底路径同样不渲染', async () => {
        // 模拟同一 content 丢掉 digest 键（例如 metadata 白名单缺失的历史消息）
        const noDigest = {
            id: 'm1',
            role: 'user',
            content: INDEX_CONTENT,
            metadata: {sourceKind: 'memory'},
        }
        mockConversationState.messagesMap['conv-1'] = [
            {id: 'm0', role: 'user', content: '第一条'},
            noDigest,
            {id: 'm2', role: 'assistant', content: '回复'},
        ]
        mockConversationState.loadedMessages = mockConversationState.messagesMap['conv-1']
        await renderAndSettle()

        expect(document.querySelectorAll('[data-msg-idx]').length).toBe(2)
        expect(screen.queryByText(/长期记忆索引/)).toBeNull()
    })

    it('判别力对照：真实用户消息（引用标签但非整段包裹）仍渲染为气泡', async () => {
        mockConversationState.messagesMap['conv-1'] = [
            {id: 'm0', role: 'user', content: '第一条'},
            {id: 'm1', role: 'user', content: '索引消息里 <system-reminder> 包裹的渲染问题怎么定位？'},
        ]
        mockConversationState.loadedMessages = mockConversationState.messagesMap['conv-1']
        await renderAndSettle()

        // 两条真实用户消息都可见（谓词不得过宽）
        expect(document.querySelectorAll('[data-msg-idx]').length).toBe(2)
        expect(screen.queryByText(/包裹的渲染问题怎么定位/)).not.toBeNull()
    })
})
