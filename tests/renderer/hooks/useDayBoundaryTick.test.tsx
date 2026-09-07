// @vitest-environment jsdom
/**
 * useDayBoundaryTick hook 测试
 *
 * 保护：跨天自动刷新日期分组信号
 * - 午夜定时器触发 → tick 自增
 * - 触发后递归重挂 → 自动对齐下一天午夜
 * - 卸载 → 清理定时器
 * - visibilitychange → 恢复可见时立即刷新并重新对齐
 */
import {describe, expect, it, vi, beforeEach, afterEach} from 'vitest'
import {renderHook, act} from '@testing-library/react'
import {useDayBoundaryTick, msToNextMidnight} from '../../../src/renderer/hooks/useDayBoundaryTick'

describe('msToNextMidnight', () => {
    it('返回距明天 00:00:00 的毫秒数', () => {
        // 2024-01-01 12:00 本地 → 距午夜 12h
        const noon = new Date(2024, 0, 1, 12, 0, 0).getTime()
        expect(msToNextMidnight(noon)).toBe(12 * 3600 * 1000)
    })

    it('跨月边界（1月31日 → 2月1日）', () => {
        const d = new Date(2024, 0, 31, 23, 59, 59).getTime()
        expect(msToNextMidnight(d)).toBe(1000)
    })

    it('跨年边界（12月31日 → 次年1月1日）', () => {
        const d = new Date(2024, 11, 31, 23, 59, 59).getTime()
        expect(msToNextMidnight(d)).toBe(1000)
    })

    it('闰年边界（2月28日 → 2月29日）', () => {
        const d = new Date(2024, 1, 28, 23, 59, 59).getTime()
        expect(msToNextMidnight(d)).toBe(1000)
    })

    it('非闰年（2月28日 → 3月1日，JS setDate 自动进位）', () => {
        const d = new Date(2023, 1, 28, 23, 59, 59).getTime()
        // setDate(29) 在非闰年进位到 3月1日，下一个午夜仍是 1 秒后
        expect(msToNextMidnight(d)).toBe(1000)
    })

    it('午夜整点当天起算（00:00:00 → 距 24h）', () => {
        const d = new Date(2024, 0, 2, 0, 0, 0).getTime()
        expect(msToNextMidnight(d)).toBe(24 * 3600 * 1000)
    })
})

describe('useDayBoundaryTick', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date(2024, 0, 1, 23, 0, 0).getTime()) // 1月1日 23:00
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    it('初始 tick 为 0', () => {
        const {result} = renderHook(() => useDayBoundaryTick())
        expect(result.current).toBe(0)
    })

    it('午夜（+1s 缓冲）触发 tick 自增', () => {
        const {result} = renderHook(() => useDayBoundaryTick())
        // 23:00 → 午夜差 1h，加 1s 缓冲；缓冲前不应触发
        act(() => {
            vi.advanceTimersByTime(msToNextMidnight(Date.now()) + 500)
        })
        expect(result.current).toBe(0)
        act(() => {
            vi.advanceTimersByTime(500)
        })
        expect(result.current).toBe(1)
    })

    it('触发后递归重挂，对齐下一天午夜（覆盖跨天）', () => {
        const {result} = renderHook(() => useDayBoundaryTick())
        // 第一次触发：1月1日23:00 → 1月2日 00:00:01
        act(() => {
            vi.advanceTimersByTime(msToNextMidnight(Date.now()) + 1000)
        })
        expect(result.current).toBe(1)
        // 系统时间随假计时器前进到 1月2日 00:00:01，下一个午夜是 1月3日
        act(() => {
            vi.advanceTimersByTime(msToNextMidnight(Date.now()) + 1000)
        })
        expect(result.current).toBe(2)
    })

    it('visibilitychange：恢复可见时立即刷新并重新对齐午夜', () => {
        const {result} = renderHook(() => useDayBoundaryTick())
        act(() => {
            // 休眠但未到午夜后恢复可见（定时器仍挂着）：visibilitychange 立即 +1
            vi.advanceTimersByTime(msToNextMidnight(Date.now()) - 5000)
            document.dispatchEvent(new Event('visibilitychange'))
        })
        expect(result.current).toBe(1)
        // 恢复后重新对齐：再过完整一个午夜周期应再次 +1
        act(() => {
            vi.advanceTimersByTime(msToNextMidnight(Date.now()) + 1000)
        })
        expect(result.current).toBe(2)
    })

    it('visibilitychange：hidden 分支不触发自增', () => {
        const {result} = renderHook(() => useDayBoundaryTick())
        act(() => {
            Object.defineProperty(document, 'visibilityState', {value: 'hidden', configurable: true})
            document.dispatchEvent(new Event('visibilitychange'))
            Object.defineProperty(document, 'visibilityState', {value: 'visible', configurable: true})
        })
        expect(result.current).toBe(0)
    })

    it('visibilitychange：连续恢复触发多次自增', () => {
        const {result} = renderHook(() => useDayBoundaryTick())
        act(() => {
            document.dispatchEvent(new Event('visibilitychange'))
            document.dispatchEvent(new Event('visibilitychange'))
        })
        expect(result.current).toBe(2)
    })

    it('卸载后清理定时器，不再触发', () => {
        const {result, unmount} = renderHook(() => useDayBoundaryTick())
        unmount()
        act(() => {
            vi.advanceTimersByTime(msToNextMidnight(new Date(2024, 0, 1, 23, 0, 0).getTime()) + 5000)
        })
        expect(result.current).toBe(0)
    })

    it('卸载后移除 visibilitychange 监听器，不再触发', () => {
        const {result, unmount} = renderHook(() => useDayBoundaryTick())
        unmount()
        act(() => {
            document.dispatchEvent(new Event('visibilitychange'))
        })
        expect(result.current).toBe(0)
    })
})
