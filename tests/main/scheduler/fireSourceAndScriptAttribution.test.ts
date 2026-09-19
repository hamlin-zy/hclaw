/**
 * 票 05 — 执行路径修正：触发来源与脚本归属
 *
 * 三条可观察行为被钉住（seam 沿用 pauseResumeWiring.test.ts：假 worker 捕获出站消息）：
 *   1. 触发来源：手动立即执行记 'manual' 且不向引擎发 ack；cron 到点记 'cron' 并发 ack。
 *   2. 脚本日志归属：并发两个脚本任务时，各自日志落在各自的 scheduleId 前缀下、内容也是自己的。
 *   3. 脚本执行参数面：runScript 不再接收从未使用的会话参数（编译期由 signature 钉住）。
 *
 * 另附一条「反例」用例（末尾 describe）：直接驱动 SchedulerEngine，验证即便收到一次
 * 手动路径式的 ack，也不会让本轮重复触发、下一轮跳票 —— 用于如实说明「手动 ack 会
 * 让定时跳票」这一说法在 4c1ee39 的实现里并不成立。
 *
 * 隔离：config 指向临时目录；不调 init()，worker 由 worker_threads 的假实现接管；
 * child_process.spawn 用可手动放行的桩，令两个脚本执行真正处于并发在途状态。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

vi.mock('@/main/config', () => {
    const os = require('os')
    const pathMod = require('path')
    const testDir = pathMod.join(os.tmpdir(), 'hclaw-test-core05-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
        getHclawDataDir: () => pathMod.join(testDir, 'data'),
    }
})
vi.mock('@/main/hclawPaths', async () => await import('@/main/config'))  // 路径能力已下沉到叶子 hclawPaths：让叶子跟随本文件对 config 的桩，避免绕过 mock 落到真实 ~/.hclaw

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

/**
 * child_process.spawn 的桩：不真的起进程，把「输出 + 退出」的放行权交给测试。
 *
 * 脚本任务由 runScript 显式持有 child（内存泄漏 B 批 Task 1 起改为树杀收尾），
 * 故桩返回一个假 child：pid 固定，stdout/stderr 是事件源。
 */
const spawnCalls = vi.hoisted(() => [] as Array<{cmd: string; release: (ok: boolean) => void}>)
vi.mock('child_process', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.mock 工厂被提升，无法用 ESM import
    const {EventEmitter} = require('events') as typeof import('events')
    return {
        spawn: (cmd: string) => {
            const child = new EventEmitter() as InstanceType<typeof EventEmitter> & {pid: number; stdout: InstanceType<typeof EventEmitter>; stderr: InstanceType<typeof EventEmitter>}
            child.pid = 4242
            child.stdout = new EventEmitter()
            child.stderr = new EventEmitter()
            spawnCalls.push({
                cmd,
                release: (ok: boolean) => {
                    child.stdout.emit('data', Buffer.from('OUT:' + cmd))
                    child.emit('close', ok ? 0 : 1)
                },
            })
            return child
        },
    }
})

const loggerStub = vi.hoisted(() => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
}))
vi.mock('@/main/agent/logger', () => ({createLogger: () => loggerStub}))

vi.mock('@/main/agent/startAgentCore', () => ({startAgentCore: vi.fn(async () => undefined)}))

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

/**
 * 工作区记录：票 11 起「工作目录可用」是执行的前置条件（本文件的用例都不在考它），
 * 故给每条记录配一个真实存在的工作区（用系统临时目录，绝不打桩成「fake 但存在」的东西）。
 */
vi.mock('@/main/repositories/sqlite/workspaceRepository', () => ({
    SqliteWorkspaceRepository: class {
        getById(id: string) {
            return id === 'ws-fixture' ? {id, path: require('os').tmpdir(), name: 'fixture'} : null
        }
        /** 窄出口（工作区守卫消费）：夹具里没有故障，只报 ok / missing */
        tryGetById(id: string) {
            const found = id === 'ws-fixture' ? {id, path: require('os').tmpdir(), name: 'fixture'} : null
            return found ? {kind: 'ok', workspace: found} : {kind: 'missing'}
        }
        tryList() { return {kind: 'ok', workspaces: []} }
    },
}))

import {schedulerManager} from '@/main/scheduler'
import {SchedulerEngine} from '@/main/scheduler/SchedulerEngine'
import {getHclawDir} from '@/main/config'
import type {
    ScheduleRecord,
    SchedulerEngineOutboundMessage,
    SchedulerEngineSchedule,
} from '@shared/types/schedule'

const scriptLogDir = () => path.join(getHclawDir(), 'logs', 'schedules')

function recordOf(overrides: Partial<ScheduleRecord>): ScheduleRecord {
    return {
        id: 'sched-x', name: '任务', description: '', cronExpression: '0 9 * * *',
        taskType: 'agent', taskTarget: 't', taskArgs: [], enabled: true, paused: false,
        pausedAt: null, lastRunAt: null, lastRunStatus: 'none', lastRunConversationId: null,
        runCount: 0, createdAt: 1, updatedAt: 1, isSystem: false,
        // 票 11 起工作目录不可用即拦下执行：本文件的用例只考触发来源与脚本归属，
        // 故统一挂在一个真实存在的目录上（见上面的 workspaceRepository 桩）。
        workspaceId: 'ws-fixture',
        ...overrides,
    }
}

type FakeWorkerInstance = {
    posted: unknown[]
    handlers: Record<string, (arg: unknown) => void>
}
type ManagerInternals = {spawnCronWorker(): void}

/** 起一次假 worker（不调 init()，避免残留状态复位等无关流程），返回它与出站消息处理器 */
function spawnFakeWorker(): {worker: FakeWorkerInstance; fire(message: unknown): void} {
    ;(schedulerManager as unknown as ManagerInternals).spawnCronWorker()
    const worker = (schedulerManager as unknown as {worker: FakeWorkerInstance}).worker
    return {worker, fire: (message: unknown) => worker.handlers.message(message)}
}

function acks(posted: unknown[]): unknown[] {
    return posted.filter(m => (m as {cmd?: string}).cmd === 'ack')
}

beforeEach(() => {
    vi.clearAllMocks()
    scheduleRepoStub.listEnabled.mockReturnValue([])
    spawnCalls.length = 0
})

afterEach(() => {
    // 假 worker 无资源需要回收；真 worker 从未启动
    ;(schedulerManager as unknown as {worker: unknown}).worker = null
})

describe('票 05 — 触发来源（source）', () => {
    it('手动立即执行记 manual，且不向 cron 引擎发送 ack（不动引擎的去重状态）', async () => {
        scheduleRepoStub.get.mockReturnValue(recordOf({id: 'sched-manual', taskType: 'agent'}))
        const {worker} = spawnFakeWorker()

        const result = await schedulerManager.runNow('sched-manual')

        expect(result.success).toBe(true)
        expect(acks(worker.posted)).toEqual([])
        expect(loggerStub.info).toHaveBeenCalledWith(
            'execute.start',
            expect.objectContaining({source: 'manual', scheduleId: 'sched-manual'}),
        )
    })

    it('cron 到点触发记 cron，并向引擎发送 ack（认领本轮触发）', async () => {
        scheduleRepoStub.get.mockReturnValue(recordOf({id: 'sched-cron', taskType: 'agent'}))
        const {worker, fire} = spawnFakeWorker()

        fire({type: 'task_fire', scheduleId: 'sched-cron', taskType: 'agent', taskTarget: 't', taskArgs: []})
        await vi.waitFor(() => {
            expect(acks(worker.posted)).toEqual([{cmd: 'ack', scheduleId: 'sched-cron'}])
        })
        expect(loggerStub.info).toHaveBeenCalledWith(
            'execute.start',
            expect.objectContaining({source: 'cron', scheduleId: 'sched-cron'}),
        )
    })
})

describe('票 05 — 脚本日志归属', () => {
    it('并发执行两个脚本任务，各自日志挂在各自 scheduleId 名下且内容为自己那次', async () => {
        scheduleRepoStub.get.mockImplementation((id: string) =>
            recordOf({id, taskType: 'script', taskTarget: `pkg-${id}.js`}))
        const {fire} = spawnFakeWorker()

        fire({type: 'task_fire', scheduleId: 'script-a', taskType: 'script', taskTarget: 'pkg-script-a.js', taskArgs: []})
        fire({type: 'task_fire', scheduleId: 'script-b', taskType: 'script', taskTarget: 'pkg-script-b.js', taskArgs: []})
        // 两次 spawn 都已发起 ⇒ 两个脚本任务确实同时在途（归属推断正是在此处取首元素）
        expect(spawnCalls).toHaveLength(2)

        for (const call of spawnCalls) call.release(true)

        await vi.waitFor(() => {
            const files = fs.readdirSync(scriptLogDir())
            expect(files.filter(f => f.startsWith('script-a-'))).toHaveLength(1)
            expect(files.filter(f => f.startsWith('script-b-'))).toHaveLength(1)
        })

        const files = fs.readdirSync(scriptLogDir())
        const logOfB = fs.readFileSync(
            path.join(scriptLogDir(), files.find(f => f.startsWith('script-b-'))!),
            'utf-8',
        )
        expect(logOfB).toContain('Command: pkg-script-b.js')
    })
})

/**
 * 反例（证据）用例：手动路径过去对引擎的唯一动作是发 ack，而 ack 清的是引擎的
 * 「待确认」去重层（pendingFires），不是分钟级去重层（lastFiredMinute）。
 * 因此即便收到一次手动式 ack，本轮仍不会重复触发、下一轮也不会跳票。
 */
describe('票 05 — cron 引擎去重状态：手动式 ack 是否真会让定时跳票', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-01-01T00:00:30Z'))
    })
    afterEach(() => { vi.useRealTimers() })

    it('到点触发后收到手动式 ack：本轮不重复触发，下一轮照常触发', () => {
        const messages: SchedulerEngineOutboundMessage[] = []
        const engine = new SchedulerEngine({
            postMessage: (m: SchedulerEngineOutboundMessage) => { messages.push(m) },
            close: () => undefined,
        })
        const schedule: SchedulerEngineSchedule = {
            id: 'sched-1', cronExpression: '* * * * *', taskType: 'agent',
            taskTarget: 't', taskArgs: [], enabled: true, paused: false,
        }
        const fires = () => messages.filter(m => m.type === 'task_fire')

        engine.handleMessage({cmd: 'init', schedules: [schedule]})
        vi.advanceTimersByTime(1000)
        expect(fires()).toHaveLength(1)

        // 手动路径过去唯一会对引擎做的事
        engine.handleMessage({cmd: 'ack', scheduleId: 'sched-1'})
        vi.advanceTimersByTime(1000)
        expect(fires()).toHaveLength(1) // 本分钟不重复（分钟级层独立挡住）

        vi.advanceTimersByTime(60_000)
        expect(fires()).toHaveLength(2) // 下一轮不跳票

        engine.shutdown()
    })
})
