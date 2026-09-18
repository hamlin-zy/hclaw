/**
 * ChannelManager.pendingAskUser —— 挂起项结算路径（内存泄漏 B 批 S4）
 *
 * 背景：pendingAskUser 键为 conversationId，原先只有 set、无任何 delete/resolve
 * → 条目随渠道会话数无界累积，且被覆盖的旧 Promise 永挂起（渠道会话从此卡死）。
 * 结算语义 = 「取消态」，值为空串 ''：与既有先例一致（promptUserInChannel 登记的
 * reject: () => resolve('')、worker.ts 的 shutdown 清空 askUserRequests 用 resolve('')）。
 *
 * 覆盖路径：① 同键再次登记 → 先结算旧项再 set 新项；② settleAskUser 幂等；
 * ③ shutdown() 遍历结算所有挂起项并清空。
 */
// @vitest-environment node
import {describe, expect, it, vi, beforeEach, afterEach} from 'vitest'

// 隔离渠道 worker / DB / agent manager 等重副作用，只测挂起项状态机
vi.mock('@/main/channel/messageHandler', () => ({handleIncomingMessage: vi.fn()}))
vi.mock('@/main/channel/ChannelRepository', () => ({
    channelRepo: {get: vi.fn(), list: vi.fn(() => []), upsert: vi.fn(), getBinding: vi.fn()},
}))
vi.mock('@/main/repositories', () => ({
    createConversationRepository: () => ({updateMeta: vi.fn(), readMeta: vi.fn(() => null)}),
}))
vi.mock('@/main/repositories/sqlite/systemSettingsRepository', () => ({
    systemSettingsRepo: {get: vi.fn(), getJson: vi.fn(() => null), set: vi.fn(), delete: vi.fn()},
}))
vi.mock('@/main/agent/manager', () => ({agentManager: {addStreamListener: vi.fn(), start: vi.fn()}}))
vi.mock('@/main/agent/logger', () => ({logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}}))
vi.mock('@/main/window', () => ({getMainWindow: vi.fn(() => null)}))

import {ChannelManager} from '@/main/channel/ChannelManager'

/** 直接向挂起表登记一项（返回其 resolve spy，便于断言"是否被结算"） */
function seedPending(mgr: ChannelManager, convId: string): ReturnType<typeof vi.fn> {
    const resolve = vi.fn()
    ;(mgr as any).pendingAskUser.set(convId, {
        resolve,
        reject: () => resolve(''),
        question: 'q',
        timestamp: Date.now(),
    })
    return resolve
}

function pendingOf(mgr: ChannelManager): Map<string, unknown> {
    return (mgr as any).pendingAskUser
}

/** promptUserInChannel 是 async 方法，返回值的 then 回调需多轮微任务才落地 */
async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 10; i++) await Promise.resolve()
}

let mgr: ChannelManager

beforeEach(() => {
    mgr = new ChannelManager()
})

afterEach(() => {
    vi.useRealTimers()
})

describe('promptUserInChannel 同键覆盖', () => {
    it('再次登记同键：旧 Promise 被结算（取消态空串），不悬挂', async () => {
        // worker 未初始化：sendViaWorker 立即返回，不产生额外副作用/定时器
        const p1 = (mgr as any).promptUserInChannel('ch-1', 'u-1', 'q1', 'conv-overwrite')
        let settled: string | undefined
        p1.then((v: string) => { settled = v })

        const p2 = (mgr as any).promptUserInChannel('ch-1', 'u-1', 'q2', 'conv-overwrite')
        await flushMicrotasks() // 让 p1 的 then 回调跑完

        expect(settled).toBe('')                       // 旧项已结算，不再永挂起
        expect(pendingOf(mgr).size).toBe(1)            // 表中只剩新项

        // 收尾：结算新项，避免遗留挂起 Promise
        ;(mgr as any).settleAskUser('conv-overwrite')
        await expect(p2).resolves.toBe('')
        expect(pendingOf(mgr).size).toBe(0)
    })
})

describe('settleAskUser', () => {
    it('结算并移除挂起项，取消态值为空串', () => {
        const resolve = seedPending(mgr, 'conv-settle')
        ;(mgr as any).settleAskUser('conv-settle')
        expect(resolve).toHaveBeenCalledTimes(1)
        expect(resolve).toHaveBeenCalledWith('')
        expect(pendingOf(mgr).size).toBe(0)
    })

    it('幂等：二次调用 no-op（不重复 resolve，也不抛错）', () => {
        const resolve = seedPending(mgr, 'conv-idem')
        ;(mgr as any).settleAskUser('conv-idem')
        ;(mgr as any).settleAskUser('conv-idem')
        expect(resolve).toHaveBeenCalledTimes(1)
        expect(pendingOf(mgr).size).toBe(0)
    })

    it('无挂起项时 no-op（不抛错）', () => {
        expect(() => (mgr as any).settleAskUser('conv-none')).not.toThrow()
    })

    it('只结算目标会话：其它会话的挂起项保持挂起', () => {
        const keep = seedPending(mgr, 'conv-keep')
        const drop = seedPending(mgr, 'conv-drop')
        ;(mgr as any).settleAskUser('conv-drop')
        expect(drop).toHaveBeenCalledTimes(1)
        expect(keep).not.toHaveBeenCalled()
        expect(pendingOf(mgr).size).toBe(1)
    })

    it('先 delete 再 resolve：resolve 回调中重入登记同键，新项不被误删', () => {
        const resolve = vi.fn(() => {
            seedPending(mgr, 'conv-reenter') // 重入：登记同键新项
        })
        ;(mgr as any).pendingAskUser.set('conv-reenter', {resolve, reject: vi.fn(), question: 'q', timestamp: Date.now()})
        ;(mgr as any).settleAskUser('conv-reenter')
        expect(resolve).toHaveBeenCalledTimes(1)
        expect(pendingOf(mgr).size).toBe(1) // 重入登记的新项存活
    })
})

describe('shutdown 清空挂起项', () => {
    it('遍历结算所有挂起项并清空（取消语义），且不残留定时器', () => {
        vi.useFakeTimers()
        const r1 = seedPending(mgr, 'conv-sd-1')
        const r2 = seedPending(mgr, 'conv-sd-2')

        mgr.shutdown()

        expect(r1).toHaveBeenCalledWith('')
        expect(r2).toHaveBeenCalledWith('')
        expect(pendingOf(mgr).size).toBe(0)

        // 收尾：跑完 shutdown 的 1s 强制终止定时器，避免遗留句柄
        vi.advanceTimersByTime(1000)
    })

    it('幂等：重复 shutdown 不重复结算已清空的挂起项', () => {
        vi.useFakeTimers()
        const r1 = seedPending(mgr, 'conv-sd-3')
        mgr.shutdown()
        mgr.shutdown()
        expect(r1).toHaveBeenCalledTimes(1)
        vi.advanceTimersByTime(1000)
    })
})
