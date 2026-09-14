// @vitest-environment jsdom
/**
 * useCapabilityRefresh 测试
 *
 * 覆盖：挂载即 refetch（防订阅前漏事件）、capability:changed 事件触发重取、
 * 卸载后不再触发且解除订阅、deps 变化重订阅、electronAPI 缺失不崩。
 */
import {describe, it, expect, vi, afterEach} from 'vitest'
import {renderHook, cleanup} from '@testing-library/react'
import {useCapabilityRefresh} from '@/renderer/hooks/useCapabilityRefresh'

type Handler = (data: {seq: number}) => void

/** 最小 electronAPI.capability 替身：记录订阅者并可手动派发 */
function stubCapabilityApi() {
    const handlers = new Set<Handler>()
    const unsubscribe = vi.fn((cb: Handler) => handlers.delete(cb))
    const onCapabilityChanged = vi.fn((cb: Handler) => {
        handlers.add(cb)
        return () => unsubscribe(cb)
    })
    vi.stubGlobal('electronAPI', {capability: {onCapabilityChanged}})

    return {
        onCapabilityChanged,
        unsubscribe,
        emit: (seq = 1) => handlers.forEach((h) => h({seq})),
        listenerCount: () => handlers.size,
    }
}

afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe('useCapabilityRefresh', () => {
    it('挂载即 refetch，并订阅 capability 变更事件', () => {
        const api = stubCapabilityApi()
        const refetch = vi.fn()

        renderHook(() => useCapabilityRefresh(refetch, []))

        expect(refetch).toHaveBeenCalledTimes(1)
        expect(api.onCapabilityChanged).toHaveBeenCalledTimes(1)
        expect(api.listenerCount()).toBe(1)
    })

    it('事件触发时重新 refetch', () => {
        const api = stubCapabilityApi()
        const refetch = vi.fn()

        renderHook(() => useCapabilityRefresh(refetch, []))
        api.emit()
        api.emit()

        expect(refetch).toHaveBeenCalledTimes(3)
    })

    it('卸载后解除订阅，事件不再触发 refetch', () => {
        const api = stubCapabilityApi()
        const refetch = vi.fn()

        const {unmount} = renderHook(() => useCapabilityRefresh(refetch, []))
        unmount()

        expect(api.unsubscribe).toHaveBeenCalledTimes(1)
        expect(api.listenerCount()).toBe(0)

        api.emit()
        expect(refetch).toHaveBeenCalledTimes(1)
    })

    it('deps 变化时重新 refetch 并重订阅', () => {
        const api = stubCapabilityApi()
        const refetch = vi.fn()

        const {rerender} = renderHook(({deps}) => useCapabilityRefresh(refetch, deps), {
            initialProps: {deps: [1] as unknown[]},
        })
        rerender({deps: [2]})

        expect(refetch).toHaveBeenCalledTimes(2)
        expect(api.onCapabilityChanged).toHaveBeenCalledTimes(2)
        expect(api.unsubscribe).toHaveBeenCalledTimes(1)
        expect(api.listenerCount()).toBe(1)
    })

    it('refetch 更新为异步函数时仍被正确调用', async () => {
        stubCapabilityApi()
        const refetch = vi.fn(async () => {})

        renderHook(() => useCapabilityRefresh(refetch, []))

        expect(refetch).toHaveBeenCalledTimes(1)
    })

    it('electronAPI 缺失时不抛错（仍执行首次 refetch）', () => {
        const refetch = vi.fn()

        expect(() => renderHook(() => useCapabilityRefresh(refetch, []))).not.toThrow()
        expect(refetch).toHaveBeenCalledTimes(1)
    })
})
