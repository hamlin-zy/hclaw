/**
 * AgentManager — 会话 Worker 内存加固（评审建议 4）
 *
 * 覆盖两项：
 *  A) 会话 Worker 创建时**确实**传入 resourceLimits（此前 5 个 `new Worker` 站点全裸，
 *     worker isolate 继承主进程 --max-old-space-size=2048 → 每会话 2GB 上限）。
 *  B) 会话 Worker 并发闸门：达上限时**拒绝启动并给出可读错误**，
 *     且不打断任何已在运行的会话、不排队、不静默丢弃。
 *
 * 手法：mock `worker_threads` 捕获 Worker 构造 options（与仓库既有对 Worker 的
 * mock 手法一致，见 tests/main/agent/mcpWorker.*.test.ts）；其余 manager.impl 依赖
 * 以最小桩替换，不驱动 agent loop。
 */
import {describe, expect, it, vi, beforeEach} from 'vitest'

// ── 捕获 Worker 构造参数的假 Worker ──────────────────────────────
const workerSpy = vi.hoisted(() => {
    const instances: Array<{
        path: string
        options: Record<string, unknown>
        postMessage: ReturnType<typeof vi.fn>
        terminate: ReturnType<typeof vi.fn>
        on: ReturnType<typeof vi.fn>
    }> = []
    class FakeWorker {
        path: string
        options: Record<string, unknown>
        postMessage = vi.fn()
        terminate = vi.fn(() => Promise.resolve(0))
        on = vi.fn()
        constructor(path: string, options?: Record<string, unknown>) {
            this.path = path
            this.options = options ?? {}
            instances.push(this as unknown as (typeof instances)[number])
        }
    }
    return {instances, FakeWorker}
})

vi.mock('worker_threads', () => ({Worker: workerSpy.FakeWorker}))

// ── electron 空壳 ────────────────────────────────────────────────
const fakeWin = {
    isDestroyed: () => false,
    webContents: {send: vi.fn()},
}
vi.mock('electron', () => ({
    BrowserWindow: Object.assign(class {}, {getAllWindows: () => [fakeWin]}),
    app: {getVersion: () => '0.0.0-test', getPath: () => '/tmp', isReady: () => true},
    dialog: {showErrorBox: vi.fn()},
    ipcMain: {handle: vi.fn(), on: vi.fn()},
}))

vi.mock('@/main/config', () => ({
    getHclawDir: () => '/tmp/hclaw-test',
    getHclawDataDir: () => '/tmp/hclaw-test/data',
    HCLAW_DIR: '/tmp/hclaw-test',
    isSafePath: () => true,
}))

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
    },
}))

vi.mock('@/main/utils/llmTraceRecorder', () => ({
    isRecordingEnabled: () => false,
    getLlmTraceRootDir: () => '/tmp/hclaw-test',
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

vi.mock('@/main/agent/tools/builtin/agentTool', () => ({injectChildMessage: vi.fn()}))

vi.mock('@/main/agent/tools/permission', () => ({permissionEngine: {}}))

vi.mock('@/main/common/eventBus', () => ({
    eventBus: {on: vi.fn(), off: vi.fn(), emit: vi.fn()},
    CapabilityEvents: {},
    MCPThemeEvents: {},
}))

vi.mock('@/main/persistence/conversationPersistence', () => ({
    getConversationPersistence: () => ({
        onPersistEvent: () => () => {},
        flush: vi.fn(),
        clearConversation: vi.fn(),
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
import {
    SESSION_AGENT_WORKER_RESOURCE_LIMITS,
    MAX_CONCURRENT_SESSION_WORKERS,
} from '@/main/workerLimits'
import type {AgentStartParams} from '@/main/agent/manager.types'

function makeParams(conversationId: string): AgentStartParams {
    return {
        conversationId,
        messages: [],
        modelConfig: {} as never,
        workingDir: '/ws',
        capabilities: {} as never,
    }
}

function makeManager() {
    workerSpy.instances.length = 0
    const manager = new AgentManager()
    const send = vi.fn()
    ;(manager as unknown as {mainWindow: unknown}).mainWindow = {
        isDestroyed: () => false,
        webContents: {send},
    }
    return manager
}

/** 直接向私有 workers Map 塞入假条目（模拟「已有 N 个会话在跑」） */
function seedWorkers(manager: AgentManager, convIds: string[]) {
    const map = (manager as unknown as {workers: Map<string, unknown>}).workers
    for (const id of convIds) {
        map.set(id, {
            worker: new workerSpy.FakeWorker(`/fake/${id}.js`, {}),
            conversationId: id,
            abortController: new AbortController(),
        })
    }
    // 种子条目是「既有会话」，不计入本测试关心的「start() 新建的 Worker」
    workerSpy.instances.length = 0
    return map
}

describe('A) 会话 Worker 创建时传入 resourceLimits', () => {
    beforeEach(() => {
        workerSpy.instances.length = 0
    })

    it('new Worker 的 options 携带 SESSION_AGENT_WORKER_RESOURCE_LIMITS', async () => {
        const manager = makeManager()
        await manager.start(makeParams('conv-a'))

        expect(workerSpy.instances).toHaveLength(1)
        const opts = workerSpy.instances[0].options as {
            type?: string
            workerData?: {type?: string}
            resourceLimits?: unknown
        }
        expect(opts.type).toBe('module')
        expect(opts.workerData?.type).toBe('start')
        expect(opts.resourceLimits).toEqual(SESSION_AGENT_WORKER_RESOURCE_LIMITS)
        // 会话 Worker 上限必须显著低于继承来的 2048MB，且给长会话留余量
        expect(SESSION_AGENT_WORKER_RESOURCE_LIMITS.maxOldGenerationSizeMb).toBe(512)
        expect(SESSION_AGENT_WORKER_RESOURCE_LIMITS.maxYoungGenerationSizeMb).toBe(16)
    })

    it('workerData 仍原样透传（resourceLimits 不挤掉原有字段）', async () => {
        const manager = makeManager()
        await manager.start(makeParams('conv-b'))

        const opts = workerSpy.instances[0].options as {workerData?: {params?: {conversationId?: string}}}
        expect(opts.workerData?.params?.conversationId).toBe('conv-b')
    })
})

describe('B) 会话 Worker 并发闸门', () => {
    it('未达上限时可正常启动', async () => {
        const manager = makeManager()
        seedWorkers(manager, Array.from({length: MAX_CONCURRENT_SESSION_WORKERS - 1}, (_, i) => `conv-${i}`))

        await expect(manager.start(makeParams('conv-new'))).resolves.toBeUndefined()
        expect(workerSpy.instances).toHaveLength(1)
    })

    it('达上限时拒绝启动，并抛出含上限数字的可读错误', async () => {
        const manager = makeManager()
        seedWorkers(manager, Array.from({length: MAX_CONCURRENT_SESSION_WORKERS}, (_, i) => `conv-${i}`))

        await expect(manager.start(makeParams('conv-overflow'))).rejects.toThrow(
            new RegExp(`并发|上限|${MAX_CONCURRENT_SESSION_WORKERS}`),
        )
        // 未创建任何新 Worker
        expect(workerSpy.instances).toHaveLength(0)
        // 未被登记
        expect(manager.isRunning('conv-overflow')).toBe(false)
    })

    it('拒绝时不打断、不终止已在运行的会话（不腾位置）', () => {
        const manager = makeManager()
        const map = seedWorkers(manager, Array.from({length: MAX_CONCURRENT_SESSION_WORKERS}, (_, i) => `conv-${i}`))

        expect(map.size).toBe(MAX_CONCURRENT_SESSION_WORKERS)
        for (const entry of map.values()) {
            const w = (entry as {worker: {postMessage: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn>}}).worker
            expect(w.postMessage).not.toHaveBeenCalled()
            expect(w.terminate).not.toHaveBeenCalled()
        }
        expect(manager.isRunning('conv-0')).toBe(true)
    })

    it('同一会话重启（替换自身）不占用额外名额：满员时仍可重跑', async () => {
        const manager = makeManager()
        seedWorkers(manager, Array.from({length: MAX_CONCURRENT_SESSION_WORKERS}, (_, i) => `conv-${i}`))

        // conv-0 已在运行 → 重启它应被允许（替换自身，不新增并发）
        await expect(manager.start(makeParams('conv-0'))).resolves.toBeUndefined()
        expect(workerSpy.instances).toHaveLength(1)
    })
})

describe('C) worker 因超限被杀时的用户可见行为', () => {
    // forwardToRenderer 走 BrowserWindow.getAllWindows() → mock 里的 fakeWin
    const rendererSend = fakeWin.webContents.send as unknown as ReturnType<typeof vi.fn>

    function lastErrorPayload() {
        const hit = rendererSend.mock.calls.filter(
            (c) => (c[1] as {event?: {type?: string}})?.event?.type === 'error',
        )
        return hit[hit.length - 1]?.[1] as {event: {type: string; error: string}}
    }

    beforeEach(() => {
        rendererSend.mockClear()
    })

    it('ERR_WORKER_OUT_OF_MEMORY → 转发可读中文提示（含 512MB 上限），不被吞', () => {
        const manager = makeManager()
        const err = new Error('Worker terminated due to reaching memory limit: JS heap out of memory')
        ;(err as NodeJS.ErrnoException).code = 'ERR_WORKER_OUT_OF_MEMORY'

        ;(manager as unknown as {onWorkerError: (c: string, e: Error) => void}).onWorkerError('conv-oom', err)

        const payload = lastErrorPayload()
        expect(payload.event.error).toContain('内存超限')
        expect(payload.event.error).toContain(
            String(SESSION_AGENT_WORKER_RESOURCE_LIMITS.maxOldGenerationSizeMb),
        )
    })

    it('非超限错误原样透传（不改变既有行为）', () => {
        const manager = makeManager()
        ;(manager as unknown as {onWorkerError: (c: string, e: Error) => void}).onWorkerError(
            'conv-boom',
            new Error('boom'),
        )

        expect(lastErrorPayload().event.error).toBe('boom')
    })
})
