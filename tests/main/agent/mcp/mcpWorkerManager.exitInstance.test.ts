/**
 * P2-b：onWorkerExit 的实例判定必须「生产有效」
 *
 * 背景（独立复验以真实 Worker 取证）：Node 的 'exit' 事件只传 exitCode、不传实例，
 * 原实现用裸 `worker.on('exit', this.onWorkerExit)` 注册 → handler 第二参恒为 undefined，
 * `worker !== undefined && worker !== this.worker` 分支永不执行（仅供测试的死代码），
 * 注释却把它写成「安全前提」，会让维护者误以为已有陈旧实例防护。
 *
 * 本文件锁定修复后的形态：
 *  A. spawn() 用**闭包捕获实例**注册 handler → 旧实例退出（已非当前实例）不产生任何副作用；
 *  B. reclaimCurrentWorker() 按保存的闭包引用**精确摘除** → 真实 spawn 路径下
 *     listenerCount('exit') === 0（D1 语义不被破坏），旧实例 terminate 的非 0 退出不排期重启；
 *  C. 当前实例非 0 退出仍走 scheduleRestart（回归护栏）。
 *
 * ⚠️ 严禁真实 taskkill / 不启动真实 Worker：child_process.execSync 与 isProcessRunning 均 mock，
 *    worker_threads 的 Worker 换成本地 FakeWorker（EventEmitter）。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'

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

/** 把 Worker 换成本地 EventEmitter 假实现（保留 MessageChannel 等其余导出） */
vi.mock('worker_threads', async (importOriginal) => {
    const actual = await importOriginal<any>()
    const {EventEmitter} = await import('node:events')

    class FakeWorker extends EventEmitter {
        static instances: FakeWorker[] = []
        postMessage = vi.fn()
        terminate = vi.fn(() => Promise.resolve(0))
        constructor(_workerPath: string, _options?: unknown) {
            super()
            FakeWorker.instances.push(this)
        }
    }

    return {...actual, Worker: FakeWorker, __FakeWorker: FakeWorker}
})

import {MCPWorkerManager} from '@/main/agent/mcp/mcpWorkerManager'
import * as workerThreads from 'worker_threads'

const FakeWorker = (workerThreads as any).__FakeWorker as {
    new (workerPath: string, options?: unknown): any
    instances: any[]
}

beforeEach(() => {
    mocks.execSync.mockClear()
    mocks.logger.warn.mockClear()
    FakeWorker.instances.length = 0
})

afterEach(() => {
    vi.useRealTimers()
})

describe('MCPWorkerManager.onWorkerExit 实例判定（P2-b 闭包捕获）', () => {
    it('A: spawn 的 handler 闭包携带实例 → 旧实例退出不误清当前实例引用、不排期重启', () => {
        const m = new MCPWorkerManager()
        ;(m as any).spawn()

        const spawned = FakeWorker.instances[0]
        expect(spawned).toBeTruthy()
        expect((m as any).worker).toBe(spawned)
        // 注册的是 handler（而非裸 onWorkerExit 引用），reclaim 才能按引用摘除
        expect(spawned.listenerCount('exit')).toBe(1)
        expect(typeof (m as any).workerExitHandler).toBe('function')

        // 模拟「未先 reclaim 就换了当前实例」的异常路径：字段被新实例覆盖
        const live = new FakeWorker('x')
        ;(m as any).worker = live

        // 旧实例退出：闭包把 spawned 带进 onWorkerExit → 实例判定生效 → 直接 return
        spawned.emit('exit', 1)

        expect((m as any).worker).toBe(live)     // 不得误清新实例引用
        expect((m as any).restartTimer).toBeNull()
        expect((m as any).restarting).toBe(false)
    })

    it('B: reclaim 按保存的闭包引用精确摘除 → listenerCount("exit")===0 且旧实例退出无副作用', () => {
        const m = new MCPWorkerManager()
        ;(m as any).spawn()

        const spawned = FakeWorker.instances[0]
        expect(spawned.listenerCount('exit')).toBe(1)

        ;(m as any).reclaimCurrentWorker()

        // D1：真实 spawn 路径下 exit 监听器必须被摘净（否则 terminate 的非 0 退出会排期重启）
        expect(spawned.listenerCount('exit')).toBe(0)
        expect((m as any).workerExitHandler).toBeNull()
        expect((m as any).worker).toBeNull()

        spawned.emit('exit', 1)
        expect((m as any).restartTimer).toBeNull()
        expect((m as any).restarting).toBe(false)
    })

    it('C: 当前实例非 0 退出 → 清引用并按 5s 排期重启（回归护栏）', () => {
        vi.useFakeTimers()
        const m = new MCPWorkerManager()
        const spawnSpy = vi.spyOn(m as any, 'spawn').mockImplementation(() => {})

        const w = new FakeWorker('x')
        const handler = (code: number) => (m as any).onWorkerExit(code, w)
        ;(m as any).worker = w
        ;(m as any).workerExitHandler = handler
        w.on('exit', handler)

        w.emit('exit', 1)

        expect((m as any).worker).toBeNull()
        expect((m as any).restarting).toBe(true)
        expect((m as any).restartTimer).not.toBeNull()

        vi.advanceTimersByTime(5000)
        expect(spawnSpy).toHaveBeenCalledTimes(1)
        expect((m as any).restarting).toBe(false)
    })
})
