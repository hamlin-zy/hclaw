/**
 * AgentManager — 预热（prewarm）状态机收敛
 *
 * 覆盖 D1a/D1b 修复后的对称清理契约（manager.impl.ts prewarm()）：
 *   (a) standby_ready → resolve：idleWorker/idleWorkerReady 置位、prewarming 复位、超时定时器清除；
 *   (b) 预热期 exit   → reject + terminate dead worker + 复位 3 标志 + off 全部临时 handler + 清超时；
 *   (c) 预热期 error  → 同 (b)（error handler 的「重置 3 标志」并入同一收敛路径）；
 *   (d) 超时（PREWARM_READY_TIMEOUT_MS 内未 ready）→ 与 (b)(c) 共用的失败收敛；
 *   (e) 幂等 settle   → 一旦 settled（ready 或 fail），后续 exit/error/timeout 不二次 terminate、不二次清理。
 *
 * 手法：mock `worker_threads` 为可控 EventEmitter 假 Worker（仓库既有 mock 手法，见
 * manager.workerLimits.test.ts / mcpWorker.*.test.ts），使 standby_ready/exit/error 可由测试
 * 直接驱动；其余 manager.impl 依赖以最小桩替换。PREWARM_READY_TIMEOUT_MS 通过 mock
 * manager.constants 覆盖为 50ms（避免测试真实等待 10s，同时守护「超时常量确实被消费」）。
 */
import {describe, expect, it, vi, beforeEach} from 'vitest'

// ── 可控假 Worker：EventEmitter 驱动 + 捕获构造参数 ──────────────
const workerSpy = vi.hoisted(() => {
    // hoisted 回调早于顶层 import 初始化，在此取 EventEmitter（顶层 import 会 TDZ，见 __vi_import_0__ 报错）
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const {EventEmitter} = require('events')
    type Instance = FakeWorker
    class FakeWorker extends EventEmitter {
        path: string
        options: Record<string, unknown>
        postMessage = vi.fn()
        terminate = vi.fn(() => Promise.resolve(0))
        constructor(path: string, options?: Record<string, unknown>) {
            super()
            this.path = path
            this.options = options ?? {}
            workerSpy.instances.push(this as unknown as Instance)
        }
    }
    return {instances: [] as Instance[], FakeWorker}
})

vi.mock('worker_threads', () => ({Worker: workerSpy.FakeWorker}))

// 超时常量覆盖为 50ms（保留同文件其它常量，见 (d) 的说明）
vi.mock('@/main/agent/manager.constants', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/main/agent/manager.constants')>()
    return {...actual, PREWARM_READY_TIMEOUT_MS: 50}
})

// ── electron 空壳 ────────────────────────────────────────────────
vi.mock('electron', () => ({
    BrowserWindow: Object.assign(class {}, {getAllWindows: () => []}),
    app: {getVersion: () => '0.0.0-test', getPath: () => '/tmp', isReady: () => true},
    dialog: {showErrorBox: vi.fn()},
    ipcMain: {handle: vi.fn(), on: vi.fn()},
}))

vi.mock('@/main/config', () => ({
    getHclawDir: () => '/tmp/hclaw-prewarm-test',
    getHclawDataDir: () => '/tmp/hclaw-prewarm-test/data',
    HCLAW_DIR: '/tmp/hclaw-prewarm-test',
    isSafePath: () => true,
}))
vi.mock('@/main/hclawPaths', async () => await import('@/main/config'))

vi.mock('@/main/agent/logger', () => ({
    logger: {info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn()},
}))

vi.mock('@/main/repositories/sqlite/systemSettingsRepository', () => ({
    systemSettingsRepo: {getJson: () => null, setJson: vi.fn()},
}))

vi.mock('@/main/repositories/sqlite/taskBatchRepository', () => ({
    getActiveBatch: () => null,
    upsertSnapshot: vi.fn(),
}))

vi.mock('@/main/agent/capabilityManager', () => ({
    capabilityManager: {serializeForWorker: vi.fn(async () => ({}))},
}))

vi.mock('@/main/agent/runtimeConfigManager', () => ({
    runtimeConfigManager: {
        getOverride: () => null,
        getConvPermissionMode: () => 'default',
        getScheme: () => null,
        getProviders: () => [],
        releaseConvState: vi.fn(),
    },
}))

vi.mock('@/main/utils/llmTraceRecorder', () => ({
    isRecordingEnabled: () => false,
    getLlmTraceRootDir: () => '/tmp/hclaw-prewarm-test',
}))

vi.mock('@/main/utils/restart', () => ({gracefulRestart: vi.fn()}))

vi.mock('@/main/attention', () => ({
    notifyUserAttention: vi.fn(),
    stopUserAttention: vi.fn(),
    clearUserAttention: vi.fn(),
}))

vi.mock('@/main/agent/mcp/mcpWorkerManager', () => ({
    mcpWorkerManager: {unregisterAgent: vi.fn(), registerAgent: vi.fn()},
    setAgentManagerRef: vi.fn(),
}))

vi.mock('@/main/agent/tools/builtin/agentTool', () => ({
    injectChildMessage: vi.fn(),
    abortChildSession: vi.fn(() => false),
}))

vi.mock('@/main/agent/tools/permission', () => ({permissionEngine: {}}))

vi.mock('@/main/common/eventBus', () => ({
    eventBus: {on: vi.fn(), off: vi.fn(), emit: vi.fn()},
    CapabilityEvents: {REFRESHED: 'capability_refreshed'},
    MCPThemeEvents: {TOOLS_REFRESHED: 'mcp_tools_refreshed'},
}))

vi.mock('@/main/persistence/conversationPersistence', () => ({
    getConversationPersistence: () => ({
        onPersistEvent: () => () => {},
        flush: vi.fn(),
        clearConversation: vi.fn(),
        finalizeMessage: vi.fn(() => true),
        ensureMessageRow: vi.fn(),
        flushAllSync: vi.fn(),
    }),
}))

vi.mock('@/main/persistence/streamBridge', () => ({
    persistStreamEvent: vi.fn(),
    resetBridgeMsgState: vi.fn(),
}))

vi.mock('@/main/usageWrite', () => ({
    recordLlmUsageEvent: vi.fn(),
    resetUsageMsgState: vi.fn(),
}))

vi.mock('@/main/agent/manager.pluginAgents', () => ({loadPluginAgents: vi.fn(async () => [])}))

vi.mock('@/main/agent/loop/loopDetector', () => ({clearLoopSilence: vi.fn()}))

import {AgentManager} from '@/main/agent/manager.impl'

type AnyManager = {
    prewarm: () => Promise<void>
    disposeIdleWorker: () => void
    idleWorker: unknown
    idleWorkerReady: boolean
    prewarming: boolean
    abortPrewarm: (() => void) | null
}

function mgr(manager: AgentManager): AnyManager {
    return manager as unknown as AnyManager
}

/**
 * 构造一个「自动预热已收敛、且腾出 idleWorker 槽位」的 manager，供手动 prewarm 用例复用。
 * 构造器 setImmediate 会自动跑一次 prewarm（创建 auto worker）；本 helper 把它驱动到 ready
 * 并清掉 idleWorker，使后续手动 prewarm 能新建独立的 worker 实例（instances[0]）。
 */
async function makeReadyManager(): Promise<AgentManager> {
    workerSpy.instances.length = 0
    const manager = new AgentManager()
    // flush 自动 prewarm 的 setImmediate（真实 timer）
    await new Promise((r) => setImmediate(r))
    const auto = workerSpy.instances[0]
    auto.emit('message', {type: 'standby_ready'})
    // 让自动 prewarm 内部的 await 微任务收敛
    await new Promise((r) => setImmediate(r))
    // 腾出槽位：手动 prewarm 将创建全新的 instances[0]
    ;(manager as unknown as AnyManager).idleWorker = null
    ;(manager as unknown as AnyManager).idleWorkerReady = false
    ;(manager as unknown as AnyManager).prewarming = false
    workerSpy.instances.length = 0
    return manager
}

beforeEach(() => {
    workerSpy.instances.length = 0
})

describe('D1a/D1b 预热状态机收敛', () => {
    it('(a) standby_ready → resolve：置位 idleWorker/ready、复位 prewarming、清除超时定时器', async () => {
        const manager = await makeReadyManager()
        const prewarmPromise = mgr(manager).prewarm()
        const w = workerSpy.instances[0]
        expect(w.options.workerData).toEqual({type: 'standby'})

        w.emit('message', {type: 'standby_ready'})
        await prewarmPromise

        expect(mgr(manager).idleWorker).toBe(w)
        expect(mgr(manager).idleWorkerReady).toBe(true)
        expect(mgr(manager).prewarming).toBe(false)
        // ready 后 terminate 不应被调用（worker 已就绪，保留常驻）
        expect(w.terminate).not.toHaveBeenCalled()
    })

    it('(b) 预热期 exit → terminate dead worker + 复位 3 标志 + off 全部临时 handler + 清超时', async () => {
        const manager = await makeReadyManager()
        const prewarmPromise = mgr(manager).prewarm()
        const w = workerSpy.instances[0]

        w.emit('exit', 0)
        await prewarmPromise

        expect(w.terminate).toHaveBeenCalledTimes(1)
        expect(mgr(manager).idleWorker).toBe(null)
        expect(mgr(manager).idleWorkerReady).toBe(false)
        expect(mgr(manager).prewarming).toBe(false)
        expect(w.listenerCount('message')).toBe(0)
        expect(w.listenerCount('error')).toBe(0)
        expect(w.listenerCount('exit')).toBe(0)
    })

    it('(c) 预热期 error → 与 exit 对称（重置 3 标志并入同一收敛路径 + terminate）', async () => {
        const manager = await makeReadyManager()
        const prewarmPromise = mgr(manager).prewarm()
        const w = workerSpy.instances[0]

        w.emit('error', new Error('warmup boom'))
        await prewarmPromise

        expect(w.terminate).toHaveBeenCalledTimes(1)
        expect(mgr(manager).idleWorker).toBe(null)
        expect(mgr(manager).idleWorkerReady).toBe(false)
        expect(mgr(manager).prewarming).toBe(false)
        expect(w.listenerCount('message')).toBe(0)
        expect(w.listenerCount('error')).toBe(0)
        expect(w.listenerCount('exit')).toBe(0)
    })

    it('(d) 超时（PREWARM_READY_TIMEOUT_MS 内未 ready）→ 走失败收敛并终止 dead worker', async () => {
        const manager = await makeReadyManager()
        const prewarmPromise = mgr(manager).prewarm()
        const w = workerSpy.instances[0]
        // 不 emit 任何事件；等待 mock 的 50ms 超时兜底
        await prewarmPromise

        expect(w.terminate).toHaveBeenCalledTimes(1)
        expect(mgr(manager).idleWorker).toBe(null)
        expect(mgr(manager).prewarming).toBe(false)
        expect(w.listenerCount('message')).toBe(0)
    })

    it('(e) 幂等 settle：ready 后迟到 error/exit 不再 terminate、不再二次清理', async () => {
        const manager = await makeReadyManager()
        const prewarmPromise = mgr(manager).prewarm()
        const w = workerSpy.instances[0]

        w.emit('message', {type: 'standby_ready'})
        await prewarmPromise
        expect(mgr(manager).idleWorker).toBe(w)
        expect(w.terminate).not.toHaveBeenCalled()

        // 已 ready：迟到的 error 只复位常驻标志，不 terminate（保持原 error handler 语义）
        w.emit('error', new Error('late error'))
        expect(w.terminate).not.toHaveBeenCalled()
        expect(mgr(manager).idleWorker).toBe(null)

        // 已 ready + idleWorker 已被上条复位为 null：迟到的 exit 守卫（idleWorker===worker）为假，不触碰
        w.emit('exit', 0)
        expect(w.terminate).not.toHaveBeenCalled()
    })

    it('(e2) 幂等 settle：fail（exit）后超时不二次 terminate', async () => {
        const manager = await makeReadyManager()
        const prewarmPromise = mgr(manager).prewarm()
        const w = workerSpy.instances[0]

        w.emit('exit', 0)
        await prewarmPromise
        expect(w.terminate).toHaveBeenCalledTimes(1)

        // failPrewarm 已清超时定时器；再等过 50ms 也不应出现第二次 terminate
        await new Promise((r) => setTimeout(r, 80))
        expect(w.terminate).toHaveBeenCalledTimes(1)
    })
})

describe('L2-D1 pending 态退出回收（disposeIdleWorker）', () => {
    it('(f) 预热中 disposeIdleWorker → 终止该 worker、摘监听器、有界收敛；迟到 standby_ready 不复活', async () => {
        const manager = await makeReadyManager()
        const prewarmPromise = mgr(manager).prewarm()
        const w = workerSpy.instances[0]

        // pending 态前置条件：worker 已构造，但 idleWorker 仍为 null，主动收敛通道已挂上
        expect(mgr(manager).idleWorker).toBe(null)
        expect(mgr(manager).idleWorkerReady).toBe(false)
        expect(mgr(manager).prewarming).toBe(true)
        expect(typeof mgr(manager).abortPrewarm).toBe('function')

        mgr(manager).disposeIdleWorker()

        // 预热中 worker 必须被显式终止（回退修复时此断言即失败：terminate 从未被调用）
        expect(w.terminate).toHaveBeenCalledTimes(1)
        expect(w.listenerCount('message')).toBe(0)
        expect(mgr(manager).prewarming).toBe(false)
        // pending 容器已移除路径，不留悬挂闭包
        expect(mgr(manager).abortPrewarm).toBe(null)

        // 迟到 standby_ready：监听器已摘除 + settled 守卫 → 不得复活退出期已清理的态
        w.emit('message', {type: 'standby_ready'})
        expect(mgr(manager).idleWorker).toBe(null)
        expect(mgr(manager).idleWorkerReady).toBe(false)

        // 等待 Promise 以有界方式收敛（不等 50ms 超时；不 await 会余留未处理 rejection）
        await expect(prewarmPromise).resolves.toBeUndefined()

        // 幂等：再次调用无副作用、不二次 terminate
        mgr(manager).disposeIdleWorker()
        expect(w.terminate).toHaveBeenCalledTimes(1)
    })
})
