/**
 * 记忆沉淀前置探针 — 接入点（SchedulerManager.executeSchedule）集成测试
 *
 * 背景：探针判定「无待沉淀会话」时，执行入口必须**在创建会话之前**短路：
 * 不建会话、不进 LLM、零 token；且不改 `last_run_status`（跳过既非成功也非失败）。
 *
 * **作用域（第二轮修正）**：设计口径是「cron 到点 → 建会话 → 进 LLM 之间插一道短路闸」，
 * 探针**只作用于 cron 到点路径**。手动「立即执行」是用户显式意图，必须真跑 ——
 * 渲染端会先乐观置「运行中」（useScheduleListState），静默跳过会表现为「点了没反应」。
 * 故本文件的 4 条用例各自经由**真实来源入口**触发：
 *   - cron 路径：假 worker + `task_fire` 消息（范式同 fireSourceAndScriptAttribution.test.ts）
 *   - 手动路径：`schedulerManager.runNow`
 * 不允许为了好测去放宽产品代码的可见性。
 *
 * mock 范式沿用同目录 fireSourceAndScriptAttribution.test.ts / runStatusBroadcast.test.ts：
 *   - config / hclawPaths 指向临时目录（不触碰真实 ~/.hclaw）
 *   - worker_threads 假实现（捕获出站消息与消息处理器，不真的起线程）
 *   - ScheduleRepository 打桩（观察 updateRunStatus 的调用次数）
 *   - memoryProbe 打桩（本文件考的就是接入点，判定本身由 memoryProbe.test.ts 覆盖）
 *   - startAgentCore / repositories 打桩（不真的起 LLM）
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'

vi.mock('@/main/config', () => {
    const os = require('os')
    const pathMod = require('path')
    const testDir = pathMod.join(os.tmpdir(), 'hclaw-test-memory-probe-gate-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
        getHclawDataDir: () => pathMod.join(testDir, 'data'),
    }
})
vi.mock('@/main/hclawPaths', async () => await import('@/main/config'))

/** worker_threads 的假实现：捕获消息处理器与出站消息，不真的起线程 */
vi.mock('worker_threads', () => {
    class FakeWorker {
        static instances: FakeWorker[] = []
        readonly posted: unknown[] = []
        readonly handlers: Record<string, (arg: unknown) => void> = {}
        constructor() { FakeWorker.instances.push(this) }
        on(event: string, handler: (arg: unknown) => void): void { this.handlers[event] = handler }
        postMessage(msg: unknown): void { this.posted.push(msg) }
        terminate(): void { /* no-op */ }
    }
    return {Worker: FakeWorker}
})

const loggerStub = vi.hoisted(() => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
}))
vi.mock('@/main/agent/logger', () => ({createLogger: () => loggerStub, logger: loggerStub}))

const probeStub = vi.hoisted(() => ({hasPendingConversations: vi.fn(() => true)}))
vi.mock('@/main/scheduler/memoryProbe', () => ({
    hasPendingConversations: probeStub.hasPendingConversations,
}))

const startAgentCoreStub = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('@/main/agent/startAgentCore', () => ({startAgentCore: startAgentCoreStub}))

const convRepoStub = vi.hoisted(() => ({
    list: vi.fn(() => [] as unknown[]),
    create: vi.fn(),
    updateMeta: vi.fn(),
    readMessages: vi.fn(() => [] as unknown[]),
    readMeta: vi.fn(() => null),
}))
vi.mock('@/main/repositories', () => ({createConversationRepository: () => convRepoStub}))

const scheduleRepoStub = vi.hoisted(() => ({
    get: vi.fn(),
    listEnabled: vi.fn(() => [] as unknown[]),
    updateRunStatus: vi.fn(),
    resetRunningToFailure: vi.fn(() => 0),
}))
vi.mock('@/main/scheduler/ScheduleRepository', () => ({scheduleRepo: scheduleRepoStub}))

import {schedulerManager} from '@/main/scheduler'
import type {ScheduleRecord} from '@shared/types/schedule'

const MEMORY_ID = 'sys-memory-accumulation'

/** 系统内置任务：workspaceId 为 null 是合法的（守卫旁路），故本文件不需要工作区夹具 */
function recordOf(overrides: Partial<ScheduleRecord>): ScheduleRecord {
    return {
        id: MEMORY_ID, name: '记忆沉淀', description: '', cronExpression: '0 */2 * * *',
        taskType: 'agent', taskTarget: 'General', taskArgs: ['prompt'],
        enabled: true, paused: false, pausedAt: null,
        lastRunAt: null, lastRunStatus: 'none', lastRunConversationId: null,
        runCount: 0, createdAt: 1, updatedAt: 1, workspaceId: null, isSystem: true,
        ...overrides,
    }
}

type FakeWorkerInstance = {
    posted: unknown[]
    handlers: Record<string, (arg: unknown) => void>
}

/**
 * 起一次假 worker（不调 init()，避免残留状态复位等无关流程），返回它与出站消息处理器。
 * cron 到点路径由此真实触达：worker 的 message 处理器即 executeSchedule 的 cron 入口。
 */
function spawnFakeWorker(): {worker: FakeWorkerInstance; fire(message: unknown): void} {
    ;(schedulerManager as unknown as {spawnCronWorker(): void}).spawnCronWorker()
    const worker = (schedulerManager as unknown as {worker: FakeWorkerInstance}).worker
    return {worker, fire: (message: unknown) => worker.handlers.message(message)}
}

beforeEach(() => {
    vi.clearAllMocks()
    scheduleRepoStub.listEnabled.mockReturnValue([])
    probeStub.hasPendingConversations.mockReturnValue(true)
})

afterEach(() => {
    ;(schedulerManager as unknown as {worker: unknown}).worker = null
})

describe('记忆沉淀前置探针 — 接入点（cron 到点路径）', () => {
    it('cron + 探针 false → 不建会话、不启动 agent、不写运行状态、无 execute.start', async () => {
        scheduleRepoStub.get.mockReturnValue(recordOf({}))
        probeStub.hasPendingConversations.mockReturnValue(false)

        const {fire} = spawnFakeWorker()
        fire({type: 'task_fire', scheduleId: MEMORY_ID, taskType: 'agent', taskTarget: 'General', taskArgs: ['prompt']})

        // 以短路日志为「本轮已走完」的观察点（executeSchedule 的 promise 未回传给测试）
        await vi.waitFor(() => {
            expect(loggerStub.info).toHaveBeenCalledWith(
                'execute.skipped',
                expect.objectContaining({source: 'cron', scheduleId: MEMORY_ID, reason: 'no-pending-conversations'}),
            )
        })

        expect(probeStub.hasPendingConversations).toHaveBeenCalledTimes(1)
        expect(convRepoStub.create).not.toHaveBeenCalled()
        expect(startAgentCoreStub).not.toHaveBeenCalled()
        // 跳过既非成功也非失败：不写 running，也不写 success
        expect(scheduleRepoStub.updateRunStatus).not.toHaveBeenCalled()
        // 也不该有「本次执行开始」的记账日志
        expect(loggerStub.info).not.toHaveBeenCalledWith('execute.start', expect.anything())
    })

    it('cron + 探针 true → 走原路径：建会话 + startAgentCore + 状态落库', async () => {
        scheduleRepoStub.get.mockReturnValue(recordOf({}))
        probeStub.hasPendingConversations.mockReturnValue(true)

        const {fire} = spawnFakeWorker()
        fire({type: 'task_fire', scheduleId: MEMORY_ID, taskType: 'agent', taskTarget: 'General', taskArgs: ['prompt']})

        await vi.waitFor(() => {
            expect(scheduleRepoStub.updateRunStatus).toHaveBeenCalledTimes(2)
        })
        expect(convRepoStub.create).toHaveBeenCalledTimes(1)
        expect(startAgentCoreStub).toHaveBeenCalledTimes(1)
        expect(scheduleRepoStub.updateRunStatus.mock.calls.map(c => c[1])).toEqual(['running', 'success'])
        expect(loggerStub.info).toHaveBeenCalledWith(
            'execute.start',
            expect.objectContaining({source: 'cron', scheduleId: MEMORY_ID}),
        )
    })

    it('cron + 其他 scheduleId + 探针 false → 不受影响，走原路径', async () => {
        scheduleRepoStub.get.mockReturnValue(recordOf({id: 'sched-other', name: '别的任务'}))
        probeStub.hasPendingConversations.mockReturnValue(false)

        const {fire} = spawnFakeWorker()
        fire({type: 'task_fire', scheduleId: 'sched-other', taskType: 'agent', taskTarget: 'General', taskArgs: ['prompt']})

        await vi.waitFor(() => {
            expect(scheduleRepoStub.updateRunStatus).toHaveBeenCalledTimes(2)
        })
        expect(convRepoStub.create).toHaveBeenCalledTimes(1)
        expect(startAgentCoreStub).toHaveBeenCalledTimes(1)
        expect(scheduleRepoStub.updateRunStatus.mock.calls.map(c => c[1])).toEqual(['running', 'success'])
    })
})

describe('记忆沉淀前置探针 — 接入点（手动立即执行路径）', () => {
    it('手动（runNow）+ 探针 false → 仍然走原路径，且探针根本不被查询', async () => {
        scheduleRepoStub.get.mockReturnValue(recordOf({}))
        probeStub.hasPendingConversations.mockReturnValue(false)

        const result = await schedulerManager.runNow(MEMORY_ID)

        expect(result.success).toBe(true)
        expect(convRepoStub.create).toHaveBeenCalledTimes(1)
        expect(startAgentCoreStub).toHaveBeenCalledTimes(1)
        expect(scheduleRepoStub.updateRunStatus.mock.calls.map(c => c[1])).toEqual(['running', 'success'])
        // 手动路径连探针都不该查（省掉一次无谓 SQL）：短路判定须先判来源再判探针
        expect(probeStub.hasPendingConversations).not.toHaveBeenCalled()
    })
})
