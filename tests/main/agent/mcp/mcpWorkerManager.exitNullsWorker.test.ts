/**
 * MCPWorkerManager.onWorkerExit 解除实例引用（活性修复 · P2-3）回归面
 *
 * 被锁定的行为：
 *  P2-3a Worker 以非 0 码退出后，5s 重启窗口内 this.worker 必须立即为 null。
 *        否则 restartServer() 会走「worker 非空」分支（postMessage 静默 no-op）却照常
 *        登记 waiter → 调用方白等满 60s 才拿到「重启超时」。
 *  P2-3b 解除引用不得弄坏重启机制：非 0 退出仍必须触发 scheduleRestart
 *        （`!this.restarting` 门保持不变），5s 后确实 spawn，且新实例崩溃后仍能再排期。
 *  P2-3c 仅当退出者正是当前实例时才清引用：handler 携带的实例与当前不一致时不得误清。
 *
 * ⚠️ 严禁真实 taskkill：`execSync` / `isProcessRunning` 均被 mock；
 *    本文件不启动真实 Worker（用 EventEmitter 假 Worker 注入私有字段）。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {EventEmitter} from 'node:events'

const mocks = vi.hoisted(() => ({
    execSync: vi.fn(),
    isProcessRunning: vi.fn((_pid: number) => true),
    logger: {info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn()},
    mcpService: {
        get: vi.fn(() => ({id: 's1', name: 's1', transport: 'stdio'}) as any),
        list: vi.fn(() => [] as any[]),
    },
}))

vi.mock('child_process', async (importOriginal) => ({
    ...(await importOriginal<typeof import('child_process')>()),
    execSync: mocks.execSync,
}))

vi.mock('@/main/agent/mcp/transport/processUtils', () => ({
    isProcessRunning: mocks.isProcessRunning,
    waitForProcessExit: vi.fn(async () => true),
}))

vi.mock('@/main/agent/logger', () => ({logger: mocks.logger}))
vi.mock('@/main/services/mcpService', () => ({mcpService: mocks.mcpService}))

import {MCPWorkerManager} from '@/main/agent/mcp/mcpWorkerManager'

/** 假 Worker：具备监听器语义 + terminate/postMessage 两个被管理器调用的方法 */
class FakeWorker extends EventEmitter {
    postMessage = vi.fn()
    terminate = vi.fn(() => Promise.resolve(0))
}

/** 按 spawn() 的真实形态给假 Worker 挂上具名 handler */
function attachHandlers(m: MCPWorkerManager, w: FakeWorker): void {
    w.on('message', (m as any).onWorkerMessage)
    w.on('error', (m as any).onWorkerError)
    w.on('exit', (m as any).onWorkerExit)
}

beforeEach(() => {
    mocks.execSync.mockClear()
    mocks.logger.warn.mockClear()
    mocks.mcpService.get.mockReset().mockReturnValue({id: 's1', name: 's1', transport: 'stdio'})
})

afterEach(() => {
    vi.useRealTimers()
})

describe('MCPWorkerManager.onWorkerExit（P2-3 解除已死实例引用）', () => {
    it('P2-3a 非 0 退出（5s 窗口内）→ restartServer 立即失败且不登记 waiter', async () => {
        vi.useFakeTimers()
        const m = new MCPWorkerManager()
        const w = new FakeWorker()
        ;(m as any).worker = w
        attachHandlers(m, w)

        // 崩溃：不推进 5s 定时器，模拟「重启窗口内」
        w.emit('exit', 1)

        // 实例引用必须已解除——否则 restartServer 会走「有 worker」分支
        expect((m as any).worker).toBeNull()
        // 重启机制本身仍被排期（5s 后 spawn）
        expect((m as any).restarting).toBe(true)
        expect((m as any).restartTimer).not.toBeNull()

        const result = await m.restartServer('s1')

        expect(result).toEqual({success: false, error: 'MCP Worker 未就绪'})
        // 关键判据：没有登记 waiter → 调用方不会白等满 60s
        expect((m as any).restartWaiters.size).toBe(0)
    })

    it('P2-3b 5s 后 spawn 出的新实例崩溃 → 仍会再次排期重启（回归护栏）', () => {
        vi.useFakeTimers()
        const m = new MCPWorkerManager()
        const spawnSpy = vi.spyOn(m as any, 'spawn').mockImplementation(() => {})

        const w1 = new FakeWorker()
        ;(m as any).worker = w1
        attachHandlers(m, w1)
        w1.emit('exit', 1)

        // 第一轮：非 0 退出 → 排期 → 5s 后 spawn
        vi.advanceTimersByTime(5000)
        expect(spawnSpy).toHaveBeenCalledTimes(1)
        expect((m as any).restarting).toBe(false)

        // spawn 被 spy 掉，手动模拟重启窗口结束后上线的新实例
        const w2 = new FakeWorker()
        ;(m as any).worker = w2
        attachHandlers(m, w2)
        w2.emit('exit', 1)

        // 新实例的崩溃必须同样被接管：清引用 + 再排期
        expect((m as any).worker).toBeNull()
        expect((m as any).restarting).toBe(true)
        expect((m as any).restartTimer).not.toBeNull()

        vi.advanceTimersByTime(5000)
        expect(spawnSpy).toHaveBeenCalledTimes(2)
    })

    it('P2-3c handler 携带的实例不是当前实例 → 不得清掉当前引用', () => {
        vi.useFakeTimers()
        const m = new MCPWorkerManager()
        const live = new FakeWorker()
        const stale = new FakeWorker()
        ;(m as any).worker = live

        // 旧实例（已脱离管理）的退出不得误清新实例引用
        ;(m as any).onWorkerExit(1, stale)
        expect((m as any).worker).toBe(live)

        // 当前实例自身的退出才解除引用
        ;(m as any).onWorkerExit(1, live)
        expect((m as any).worker).toBeNull()
        // 清理排期定时器，避免用例间串扰
        clearTimeout((m as any).restartTimer)
    })

    it('P2-3d 正常退出（code 0）解除引用但不排期重启', () => {
        vi.useFakeTimers()
        const m = new MCPWorkerManager()
        const w = new FakeWorker()
        ;(m as any).worker = w
        attachHandlers(m, w)

        w.emit('exit', 0)

        expect((m as any).worker).toBeNull()
        expect((m as any).restartTimer).toBeNull()
        expect((m as any).restarting).toBe(false)
    })

    it('P2-3e shutdown 期间退出仍不排期重启（既有语义不变）', () => {
        vi.useFakeTimers()
        const m = new MCPWorkerManager()
        const w = new FakeWorker()
        ;(m as any).worker = w
        attachHandlers(m, w)
        ;(m as any).shuttingDown = true

        w.emit('exit', 1)

        expect((m as any).restartTimer).toBeNull()
        expect((m as any).restarting).toBe(false)
    })
})
