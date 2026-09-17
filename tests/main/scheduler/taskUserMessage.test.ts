/**
 * 调度任务 user 消息拼接：能力名与正文之间必须是**换行**，不是空格。
 *
 * 症状：`task_args[0]` 常以 Markdown 标题（`## 任务目标`）开头，空格拼接会得到
 * `/General ## 任务目标\n…` —— 标题被并进第一行（与用户截图逐字一致）。
 * 修复后为 `/General\n## 任务目标\n…`。
 *
 * 观察点：`executeSchedule` 交给 `startAgentCore` 的 `message`（落库 user 消息的源头），
 * 以及 prompt 为空时的产物不含尾随空白。
 *
 * 隔离手法沿用 fireSourceAndScriptAttribution.test.ts：config 指临时目录、假 worker、
 * 假 sqlite 仓储、假 startAgentCore；不触碰真实数据库与真实工作区。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'

vi.mock('@/main/config', () => {
    const os = require('os')
    const pathMod = require('path')
    const testDir = pathMod.join(os.tmpdir(), 'hclaw-test-usermsg-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
        getHclawDataDir: () => pathMod.join(testDir, 'data'),
    }
})
vi.mock('@/main/hclawPaths', async () => await import('@/main/config'))  // 路径能力已下沉到叶子 hclawPaths：让叶子跟随本文件对 config 的桩，避免绕过 mock 落到真实 ~/.hclaw

/** worker_threads 的假实现：不真的起线程（本文件不考 worker，只借它避免真实线程副作用） */
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

vi.mock('child_process', () => ({
    exec: (_cmd: string, _opts: unknown, cb: (err: Error | null, res?: {stdout: string; stderr: string}) => void) => {
        cb(null, {stdout: 'OUT', stderr: ''})
    },
}))

const loggerStub = vi.hoisted(() => ({info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn()}))
vi.mock('@/main/agent/logger', () => ({createLogger: () => loggerStub}))

/** 观察点：startAgentCore 收到的 message 就是本次任务的 user 消息 */
const startAgentCoreStub = vi.hoisted(() => vi.fn(
    async (_params: {conversationId: string; message: string}, _origin?: string) => undefined,
))
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
    list: vi.fn(() => [] as unknown[]),
    listEnabled: vi.fn(() => [] as unknown[]),
    updateRunStatus: vi.fn(),
    update: vi.fn(),
    resetRunningToFailure: vi.fn(() => 0),
}))
vi.mock('@/main/scheduler/ScheduleRepository', () => ({scheduleRepo: scheduleRepoStub}))

/** 工作目录是执行前置条件（本文件的用例都不在考它）：挂在真实存在的临时目录上 */
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

vi.mock('electron', () => ({
    BrowserWindow: {getAllWindows: () => []},
    ipcMain: {handle: vi.fn()},
    app: {isPackaged: false, getPath: () => ''},
}))

import {schedulerManager} from '@/main/scheduler'
import type {ScheduleRecord} from '@shared/types/schedule'

function recordOf(overrides: Partial<ScheduleRecord>): ScheduleRecord {
    return {
        id: 'sched-x', name: '任务', description: '', cronExpression: '0 9 * * *',
        taskType: 'agent', taskTarget: 't', taskArgs: [], enabled: true, paused: false,
        pausedAt: null, lastRunAt: null, lastRunStatus: 'none', lastRunConversationId: null,
        runCount: 0, createdAt: 1, updatedAt: 1, workspaceId: 'ws-fixture',
        ...overrides,
    }
}

/** 跑一次 agent 任务，返回交给 startAgentCore 的 user 消息内容 */
async function runAgentTask(taskTarget: string, taskArgs: any[]): Promise<string> {
    scheduleRepoStub.get.mockReturnValue(recordOf({id: 'sched-msg', taskType: 'agent', taskTarget, taskArgs}))
    const run = (schedulerManager as unknown as {
        executeSchedule(m: unknown): Promise<{success: boolean; error?: string}>
    }).executeSchedule.bind(schedulerManager)
    await run({scheduleId: 'sched-msg', taskType: 'agent', taskTarget, taskArgs, source: 'cron'})
    const call = startAgentCoreStub.mock.calls[0]?.[0] as {message: string} | undefined
    if (!call) throw new Error('startAgentCore 未被调用')
    return call.message
}

beforeEach(() => {
    vi.clearAllMocks()
    scheduleRepoStub.get.mockReturnValue(recordOf({id: 'sched-msg'}))
})

afterEach(() => {
    ;(schedulerManager as unknown as {worker: unknown}).worker = null
})

describe('scheduler.buildUserMessage：换行分隔（能力名 / 正文）', () => {
    it('正文以 Markdown 标题开头时，标题自成一行的下一行，不被并进第一行', async () => {
        const prompt = '## 任务目标\n将 HClaw 对话记录同步为 Obsidian 工作日志，按工作目录+日期分组，补充缺失的日志。\n\n## 步骤\n1. 读取'
        const msg = await runAgentTask('General', [prompt])

        expect(msg).toBe('/General\n## 任务目标\n将 HClaw 对话记录同步为 Obsidian 工作日志，按工作目录+日期分组，补充缺失的日志。\n\n## 步骤\n1. 读取')
        // 反例：空格形式必须不再出现（旧实现即此产物，与用户截图逐字一致）
        expect(msg.startsWith('/General ##')).toBe(false)
        expect(msg.split('\n')[0]).toBe('/General')
    })

    it('单行正文同样用换行分隔', async () => {
        expect(await runAgentTask('General', ['同步工作日志'])).toBe('/General\n同步工作日志')
    })

    it('正文前后的空白被 trim，分隔符仍是单个换行', async () => {
        expect(await runAgentTask('General', ['  \n## 步骤\n  '])).toBe('/General\n## 步骤')
    })

    it.each([
        ['空数组', []],
        ['args[0] 为空串', ['']],
        ['args[0] 全是空白', ['   \n  ']],
        ['args[0] 非字符串', [{foo: 'bar'}]],
    ])('%s → 只留下 /能力，无尾随空白', async (_label, args) => {
        const msg = await runAgentTask('General', args as any[])
        expect(msg).toBe('/General')
        expect(msg).not.toMatch(/\s$/)
    })
})
