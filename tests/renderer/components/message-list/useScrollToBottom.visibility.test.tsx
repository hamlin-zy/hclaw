// @vitest-environment jsdom
/**
 * useScrollToBottom 窗口恢复可见延迟滚动测试（Task 7）
 *
 * 行为契约：visibilityState 变 visible 且已初始化（hasInitializedRef=true）时，
 * 延迟 100ms 后 doScrollToBottom(true)（先呈现首帧，避免恢复瞬间大 DOM 同步布局）。
 *
 * 初始化路径（hook 内部）：
 *   messageCount>0 → 600ms SETTLE_TIMEOUT → requestAnimationFrame
 *   → doScrollToBottom(true) + hasInitializedRef.current = true
 * 通过真实初始化驱动 hasInitializedRef（外部无法直接访问内部 ref）。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {renderHook, act} from '@testing-library/react'
import type {RefObject} from 'react'
import {useScrollToBottom} from '../../../../src/renderer/components/message-list/useScrollToBottom'

// jsdom 无 IntersectionObserver / MutationObserver，用 no-op polyfill
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

let scrollEl: HTMLDivElement
let bottomEl: HTMLDivElement
let scrollRef: RefObject<HTMLDivElement>
let bottomRef: RefObject<HTMLDivElement>
let scrollIntoViewMock: ReturnType<typeof vi.fn>

const renderHookWith = (messageCount: number) =>
    renderHook(() =>
        useScrollToBottom({
            scrollRef,
            bottomRef,
            messageCount,
            streamingMessageId: null,
            streamBufferLength: 0,
            agentStatus: 'idle',
            isThinkingAfterTools: false,
            runningToolCount: 0,
            activeConversationId: null,
        })
    )

// 驱动真实初始化：messageCount>0 → 600ms settle → rAF → hasInitializedRef=true
// 完成后清空初始化产生的 scrollIntoView 调用，避免干扰后续断言
const driveInitialization = () => {
    act(() => {
        vi.advanceTimersByTime(700)
    })
    scrollIntoViewMock.mockClear()
}

const setVisibility = (state: 'visible' | 'hidden') => {
    Object.defineProperty(document, 'visibilityState', {value: state, configurable: true})
    document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
    vi.stubGlobal('MutationObserver', MockMutationObserver)

    scrollEl = document.createElement('div')
    bottomEl = document.createElement('div')
    scrollRef = {current: scrollEl}
    bottomRef = {current: bottomEl}

    // jsdom 未实现 Element.prototype.scrollIntoView
    scrollIntoViewMock = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoViewMock

    Object.defineProperty(document, 'visibilityState', {value: 'visible', configurable: true})
})

afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    // 移除实例级 visibilityState 覆盖，恢复 jsdom 原型 getter
    delete (document as Document & {visibilityState?: string}).visibilityState
})

describe('useScrollToBottom 窗口恢复可见延迟滚动（Task 7）', () => {
    it('已初始化：visible → 100ms 内不滚动，满 100ms 恰好滚动一次（instant）', () => {
        renderHookWith(1)
        driveInitialization()

        act(() => {
            setVisibility('visible')
        })
        // 100ms 内：先呈现首帧，不滚动
        expect(scrollIntoViewMock).not.toHaveBeenCalled()
        act(() => {
            vi.advanceTimersByTime(99)
        })
        expect(scrollIntoViewMock).not.toHaveBeenCalled()

        // 满 100ms：延迟滚动一次（instant）
        act(() => {
            vi.advanceTimersByTime(1)
        })
        expect(scrollIntoViewMock).toHaveBeenCalledTimes(1)
        expect(scrollIntoViewMock).toHaveBeenCalledWith({behavior: 'instant', block: 'end'})
    })

    it('未初始化（hasInitializedRef=false）：visible 后也不滚动', () => {
        renderHookWith(0)

        act(() => {
            setVisibility('visible')
        })
        act(() => {
            vi.advanceTimersByTime(200)
        })
        expect(scrollIntoViewMock).not.toHaveBeenCalled()
    })

    it('已初始化但 visibilityState=hidden：不滚动', () => {
        renderHookWith(1)
        driveInitialization()

        act(() => {
            setVisibility('hidden')
        })
        act(() => {
            vi.advanceTimersByTime(200)
        })
        expect(scrollIntoViewMock).not.toHaveBeenCalled()
    })

    it('unmount 后移除监听：再切 visible 不滚动', () => {
        const {unmount} = renderHookWith(1)
        driveInitialization()

        unmount()
        act(() => {
            setVisibility('visible')
        })
        act(() => {
            vi.advanceTimersByTime(200)
        })
        expect(scrollIntoViewMock).not.toHaveBeenCalled()
    })
})
