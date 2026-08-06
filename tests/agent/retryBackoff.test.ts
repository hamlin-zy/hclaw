import {describe, it, expect, vi} from 'vitest'
import {retryBackoff} from '../../src/main/agent/loop/execute'

// vitest 假定时器，避免真实等待 5 秒
describe('retryBackoff', () => {
    const error = new Error('connection refused')

    it('先发 1 次 warning，再每秒发 retryCountdown 递减事件', async () => {
        vi.useFakeTimers()
        const gen = retryBackoff(1, 10, error, 3000, undefined)
        const events: any[] = []
        const pump = async () => {
            for (;;) {
                const {done, value} = await gen.next()
                if (done) break
                events.push(value)
            }
        }
        const pumping = pump()
        // 等 3 秒（3 个 1 秒 tick）
        for (let i = 0; i < 3; i++) {
            await vi.advanceTimersByTimeAsync(1000)
            await Promise.resolve()
        }
        await pumping
        vi.useRealTimers()

        expect(events[0]).toEqual({type: 'warning', message: 'retry 1/10：connection refused'})
        const countdowns = events.filter(e => e.type === 'tool_progress')
        expect(countdowns.length).toBe(3)
        expect(countdowns.map(e => e.retryCountdown)).toEqual([3, 2, 1])
        expect(countdowns[0].progress).toContain('3s')
    })

    it('abort 后立即停止，不再发倒计时', async () => {
        vi.useFakeTimers()
        const ac = new AbortController()
        const gen = retryBackoff(2, 10, error, 5000, ac.signal)
        const events: any[] = []
        const pump = async () => {
            for (;;) {
                const {done, value} = await gen.next()
                if (done) break
                events.push(value)
            }
        }
        const pumping = pump()
        // 第一个 1 秒 tick 完成前中止（500ms < 1000ms），确保 abort 时已发 1 次倒计时
        await vi.advanceTimersByTimeAsync(500)
        await Promise.resolve()
        ac.abort()
        await vi.advanceTimersByTimeAsync(5000)
        await Promise.resolve()
        await pumping
        vi.useRealTimers()

        expect(events.filter(e => e.type === 'tool_progress').length).toBe(1)
    })

    it('无 abortSignal 参数时兼容（undefined）', async () => {
        vi.useFakeTimers()
        const gen = retryBackoff(1, 10, error, 1000, undefined)
        const events: any[] = []
        const pump = async () => {
            for (;;) {
                const {done, value} = await gen.next()
                if (done) break
                events.push(value)
            }
        }
        const pumping = pump()
        await vi.advanceTimersByTimeAsync(1000)
        await Promise.resolve()
        await pumping
        vi.useRealTimers()
        expect(events.length).toBe(2) // 1 warning + 1 countdown
    })
})
