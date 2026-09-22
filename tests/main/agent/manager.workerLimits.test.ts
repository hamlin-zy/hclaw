/**
 * AgentManager — 会话 Worker 内存加固（评审建议 4）
 *
 * 覆盖两项：
 *  A) 会话 Worker 创建时**确实**传入 resourceLimits（此前 5 个 `new Worker` 站点全裸，
 *     worker isolate 继承主进程 --max-old-space-size=2048 → 每会话 2GB 上限）。
 *  B) 同一会话重启是「替换自身」：不新增并发 Worker。
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
vi.mock('@/main/hclawPaths', async () => await import('@/main/config'))  // 路径能力已下沉到叶子 hclawPaths：让叶子跟随本文件对 config 的桩，避免绕过 mock 落到真实 ~/.hclaw

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

vi.mock('@/main/persistence/conversationPersistence', () => {
    // 单例桩：D 组需断言 finalizeMessage 的调用与 pending 终结顺序，故保持同一份对象引用
    const persistence = {
        onPersistEvent: () => () => {},
        flush: vi.fn(),
        clearConversation: vi.fn(),
        finalizeMessage: vi.fn(() => true),
        // D 组：handleStreamEvent 对 done 事件也走 accumulateEvent → #rowEnsured 首次建行
        ensureMessageRow: vi.fn(),
    }
    return {getConversationPersistence: () => persistence}
})

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
import {SESSION_AGENT_WORKER_RESOURCE_LIMITS} from '@/main/workerLimits'
import type {AgentStartParams, PendingAssistantMsg} from '@/main/agent/manager.types'
import {resetBridgeMsgState} from '@/main/persistence/streamBridge'
import {getConversationPersistence} from '@/main/persistence/conversationPersistence'

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

describe('B) 同一会话重启是替换自身（不新增并发 Worker）', () => {
    it('已有多个会话在跑时，重启其中一个不增加 workers Map 规模', async () => {
        const manager = makeManager()
        const map = seedWorkers(manager, ['conv-0', 'conv-1', 'conv-2'])

        await expect(manager.start(makeParams('conv-1'))).resolves.toBeUndefined()

        // 新建了 1 个 Worker（替换），Map 规模不变（先 abort 旧条目）
        expect(workerSpy.instances).toHaveLength(1)
        expect(map.size).toBe(3)
        expect(manager.isRunning('conv-0')).toBe(true)
        expect(manager.isRunning('conv-2')).toBe(true)
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

// ── D) resetBridgeMsgState 调用点守护（G3）──────────────────────────────
// 缺口：manager.impl.ts:610 / 766 / 1846 三处 `resetBridgeMsgState` 调用任一被重构
// 删除时，streamBridge 侧单测仍全绿——manager 层测试把 streamBridge 整个 mock 掉了
// （本文件即如此），而桥接侧单测只看 persistStreamEvent 自身的行为。
// 本组在 manager 层「消息终结 / pending 替换 / 异常清理」三个场景下断言
// resetBridgeMsgState 被以对应 msgId 调用，把这三条调用点接入回归防护网。
describe('D) resetBridgeMsgState 调用点守护（消息终结 / pending 替换 / 异常清理）', () => {
    const resetSpy = resetBridgeMsgState as unknown as ReturnType<typeof vi.fn>
    const persistence = getConversationPersistence() as unknown as {finalizeMessage: ReturnType<typeof vi.fn>}

    beforeEach(() => {
        resetSpy.mockClear()
        persistence.finalizeMessage.mockClear()
        persistence.finalizeMessage.mockReturnValue(true)
    })

    /** 最小合法 pending（空内容 → #mergeAndPersist 首个判据即 return，不触碰真实 DB 写路径） */
    function seedPending(manager: AgentManager, convId: string, msgId: string): void {
        const pending = {
            id: msgId, content: '', contentLength: 0, toolCalls: [], thinkContent: null,
            timestamp: 1, toolStates: {}, progressLog: {}, subAgentStream: {},
            pendingQuestion: null, pendingPermissionConfirm: null,
        } as unknown as PendingAssistantMsg
        ;(manager as unknown as {pendingAssistantMsg: Map<string, PendingAssistantMsg | null>})
            .pendingAssistantMsg.set(convId, pending)
    }

    function driveStream(manager: AgentManager, convId: string, event: unknown): Promise<void> {
        return (manager as unknown as {
            handleStreamEvent: (c: string, w: unknown, e: unknown) => Promise<void>
        }).handleStreamEvent(convId, {}, event)
    }

    it('消息终结（done 事件 → #finalizeThenMerge）：finalize 后释放该 msgId 的桥接状态', async () => {
        const manager = makeManager()
        seedPending(manager, 'conv-done', 'msg-done-1')

        await driveStream(manager, 'conv-done', {type: 'done', reason: 'completed'})

        expect(persistence.finalizeMessage).toHaveBeenCalledWith('conv-done', 'msg-done-1', expect.any(Number))
        expect(resetSpy).toHaveBeenCalledWith('msg-done-1')
    })

    it('pending 替换（user_message_injected）：旧 pending 终结后释放桥接状态', async () => {
        const manager = makeManager()
        seedPending(manager, 'conv-inject', 'msg-old-1')

        await driveStream(manager, 'conv-inject', {type: 'user_message_injected', content: 'hi'})

        expect(resetSpy).toHaveBeenCalledWith('msg-old-1')
    })

    it('异常清理（onWorkerError → cleanup）：兜底释放当前 pending 的桥接状态', () => {
        const manager = makeManager()
        seedPending(manager, 'conv-oom-2', 'msg-crash-1')

        ;(manager as unknown as {onWorkerError: (c: string, e: Error) => void})
            .onWorkerError('conv-oom-2', new Error('boom'))

        expect(resetSpy).toHaveBeenCalledWith('msg-crash-1')
    })
})

