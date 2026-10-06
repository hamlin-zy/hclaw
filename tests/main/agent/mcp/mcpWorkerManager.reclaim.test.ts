/**
 * MCPWorkerManager 回收 / 活性修复回归面（本轮 D1 · D2 · 活性 A · 活性 B）
 *
 * 被锁定的行为：
 *  D1  reclaimCurrentWorker() 必须精确摘除 message / exit 监听器，同时**保留 error 兜底**：
 *      terminate() 是异步的，摘净监听器到线程真正结束之间存在窗口，旧 Worker 此刻
 *      emit('error') 会让无监听器的 EventEmitter 直接 throw 未捕获异常。
 *  D2  reclaimCurrentWorker() 必须清掉挂起的崩溃重启定时器（否则回收后 5s 白建一个 Worker）。
 *  活性 A  worker 为空时 restartServer() 立即失败，不得登记 waiter 让调用方白等满 60s。
 *  活性 B  shutdown() 的强制 terminate() 必须吞掉 rejection，不得成为未处理拒绝。
 *
 * ⚠️ 严禁真实 taskkill：`child_process.execSync` 与 `isProcessRunning` 均被 mock；
 *    本文件全部用例都不走真实 Worker（用 EventEmitter 假 Worker 注入私有字段）。
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

// 保留 child_process 的其余导出，仅拦截会真实杀进程的 execSync
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
    mocks.logger.error.mockClear()
    mocks.mcpService.get.mockReset().mockReturnValue({id: 's1', name: 's1', transport: 'stdio'})
})

afterEach(() => {
    vi.useRealTimers()
})

describe('MCPWorkerManager.reclaimCurrentWorker（D1 精确摘监听器）', () => {
    it('摘除 message / exit，但保留 error 兜底（emit("error") 不 throw）', () => {
        const m = new MCPWorkerManager()
        const w = new FakeWorker()
        ;(m as any).worker = w
        attachHandlers(m, w)
        expect(w.listenerCount('message')).toBe(1)
        expect(w.listenerCount('exit')).toBe(1)
        expect(w.listenerCount('error')).toBe(1)

        ;(m as any).reclaimCurrentWorker()

        // message 必须摘掉：旧 Worker 残留的 status_batch / pid_info 不得打进新实例状态
        expect(w.listenerCount('message')).toBe(0)
        // exit 必须摘掉：terminate 的非 0 退出不得触发 scheduleRestart
        expect(w.listenerCount('exit')).toBe(0)
        // error 必须仍有监听器（空兜底），否则终止窗口内 emit('error') 会 throw
        expect(w.listenerCount('error')).toBeGreaterThan(0)
        expect(() => w.emit('error', new Error('terminate-window'))).not.toThrow()

        // 线程确实被终止、管理器已放手
        expect(w.terminate).toHaveBeenCalledTimes(1)
        expect((m as any).worker).toBeNull()
    })

    it('摘除 exit 后，旧 Worker 的非 0 退出不再排期重启', () => {
        const m = new MCPWorkerManager()
        const w = new FakeWorker()
        ;(m as any).worker = w
        attachHandlers(m, w)

        ;(m as any).reclaimCurrentWorker()
        w.emit('exit', 1)

        expect((m as any).restartTimer).toBeNull()
        expect((m as any).restarting).toBe(false)
    })

    it('terminate() 的 rejection 被吞掉并记录日志（不留未处理拒绝）', async () => {
        const m = new MCPWorkerManager()
        const w = new FakeWorker()
        w.terminate = vi.fn(() => Promise.reject(new Error('already gone')))
        ;(m as any).worker = w
        attachHandlers(m, w)

        ;(m as any).reclaimCurrentWorker()
        await Promise.resolve()

        expect(mocks.logger.warn).toHaveBeenCalled()
    })
})

describe('MCPWorkerManager.reclaimCurrentWorker（D2 清理排期重启）', () => {
    it('restartTimer 挂起时回收 → 定时器清除、restarting=false，且到时不再 spawn', () => {
        vi.useFakeTimers()
        const m = new MCPWorkerManager()
        const spawnSpy = vi.spyOn(m as any, 'spawn').mockImplementation(() => {})
        ;(m as any).restarting = true
        ;(m as any).restartTimer = setTimeout(() => {
            (m as any).restartTimer = null
            ;(m as any).spawn()
            ;(m as any).restarting = false
        }, 5000)

        ;(m as any).reclaimCurrentWorker()

        expect((m as any).restartTimer).toBeNull()
        expect((m as any).restarting).toBe(false)

        vi.advanceTimersByTime(6000)
        expect(spawnSpy).not.toHaveBeenCalled()
    })

    it('restartTimer 为 null 但 restarting 仍为 true（timer 回调中途抛错的残留态）→ 回收后 restarting 必被复位', () => {
        const m = new MCPWorkerManager()
        // 复现 scheduleRestart timer 回调里 collectConfigs()/spawn() 抛错的残留态：
        // 回调首行已把 restartTimer 置 null，但末尾的 restarting = false 未执行到。
        // 此时若 reclaim 把复位嵌在 if (this.restartTimer) 内，就永远不会执行。
        ;(m as any).restarting = true
        ;(m as any).restartTimer = null

        ;(m as any).reclaimCurrentWorker()

        // restarting 残留为 true 会让 onWorkerExit 的 `code !== 0 && !this.restarting` 门恒为假
        // → 新 Worker 崩溃后再也不排期重启（静默降级）
        expect((m as any).restarting).toBe(false)
    })
})

describe('MCPWorkerManager 活性修复', () => {
    it('A: worker 未就绪时 restartServer 立即失败，不登记 waiter', async () => {
        const m = new MCPWorkerManager()
        ;(m as any).worker = null

        const result = await m.restartServer('s1')

        expect(result).toEqual({success: false, error: 'MCP Worker 未就绪'})
        // 没有 waiter → 不会留下 60s 超时定时器
        expect((m as any).restartWaiters.size).toBe(0)
    })

    it('B: shutdown() 中 terminate() 被 reject 不产生未处理拒绝', async () => {
        vi.useFakeTimers()
        const m = new MCPWorkerManager()
        const w = new FakeWorker()
        w.terminate = vi.fn(() => Promise.reject(new Error('force terminate failed')))
        ;(m as any).worker = w
        attachHandlers(m, w)

        const pending = m.shutdown()
        // exit 不回传 → 走 5s 超时的强制 terminate 分支
        await vi.advanceTimersByTimeAsync(5000)

        await expect(pending).resolves.toBeUndefined()
        expect(w.terminate).toHaveBeenCalledTimes(1)
        expect(mocks.logger.warn).toHaveBeenCalled()
    })
})
