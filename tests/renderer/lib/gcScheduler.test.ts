import {describe, expect, it, vi, beforeEach} from 'vitest'
import {createGcScheduler, MIN_GC_INTERVAL_MS, POST_VISIBLE_GRACE_MS} from '@/renderer/lib/gcScheduler'

interface Harness {
    hidden: boolean
    clock: number
    gcCalls: number
    idleCalls: Array<{didTimeout: boolean}>
    visibleCbs: Array<() => void>
    tryGc: () => void
    runIdle: (didTimeout?: boolean) => void
    notifyVisible: () => void
}

function makeHarness(): Harness {
    const h: Harness = {
        hidden: false,
        clock: 0,
        gcCalls: 0,
        idleCalls: [],
        visibleCbs: [],
        tryGc: () => {},
        runIdle: () => {},
        notifyVisible: () => {},
    }
    h.tryGc = createGcScheduler({
        isHidden: () => h.hidden,
        now: () => h.clock,
        requestIdle: (cb, _timeout) => {
            h.idleCalls.push({didTimeout: false})
            // 记录回调供测试手动触发（模拟 requestIdleCallback 在空闲时执行）
            h.runIdle = (didTimeout = false) => {
                cb(didTimeout)
            }
            return true
        },
        runGc: () => { h.gcCalls++ },
        onVisible: (cb) => { h.visibleCbs.push(cb); return () => {} },
        scheduleInterval: () => {},
        scheduleTimeout: () => {},
    }).tryGc
    h.notifyVisible = () => {
        for (const cb of h.visibleCbs) cb()
    }
    return h
}

describe('createGcScheduler — 手动 GC 门控', () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })

    it('首次触发（已过最小间隔 + 可见 + 无恢复宽限）时执行 GC', () => {
        const h = makeHarness()
        h.clock = 100000 // 远超初始 lastVisibleAt=0，满足宽限期
        h.tryGc()
        expect(h.idleCalls.length).toBe(1)
        h.runIdle(false)
        expect(h.gcCalls).toBe(1)
    })

    it('hidden 期间不调度 GC（最小化时禁止手动 GC）', () => {
        const h = makeHarness()
        h.hidden = true
        h.clock = 100000
        h.tryGc()
        expect(h.idleCalls.length).toBe(0)
        expect(h.gcCalls).toBe(0)
    })

    it('恢复宽限期（POST_VISIBLE_GRACE_MS）内不调度 GC', () => {
        const h = makeHarness()
        // 让 lastGc 足够久远（满足最小间隔）：先正常 GC 一次
        h.clock = 100000
        h.tryGc()
        h.runIdle(false)
        expect(h.gcCalls).toBe(1)
        // 模拟窗口恢复：visible 事件刷新 lastVisibleAt
        h.notifyVisible() // lastVisibleAt = 100000
        // 恢复后 50s（>45s 最小间隔，<60s 宽限期）→ 仍被宽限期拦截
        h.clock += 50000
        h.tryGc()
        expect(h.idleCalls.length).toBe(1) // 无新增调度
        expect(h.gcCalls).toBe(1)
    })

    it('恢复宽限期过后重新允许 GC', () => {
        const h = makeHarness()
        h.clock = 100000
        h.notifyVisible() // lastVisibleAt = 100000
        h.clock += POST_VISIBLE_GRACE_MS + 1 // 超过宽限期
        h.tryGc()
        expect(h.idleCalls.length).toBe(1)
        h.runIdle(false)
        expect(h.gcCalls).toBe(1)
    })

    it('最小间隔（MIN_GC_INTERVAL_MS）内不重复 GC（节流）', () => {
        const h = makeHarness()
        h.clock = 100000
        h.tryGc()
        h.runIdle(false)
        expect(h.gcCalls).toBe(1)
        // 过 44s（< 45s）再试 → 不触发
        h.clock += MIN_GC_INTERVAL_MS - 1000
        h.tryGc()
        expect(h.idleCalls.length).toBe(1)
        // 过 46s → 触发
        h.clock += 2000
        h.tryGc()
        expect(h.idleCalls.length).toBe(2)
        h.runIdle(false)
        expect(h.gcCalls).toBe(2)
    })

    it('requestIdleCallback 超时（didTimeout）不执行 GC', () => {
        const h = makeHarness()
        h.clock = 100000
        h.tryGc()
        h.runIdle(true)
        expect(h.gcCalls).toBe(0)
    })
})
