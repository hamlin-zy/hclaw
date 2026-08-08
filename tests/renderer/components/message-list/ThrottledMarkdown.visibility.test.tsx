// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {act, render, screen} from '@testing-library/react'
import {ThrottledMarkdown} from '../../../../src/renderer/components/message-list/InterleavedContent'

// ── 依赖 mock：静态 store（selector 每次返回同一引用） ──
// ThrottledMarkdown 内部读取 activeConversationId 与 agentState/convAgentStates
// 的 status：activeConversationId=null 时走全局 agentState.status → 'running' ⇒ isStreaming=true
const {mockConversationState, mockAgentState} = vi.hoisted(() => ({
    mockConversationState: {
        activeConversationId: null,
    },
    mockAgentState: {
        agentState: {status: 'running'},
        convAgentStates: {},
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

vi.mock('../../../../src/renderer/stores/themeStore', () => ({
    useThemeStore: (selector: (s: {theme: string}) => unknown) => selector({theme: 'dark'}),
}))

// 用 <div data-testid="md">{children}</div> 替换真实 MarkdownRenderer，
// 避免 react-markdown / Prism 真实解析（本测试只关心 displayContent 的提交时机）
vi.mock('../../../../src/renderer/components/message-list/MarkdownRenderer', () => ({
    default: ({children}: {children: string}) => <div data-testid="md">{children}</div>,
}))

// ── 可控 rAF mock ──
// 不能像 MessageList 测试那样「立即执行回调」：ThrottledMarkdown 的 tick 会重新调度
// requestAnimationFrame，立即执行会无限递归。这里用队列 + 真实 cancel（从队列移除），
// 由测试显式 flush。cancel 生效是「hidden 冻结」的关键：旧实现 hidden 时 rAF 未取消，
// flush 仍会提交 → RED；新实现 hidden 时 cancelAnimationFrame 移除待执行回调 → 冻结。
let rafCallbacks: Map<number, FrameRequestCallback> = new Map()
let rafId = 0

const flushRaf = () => {
    const pending = [...rafCallbacks.entries()]
    rafCallbacks.clear()
    for (const [, cb] of pending) cb(0)
}

const setVisibility = (state: 'visible' | 'hidden') => {
    // visibilityState 与 hidden 同步定义：vitest 的 jsdom 中两者不联动，
    // 而组件源码同时读取 document.visibilityState（visibilitychange 分支）与
    // document.hidden（effect 启动守卫），需保证测试环境语义一致。
    Object.defineProperty(document, 'visibilityState', {value: state, configurable: true})
    Object.defineProperty(document, 'hidden', {value: state === 'hidden', configurable: true})
    document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
    rafCallbacks = new Map()
    rafId = 0
    mockAgentState.agentState = {status: 'running'}
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
        const id = ++rafId
        rafCallbacks.set(id, cb)
        return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
        rafCallbacks.delete(id)
    })
    // 默认从可见状态开始
    Object.defineProperty(document, 'visibilityState', {value: 'visible', configurable: true})
    Object.defineProperty(document, 'hidden', {value: false, configurable: true})
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('ThrottledMarkdown 隐藏冻结（Task 5）', () => {
    it('isStreaming=true：hidden 冻结（rAF 不提交），visible 合并渲染最新一次', () => {
        const {rerender} = render(<ThrottledMarkdown content="A" isUser={false} theme="dark"/>)

        // 1. 初始 visible + 流式中：渲染后 DOM 含 content A
        act(() => { flushRaf() })
        expect(screen.getByTestId('md').textContent).toBe('A')

        // 2. 切 hidden：更新 content → B，且 rAF 不再提交 → DOM 仍为 A（冻结）
        act(() => { setVisibility('hidden') })
        rerender(<ThrottledMarkdown content="B" isUser={false} theme="dark"/>)
        act(() => { flushRaf() })
        expect(screen.getByTestId('md').textContent).toBe('A')

        // 3. 切 visible：只渲染最新一次（B），不渲染中间态
        act(() => { setVisibility('visible') })
        act(() => { flushRaf() })
        expect(screen.getByTestId('md').textContent).toBe('B')
    })

    it('hidden 期间多次更新 content，visible 后只合并到最新一次', () => {
        const {rerender} = render(<ThrottledMarkdown content="A" isUser={false} theme="dark"/>)
        act(() => { flushRaf() })
        expect(screen.getByTestId('md').textContent).toBe('A')

        act(() => { setVisibility('hidden') })
        rerender(<ThrottledMarkdown content="B" isUser={false} theme="dark"/>)
        rerender(<ThrottledMarkdown content="C" isUser={false} theme="dark"/>)
        act(() => { flushRaf() })
        expect(screen.getByTestId('md').textContent).toBe('A')

        act(() => { setVisibility('visible') })
        act(() => { flushRaf() })
        expect(screen.getByTestId('md').textContent).toBe('C')
    })

    it('hidden 中 isStreaming false→true 翻转不重启 rAF（防隐藏期间积压解析）', () => {
        const {rerender} = render(<ThrottledMarkdown content="A" isUser={false} theme="dark"/>)

        // 1. 初始 visible + 流式中：渲染后 DOM 含 content A
        act(() => { flushRaf() })
        expect(screen.getByTestId('md').textContent).toBe('A')

        // 2. 切 hidden：rAF 被取消
        act(() => { setVisibility('hidden') })
        expect(rafCallbacks.size).toBe(0)

        // 3. hidden 中 isStreaming 翻转 false → true（自动续跑/新任务重建 effect）：
        //    ★ 核心：翻转期间不得调度新 rAF（旧实现无条件 requestAnimationFrame →
        //       hidden 期间 1Hz 持续解析 markdown 积压）
        const rafCallsBefore = rafId
        act(() => {
            mockAgentState.agentState = {status: 'idle'} // isStreaming=false
            rerender(<ThrottledMarkdown content="A" isUser={false} theme="dark"/>)
        })
        act(() => {
            mockAgentState.agentState = {status: 'running'} // isStreaming=true（翻转）
            rerender(<ThrottledMarkdown content="A" isUser={false} theme="dark"/>)
        })
        expect(rafId).toBe(rafCallsBefore)

        // 4. hidden 期间 content 更新 → rAF 未重启 → DOM 冻结为 A
        act(() => {
            rerender(<ThrottledMarkdown content="B" isUser={false} theme="dark"/>)
            flushRaf()
        })
        expect(screen.getByTestId('md').textContent).toBe('A')

        // 5. 切 visible：由 visibilitychange 监听接管 → 同步最新并重启 rAF → 渲染 B
        act(() => { setVisibility('visible') })
        act(() => { flushRaf() })
        expect(screen.getByTestId('md').textContent).toBe('B')
    })
})
