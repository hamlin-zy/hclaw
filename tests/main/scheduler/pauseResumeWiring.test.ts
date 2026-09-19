/**
 * SchedulerManager 的暂停/恢复是否真的把消息发给了 cron 引擎
 *
 * 暂停「真的不再触发」这件事分三段被钉住：
 *   1. IPC 通道 → scheduleOps（tests/main/scheduler/scheduleIPC.test.ts：断言 manager.pause 被调用）
 *   2. manager → 引擎（本文件：断言出站消息就是协议里的 {cmd:'pause'|'resume', id}）
 *   3. 引擎行为（tests/main/scheduler/SchedulerEngine.test.ts：暂停期间不触发、恢复后继续）
 *
 * 另有第 0 段，也是曾经断掉的那一环：**启动装载**。引擎的 resume 只清暂停位、重启 tick，
 * 不会凭空造出记录——若 spawnCronWorker 的 {cmd:'init'} 载荷里没有暂停记录，恢复即空转
 * （F1）。本文件末尾的 describe 用真实 SQLite + 假 worker 钉住「init 载荷含暂停记录」。
 *
 * 隔离：config 指向临时目录，避免触碰真实 ~/.hclaw。不调 init()，因此不会真的起 worker 线程；
 * 用桩替换私有 worker 字段只为捕获 postMessage（不改生产代码）。
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'
import * as os from 'os'
import * as path from 'path'

vi.mock('@/main/config', () => {
    const os = require('os')
    const path = require('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-pause-wiring-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
    }
})
vi.mock('@/main/hclawPaths', async () => await import('@/main/config'))  // 路径能力已下沉到叶子 hclawPaths：让叶子跟随本文件对 config 的桩，避免绕过 mock 落到真实 ~/.hclaw

/** worker_threads 的假实现：只为让 spawnCronWorker 能跑完，捕获出站消息，不真的起线程。
 *  terminate() 返回 Promise —— sqlite 的 checkpoint worker 也会走这个假 Worker（.terminate().catch）。 */
vi.mock('worker_threads', () => {
    class FakeWorker {
        static instances: FakeWorker[] = []
        readonly posted: unknown[] = []
        readonly handlers: Record<string, (arg: unknown) => void> = {}
        constructor() { FakeWorker.instances.push(this) }
        on(event: string, handler: (arg: unknown) => void): void { this.handlers[event] = handler }
        postMessage(msg: unknown): void { this.posted.push(msg) }
        terminate(): Promise<void> { return Promise.resolve() }
    }
    return {Worker: FakeWorker}
})

import {schedulerManager} from '@/main/scheduler'
import {scheduleRepo} from '@/main/scheduler/ScheduleRepository'
import {initStorage} from '@/main/repositories'
import {closeDatabase, getDatabase} from '@/main/repositories/sqlite'
import type {ScheduleRecord} from '@shared/types/schedule'

/** 把私有 worker 换成只记录出站消息的桩；返回还原函数与已发送消息数组 */
function stubWorker(): {posted: unknown[]; restore: () => void} {
    const posted: unknown[] = []
    const mutable = schedulerManager as unknown as {worker: unknown}
    const original = mutable.worker
    mutable.worker = {postMessage: (msg: unknown) => { posted.push(msg) }}
    return {posted, restore: () => { mutable.worker = original }}
}

describe('SchedulerManager — 暂停/恢复通知 cron 引擎', () => {
    it('pause() 发出 {cmd:"pause", id}', () => {
        const {posted, restore} = stubWorker()
        try {
            schedulerManager.pause('sched-1')
            expect(posted).toEqual([{cmd: 'pause', id: 'sched-1'}])
        } finally { restore() }
    })

    it('resume() 发出 {cmd:"resume", id}', () => {
        const {posted, restore} = stubWorker()
        try {
            schedulerManager.resume('sched-1')
            expect(posted).toEqual([{cmd: 'resume', id: 'sched-1'}])
        } finally { restore() }
    })

    it('worker 未起时不抛（暂停/恢复不依赖引擎在线）', () => {
        const mutable = schedulerManager as unknown as {worker: unknown}
        const original = mutable.worker
        mutable.worker = null
        try {
            expect(() => { schedulerManager.pause('sched-1'); schedulerManager.resume('sched-1') }).not.toThrow()
        } finally { mutable.worker = original }
    })
})

function makeRecord(overrides: Partial<ScheduleRecord>): ScheduleRecord {
    return {
        id: 'sched-x', name: '任务', description: '', cronExpression: '* * * * *',
        taskType: 'agent', taskTarget: 't', taskArgs: [], enabled: true, paused: false,
        pausedAt: null, lastRunAt: null, lastRunStatus: 'none', lastRunConversationId: null,
        runCount: 0, createdAt: 1, updatedAt: 1, workspaceId: null, isSystem: false,
        ...overrides,
    }
}

/** 起一次假 worker，返回它捕获的 outbound 消息（不调 init()，避免无关流程） */
function spawnFakeWorker(): {posted: unknown[]} {
    ;(schedulerManager as unknown as {spawnCronWorker(): void}).spawnCronWorker()
    return {posted: (schedulerManager as unknown as {worker: {posted: unknown[]}}).worker.posted}
}

describe('SchedulerManager — 启动装载（init 载荷）包含暂停记录', () => {
    beforeEach(() => {
        initStorage()
        getDatabase().exec('DELETE FROM schedules')
    })
    afterEach(() => {
        closeDatabase()
        ;(schedulerManager as unknown as {worker: unknown}).worker = null
    })

    it('暂停中的记录被打进 init 载荷，恢复后引擎才能按原表达式继续触发', () => {
        scheduleRepo.create(makeRecord({id: 'sched-on'}))
        scheduleRepo.create(makeRecord({id: 'sched-paused', paused: true, pausedAt: 1}))
        scheduleRepo.create(makeRecord({id: 'sched-disabled', enabled: false}))

        const {posted} = spawnFakeWorker()
        const init = posted.find(m => (m as {cmd?: string}).cmd === 'init') as
            {cmd: string; schedules: Array<{id: string; paused: boolean}>}

        expect(init).toBeDefined()
        expect(init.schedules.map(s => s.id).sort()).toEqual(['sched-on', 'sched-paused'])
        // 暂停态随记录一起交给引擎（引擎 init 据此进 pausedTasks），不是被丢掉
        expect(init.schedules.find(s => s.id === 'sched-paused')!.paused).toBe(true)
    })
})
