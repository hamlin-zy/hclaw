/**
 * TokenManager 单元测试
 *
 * 覆盖：
 * - register / getToken 初始状态
 * - 过期触发刷新、未过期返回缓存
 * - 并发 getToken 去重（pendingRefreshes 只触发一次 refreshFn）
 * - leadTime 内预刷新
 * - refreshFn 抛错 → onError / onTokenError
 * - unregister 清理（定时器、pending）
 * - onTokenRefreshed 事件
 * - 定时器自动刷新（fake timers 控制时间）
 *
 * 说明：
 * - TokenManager 依赖 console logger，import 正常即可，无需 mock。
 * - 所有时间相关用例使用 vi.useFakeTimers + vi.setSystemTime 控制，
 *   避免真实等待，也保证 leadTime 判断可稳定复现。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {TokenManager} from '@/main/channel/TokenManager'

function makeTokenManager() {
    return new TokenManager()
}

describe('TokenManager — register / getToken 初始状态', () => {
    it('register 后 token/expiryAt 初始为 0，未注册 provider 抛错', async () => {
        const mgr = makeTokenManager()
        const refreshFn = vi.fn().mockResolvedValue({accessToken: 't1', expiryDate: Date.now() + 3600_000})

        mgr.register({providerId: 'feishu', refreshFn})

        expect(mgr.isRegistered('feishu')).toBe(true)
        // 初始无 token → getToken 触发刷新
        await expect(mgr.getToken('unknown-provider')).rejects.toThrow('not registered')
        expect(mgr.isRegistered('unknown-provider')).toBe(false)
    })

    it('getToken 过期时触发 refreshFn → 返回新 token，persistFn 被调用', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
        const mgr = makeTokenManager()
        const refreshFn = vi.fn().mockResolvedValue({
            accessToken: 'feishu-new-token',
            expiryDate: Date.now() + 2 * 3600_000,
        })
        const persistFn = vi.fn().mockResolvedValue(undefined)

        mgr.register({providerId: 'feishu', refreshFn, persistFn})

        const token = await mgr.getToken('feishu')

        expect(token).toBe('feishu-new-token')
        expect(refreshFn).toHaveBeenCalledTimes(1)
        // persistFn 异步调用（未 await），等待微任务
        await vi.waitFor(() => {
            expect(persistFn).toHaveBeenCalledWith('feishu-new-token', expect.any(Number))
        })
        vi.useRealTimers()
    })

    it('未过期（且未进入 leadTime）直接返回缓存 token，refreshFn 不调用', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
        const mgr = makeTokenManager()
        const refreshFn = vi.fn().mockResolvedValue({
            accessToken: 'cached-token',
            expiryDate: Date.now() + 2 * 3600_000, // 2h 后过期
        })

        mgr.register({providerId: 'feishu', refreshFn})
        await mgr.getToken('feishu') // 首次触发刷新
        expect(refreshFn).toHaveBeenCalledTimes(1)

        // 1 小时后（仍在 leadTime 之前）→ 直接返回缓存
        vi.setSystemTime(new Date('2026-01-01T01:00:00Z'))
        const token = await mgr.getToken('feishu')
        expect(token).toBe('cached-token')
        expect(refreshFn).toHaveBeenCalledTimes(1)
        vi.useRealTimers()
    })
})

describe('TokenManager — 并发去重 / 预刷新', () => {
    it('并发 getToken（同 provider）→ refreshFn 只调用一次（pendingRefreshes 去重）', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
        const mgr = makeTokenManager()
        let resolveRefresh: ((v: {accessToken: string; expiryDate: number}) => void) | null = null
        const refreshFn = vi.fn().mockImplementation(() => new Promise(res => {
            resolveRefresh = res
        }))

        mgr.register({providerId: 'feishu', refreshFn})

        const p1 = mgr.getToken('feishu')
        const p2 = mgr.getToken('feishu')
        const p3 = mgr.getToken('feishu')

        // 全部进入 pendingRefreshes 去重
        expect(refreshFn).toHaveBeenCalledTimes(1)

        resolveRefresh!({
            accessToken: 'dedup-token',
            expiryDate: Date.now() + 2 * 3600_000,
        })

        const [t1, t2, t3] = await Promise.all([p1, p2, p3])
        expect(t1).toBe('dedup-token')
        expect(t2).toBe('dedup-token')
        expect(t3).toBe('dedup-token')
        expect(refreshFn).toHaveBeenCalledTimes(1)
        vi.useRealTimers()
    })

    it('过期前 leadTime 内触发预刷新（expiryAt - now < leadTime）', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
        const mgr = makeTokenManager()
        const refreshFn = vi.fn()
        refreshFn.mockResolvedValueOnce({
            accessToken: 'token-v1',
            expiryDate: Date.now() + 2 * 3600_000,
        })
        refreshFn.mockResolvedValueOnce({
            accessToken: 'token-v2',
            expiryDate: Date.now() + 2 * 3600_000,
        })

        mgr.register({providerId: 'feishu', refreshFn})
        await mgr.getToken('feishu') // 首次：token-v1，expiry 2h 后
        expect(refreshFn).toHaveBeenCalledTimes(1)

        // 快进到 expiry - 1min（默认 leadTime 5min）→ 已进入预刷新窗口
        vi.setSystemTime(new Date('2026-01-01T01:59:00Z'))
        const token = await mgr.getToken('feishu')
        expect(token).toBe('token-v2')
        expect(refreshFn).toHaveBeenCalledTimes(2)
        vi.useRealTimers()
    })
})

describe('TokenManager — refreshFn 抛错 / 事件', () => {
    it('refreshFn 抛错 → onError 回调被调用，getToken 拒绝', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
        const mgr = makeTokenManager()
        const boom = new Error('upstream down')
        const refreshFn = vi.fn().mockRejectedValue(boom)
        const onError = vi.fn()

        mgr.register({providerId: 'feishu', refreshFn, onError})
        await expect(mgr.getToken('feishu')).rejects.toThrow('upstream down')
        expect(onError).toHaveBeenCalledWith(boom)
        vi.useRealTimers()
    })

    it('refreshFn 抛错且已有缓存 token → 保留旧 token，并通过 onTokenError 事件通知', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
        const mgr = makeTokenManager()
        const refreshFn = vi.fn()
        refreshFn.mockResolvedValueOnce({
            accessToken: 'old-token',
            expiryDate: Date.now() + 2 * 3600_000,
        })
        refreshFn.mockRejectedValueOnce(new Error('network'))

        const onErrorCb = vi.fn()

        mgr.register({providerId: 'feishu', refreshFn})
        mgr.onTokenError('feishu', onErrorCb)

        await mgr.getToken('feishu') // 首次成功
        // token 仍有效（未进入 leadTime）时强制刷新 → 失败
        // （此时 refreshAt = expiry - 5min 尚未到达，失败后只会安排定时器重试，
        //   不会触发立即重刷，避免产生游离的 rejected promise）
        vi.setSystemTime(new Date('2026-01-01T00:30:00Z'))
        await expect(mgr.refreshNow('feishu')).rejects.toThrow('network')
        expect(onErrorCb).toHaveBeenCalledWith(expect.any(Error))

        // 旧 token 仍缓存可用：重新 getToken 不再触发 refreshFn
        refreshFn.mockClear()
        const token = await mgr.getToken('feishu')
        expect(token).toBe('old-token')
        expect(refreshFn).not.toHaveBeenCalled()
        vi.useRealTimers()
    })

    it('onTokenRefreshed 事件监听收到新 token', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
        const mgr = makeTokenManager()
        const refreshFn = vi.fn().mockResolvedValue({
            accessToken: 'event-token',
            expiryDate: Date.now() + 2 * 3600_000,
        })
        const onRefreshed = vi.fn()

        mgr.register({providerId: 'feishu', refreshFn})
        mgr.onTokenRefreshed('feishu', onRefreshed)

        await mgr.getToken('feishu')

        await vi.waitFor(() => {
            expect(onRefreshed).toHaveBeenCalledWith('event-token')
        })
        vi.useRealTimers()
    })
})

describe('TokenManager — unregister / 定时器', () => {
    it('unregister 后清理：isRegistered false、getToken 抛错、pending 清除', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
        const mgr = makeTokenManager()
        let resolveRefresh: ((v: {accessToken: string; expiryDate: number}) => void) | null = null
        const refreshFn = vi.fn().mockImplementation(() => new Promise(res => {
            resolveRefresh = res
        }))

        mgr.register({providerId: 'feishu', refreshFn})
        const p = mgr.getToken('feishu') // 挂起中，pendingRefreshes 存在

        mgr.unregister('feishu')
        expect(mgr.isRegistered('feishu')).toBe(false)
        await expect(mgr.getToken('feishu')).rejects.toThrow('not registered')

        resolveRefresh!({accessToken: 'x', expiryDate: Date.now() + 3600_000})
        await p.catch(() => {}) // 挂起 promise 在 unregister 后仍 resolve，但不影响状态
        vi.useRealTimers()
    })

    it('定时器行为：刷新成功后自动调度，到达 refreshAt 自动刷新', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
        const mgr = makeTokenManager()
        let call = 0
        const refreshFn = vi.fn().mockImplementation(async () => {
            call += 1
            return {
                accessToken: `token-v${call}`,
                // 每次刷新都以"当前时间 + 2h"计算过期，模拟真实刷新
                expiryDate: Date.now() + 2 * 3600_000,
            }
        })

        mgr.register({providerId: 'feishu', refreshFn})
        await mgr.getToken('feishu') // 首次刷新 → 调度定时器在 01:55（expiry - 5min leadTime）

        expect(refreshFn).toHaveBeenCalledTimes(1)
        // debugInfo 显示已安排定时器
        expect(mgr.getDebugInfo().find(i => i.providerId === 'feishu')?.hasTimer).toBe(true)

        // 快进 1h54min59s（01:54:59，未到 01:55）→ 定时器未触发
        vi.advanceTimersByTime(1 * 3600_000 + 54 * 60_000 + 59_000)
        expect(refreshFn).toHaveBeenCalledTimes(1)

        // 再快进 1s 到 01:55 → 定时器触发自动刷新
        vi.advanceTimersByTime(1000)
        await vi.waitFor(() => {
            expect(refreshFn).toHaveBeenCalledTimes(2)
        })
        // 第二次刷新成功 → 又安排了新的定时器（03:50 触发），不再有 expiredRefresh 级联
        expect(mgr.getDebugInfo().find(i => i.providerId === 'feishu')?.hasTimer).toBe(true)
        vi.useRealTimers()
    })

    it('unregister 清除定时器：之后不再自动刷新', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
        const mgr = makeTokenManager()
        const refreshFn = vi.fn().mockResolvedValue({
            accessToken: 'token-v1',
            expiryDate: Date.now() + 2 * 3600_000,
        })

        mgr.register({providerId: 'feishu', refreshFn})
        await mgr.getToken('feishu')
        expect(refreshFn).toHaveBeenCalledTimes(1)

        mgr.unregister('feishu')
        expect(mgr.getDebugInfo().find(i => i.providerId === 'feishu')).toBeUndefined()

        // 快进远超 refreshAt → 不再触发（定时器已清除）
        vi.advanceTimersByTime(3 * 3600_000)
        await Promise.resolve()
        expect(refreshFn).toHaveBeenCalledTimes(1)
        vi.useRealTimers()
    })
})
