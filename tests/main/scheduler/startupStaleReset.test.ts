/**
 * 启动复位 — SchedulerManager.init()
 *
 * 覆盖工单 core-07：
 * 1. 配置表里残留的 last_run_status='running' 在启动时被复位为 'failure'
 * 2. none / success / failure 不受影响
 * 3. 与既有的会话状态复位（channel='schedule' 的 running 会话 → active）互不干扰
 * 4. 复位条数有日志上报；仓储失败时留痕而不是静默吞掉
 *
 * SQLite 策略（与 ScheduleRepository.test.ts 一致）：vi.mock config 重定向到
 * os.tmpdir() 独立临时目录，走真实 SQLite + 真实 ScheduleRepository，不 mock 仓储。
 * worker_threads 被替换为空壳，使 init() 不真的起线程（复位逻辑与之无关）。
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'
import * as os from 'os'
import * as path from 'path'

// 隔离：重定向到 os.tmpdir() 下的独立临时目录，绝不触碰真实 ~/.hclaw/data/hclaw.db
vi.mock('@/main/config', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.mock 工厂被提升，不能引用文件级 const
    const os = require('os')
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- 同上
    const path = require('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-startup-reset-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
    }
})
vi.mock('@/main/hclawPaths', async () => await import('@/main/config'))  // 路径能力已下沉到叶子 hclawPaths：让叶子跟随本文件对 config 的桩，避免绕过 mock 落到真实 ~/.hclaw

/** cron worker 与本票无关：替换为空壳，避免 init() 真的起线程 */
vi.mock('worker_threads', () => ({
    Worker: class {
        on(): this { return this }
        postMessage(): void { /* noop */ }
        // sqlite 的 checkpoint worker 会在 closeDatabase 时 terminate().catch()，
        // 空壳仍须返回 Promise，否则会污染用例收尾
        terminate(): Promise<number> { return Promise.resolve(0) }
    },
}))

/** 捕获启动复位的日志上报（票据要求「复位要能上报」） */
const loggerSpies = vi.hoisted(() => ({debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}))
vi.mock('@/main/agent/logger', () => ({
    createLogger: () => loggerSpies,
    logger: loggerSpies,
}))

import {initStorage, createConversationRepository} from '@/main/repositories'
import {closeDatabase, getDatabase} from '@/main/repositories/sqlite'
import {scheduleRepo} from '@/main/scheduler/ScheduleRepository'
import {schedulerManager} from '@/main/scheduler'
import type {ScheduleRecord} from '@shared/types/schedule'
import type {ConversationMeta} from '@shared/types'

function newSchedule(id: string): ScheduleRecord {
    return {
        id, name: `任务-${id}`, description: '', cronExpression: '*/5 * * * *',
        taskType: 'agent', taskTarget: '巡检', taskArgs: [], enabled: true, paused: false,
        pausedAt: null, lastRunAt: null, lastRunStatus: 'none', lastRunConversationId: null,
        runCount: 0, createdAt: Date.now(), updatedAt: Date.now(), workspaceId: null, isSystem: false,
    }
}

/** 建一条记录并把它写进指定运行状态 */
function seed(id: string, status: ScheduleRecord['lastRunStatus']): void {
    scheduleRepo.create(newSchedule(id))
    if (status !== 'none') scheduleRepo.updateRunStatus(id, status)
}

function seedConversation(id: string, channel: string, status: ConversationMeta['status']): void {
    const meta: ConversationMeta = {
        id, title: id, workspacePath: '/tmp/ws', createdAt: Date.now(), updatedAt: Date.now(),
        preview: '', status, channel, sessionType: channel === 'schedule' ? 'scheduler' : 'user',
    }
    // 与 SchedulerManager 共用同一个库：另建实例只做种子数据
    createConversationRepository().create(id, meta)
}

/** 直接读表，避免依赖被断言的仓储方法自身 */
function statusOf(id: string): string {
    const row = getDatabase().prepare('SELECT last_run_status FROM schedules WHERE id = ?').get(id) as any
    return row?.last_run_status
}

function clearTables(): void {
    getDatabase().prepare('DELETE FROM schedules').run()
    getDatabase().prepare('DELETE FROM conversations').run()
}

describe('SchedulerManager — 启动复位残留的 running', () => {
    beforeEach(() => {
        initStorage()
        clearTables()
        for (const spy of Object.values(loggerSpies)) spy.mockClear()
    })

    afterEach(() => {
        closeDatabase()
    })

    it('init() 只把 running 复位为 failure，none/success/failure 不变', () => {
        seed('s-run', 'running')
        seed('s-none', 'none')
        seed('s-success', 'success')
        seed('s-failure', 'failure')

        schedulerManager.init()

        expect(statusOf('s-run')).toBe('failure')
        expect(statusOf('s-none')).toBe('none')
        expect(statusOf('s-success')).toBe('success')
        expect(statusOf('s-failure')).toBe('failure')
    })

    it('复位条数写入日志（info），无残留时不打扰', () => {
        seed('s-run-1', 'running')
        seed('s-run-2', 'running')

        schedulerManager.init()

        expect(loggerSpies.info).toHaveBeenCalledWith(
            expect.stringContaining('2 schedules reset from running to failure'),
        )

        loggerSpies.info.mockClear()
        // 第二次启动：已无残留，不应再上报条数
        schedulerManager.init()
        const messages = loggerSpies.info.mock.calls.map(c => String(c[0]))
        expect(messages.some(m => m.includes('schedules reset from running to failure'))).toBe(false)
        expect(statusOf('s-run-1')).toBe('failure')
    })

    it('与会话复位互不干扰：调度会话 running→active，非调度会话不动', () => {
        seed('s-run', 'running')
        seedConversation('conv-sched-running', 'schedule', 'running')
        seedConversation('conv-sched-active', 'schedule', 'active')
        seedConversation('conv-other-running', 'web', 'running')

        schedulerManager.init()

        // 配置表复位
        expect(statusOf('s-run')).toBe('failure')
        // 会话复位（既有行为）：只有 channel='schedule' 且 running 的那条变 active
        const convStatus = (id: string) => createConversationRepository().readMeta(id)?.status
        expect(convStatus('conv-sched-running')).toBe('active')
        expect(convStatus('conv-sched-active')).toBe('active')
        expect(convStatus('conv-other-running')).toBe('running')
    })

    it('仓储抛错时留痕（error 日志），不中断启动', () => {
        seed('s-run', 'running')
        const spy = vi.spyOn(schedulerManager.scheduleRepo, 'resetRunningToFailure')
            .mockImplementation(() => { throw new Error('database is closed') })

        expect(() => schedulerManager.init()).not.toThrow()
        expect(loggerSpies.error).toHaveBeenCalledWith(
            expect.stringContaining('resetInterruptedRunStatus failed'),
            expect.objectContaining({error: 'database is closed'}),
        )

        spy.mockRestore()
        // init 之后仍可用：错误没有污染实例状态
        schedulerManager.resetInterruptedRunStatus()
        expect(statusOf('s-run')).toBe('failure')
    })
})
