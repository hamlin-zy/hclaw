// @vitest-environment jsdom
/**
 * useToolCountdown hook 测试
 *
 * 保护：工具卡片倒计时逻辑（括号紧凑格式，紧跟工具名显示如 bash (10s)）
 * - 缺超时信息 → 不显示
 * - 有超时信息 → 按分级显示剩余时间，每秒递减
 * - 剩余 ≤10s → 紧急标记
 * - 超时归零 → 显示"已超时"
 */
import {describe, expect, it, vi, beforeEach, afterEach} from 'vitest'
import {renderHook, act} from '@testing-library/react'
import {useToolCountdown} from '../../../src/renderer/hooks/useToolCountdown'

describe('useToolCountdown', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2024-01-01T00:00:00Z').getTime())
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    it('无超时信息（timeoutMs 缺失）→ null', () => {
        const {result} = renderHook(() => useToolCountdown(undefined, 1000))
        expect(result.current).toBeNull()
    })

    it('无开始时刻（startedAt 缺失）→ null', () => {
        const {result} = renderHook(() => useToolCountdown(60000, undefined))
        expect(result.current).toBeNull()
    })

    it('超时时间非法（<=0）→ null', () => {
        const {result} = renderHook(() => useToolCountdown(0, 1000))
        expect(result.current).toBeNull()
    })

    it('剩余 25 秒 → 显示 "(25s)" 且非紧急', () => {
        const startedAt = Date.now() - 35000 // 60s 超时已过 35s
        const {result} = renderHook(() => useToolCountdown(60000, startedAt))
        expect(result.current).toEqual({label: '(25s)', urgent: false})
    })

    it('剩余 2 分 5 秒 → 分级显示 "(2m5s)"', () => {
        const {result} = renderHook(() => useToolCountdown(125000, Date.now()))
        expect(result.current).toEqual({label: '(2m5s)', urgent: false})
    })

    it('剩余 1 小时以上 → 分级显示 "(1h5m)"', () => {
        const timeoutMs = 3600000 + 5 * 60000 + 3000
        const {result} = renderHook(() => useToolCountdown(timeoutMs, Date.now()))
        expect(result.current).toEqual({label: '(1h5m)', urgent: false})
    })

    it('剩余 ≤10 秒 → 紧急标记', () => {
        const startedAt = Date.now() - 55000 // 60s 超时已过 55s → 剩 5s
        const {result} = renderHook(() => useToolCountdown(60000, startedAt))
        expect(result.current?.urgent).toBe(true)
    })

    it('已超时 → "已超时" 且紧急', () => {
        const startedAt = Date.now() - 70000 // 60s 超时已过 70s
        const {result} = renderHook(() => useToolCountdown(60000, startedAt))
        expect(result.current).toEqual({label: '已超时', urgent: true})
    })

    it('每秒递减：tick 后剩余时间减少 1 秒', () => {
        const startedAt = Date.now() - 30000 // 60s 超时已过 30s → 剩 30s
        const {result} = renderHook(() => useToolCountdown(60000, startedAt))
        expect(result.current?.label).toBe('(30s)')

        act(() => {
            vi.advanceTimersByTime(1000)
        })
        expect(result.current?.label).toBe('(29s)')
    })
})
