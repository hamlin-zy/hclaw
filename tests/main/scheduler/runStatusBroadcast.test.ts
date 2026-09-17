/**
 * 运行状态变化 → 广播 `updated`（ui-05）
 *
 * 背景：`updateRunStatusSafe` 把「运行中 / 成功 / 失败」写进记录，但运行状态**从不广播**，
 * 渲染层只能靠整表重取兜底 ——「立即执行 → 运行中 → 成功/失败」与「停止」都会把列表换成
 * loading 态并重置滚动位置（违反设计契约 M4）。本票在写库成功后读回记录并广播。
 *
 * 广播出口走**注入的钩子** `manager.onRecordUpdated`（由 initScheduleIPC 注入
 * broadcastSchedulesChanged，见 scheduleIPC.ts）：manager 自己位于 Agent Worker 的静态
 * 依赖闭包内，不得静态引入 electron。本文件钉住：
 *   1. 写库成功后广播 {type:'updated', record}（经真实 broadcastSchedulesChanged → 所有窗口）
 *   2. 读不回记录（已被删除）→ 不广播、不抛
 *   3. 写库失败 → 不广播（状态没变，没有「变化」可广播）、不抛
 *   4. 注入点确实把广播出口接到 manager 上（否则第 1 条只是自说自话）
 *
 * 隔离：config 指向临时目录，不触碰真实 ~/.hclaw；不调 init()，不真的起 worker。
 */
import {describe, expect, it, vi, beforeEach} from 'vitest'
import * as path from 'path'
import * as fs from 'fs'

vi.mock('@/main/config', () => {
    const os = require('os')
    const path = require('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-runstatus-broadcast-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
    }
})
vi.mock('@/main/hclawPaths', async () => await import('@/main/config'))  // 路径能力已下沉到叶子 hclawPaths：让叶子跟随本文件对 config 的桩，避免绕过 mock 落到真实 ~/.hclaw

/** 假窗口：捕获 `schedules-changed` 载荷 */
const sent: Array<{channel: string; payload: unknown}> = []
const handlers = new Map<string, (e: unknown, ...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
    ipcMain: {handle: (ch: string, fn: (e: unknown, ...args: unknown[]) => unknown) => { handlers.set(ch, fn) }},
    app: {isPackaged: false, getPath: () => ''},
    BrowserWindow: {
        getAllWindows: () => [{
            isDestroyed: () => false,
            webContents: {send: (channel: string, payload: unknown) => { sent.push({channel, payload}) }},
        }],
    },
}))

import {schedulerManager} from '@/main/scheduler'
import {initScheduleIPC} from '@/main/scheduler/scheduleIPC'
import type {ScheduleRecord} from '@shared/types/schedule'

function makeRecord(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
    return {
        id: 'sched-1', name: '任务', description: '', cronExpression: '0 9 * * *',
        taskType: 'agent', taskTarget: 't', taskArgs: [], enabled: true, paused: false,
        pausedAt: null, lastRunAt: null, lastRunStatus: 'none', lastRunConversationId: null,
        runCount: 0, createdAt: 1, updatedAt: 1, workspaceId: null,
        ...overrides,
    }
}

/**
 * 把仓储换成桩；返回还原函数与写入记录。
 * `get` 返回的是**写后读回**的记录（生产路径：updateRunStatus 落库 → get 读回）。
 */
function stubRepo(opts: {
    record?: ScheduleRecord | null
    updateThrows?: boolean
    getThrows?: boolean
}): {writes: Array<{id: string; status: string}>; restore: () => void} {
    const writes: Array<{id: string; status: string}> = []
    const original = schedulerManager.scheduleRepo
    const stored = opts.record === undefined ? makeRecord() : opts.record
    schedulerManager.scheduleRepo = {
        updateRunStatus: (id: string, status: string) => {
            if (opts.updateThrows) throw new Error('db closed')
            writes.push({id, status})
            if (stored) stored.lastRunStatus = status as ScheduleRecord['lastRunStatus']
        },
        get: () => {
            if (opts.getThrows) throw new Error('read failed')
            return stored ? {...stored} : null
        },
        list: () => [], listEnabled: () => [], create: () => {}, update: () => {}, delete: () => {},
    } as unknown as typeof schedulerManager.scheduleRepo
    return {writes, restore: () => { schedulerManager.scheduleRepo = original }}
}

beforeEach(() => {
    sent.length = 0
    // 生产路径：主进程启动时 initScheduleIPC() 把广播出口注入 manager
    initScheduleIPC()
})

describe('运行状态变化 → 就地更新那一行（M4）', () => {
    it('注入点把广播出口接到了 manager 上（否则下面的用例只是自说自话）', () => {
        expect(typeof schedulerManager.onRecordUpdated).toBe('function')
        schedulerManager.onRecordUpdated!({
            id: 'x', name: 'n', lastRunStatus: 'running',
        } as ScheduleRecord)
        expect(sent).toEqual([{
            channel: 'schedules-changed',
            payload: {type: 'updated', record: {id: 'x', name: 'n', lastRunStatus: 'running'}},
        }])
    })

    it('stop() 写库成功后读回记录并广播 {type:"updated", record}', () => {
        const {writes, restore} = stubRepo({record: makeRecord()})
        try {
            schedulerManager.stop('sched-1')
        } finally { restore() }

        expect(writes).toEqual([{id: 'sched-1', status: 'failure'}])
        expect(sent).toEqual([{
            channel: 'schedules-changed',
            payload: {type: 'updated', record: makeRecord({lastRunStatus: 'failure'})},
        }])
    })

    it('记录已被删除（get 读不回）→ 不广播，也不抛', () => {
        const {restore} = stubRepo({record: null})
        try {
            expect(() => schedulerManager.stop('sched-1')).not.toThrow()
        } finally { restore() }
        expect(sent).toEqual([])
    })

    it('写库失败 → 不广播（状态没变，没有「变化」可宣告），也不抛给调用方', () => {
        const {restore} = stubRepo({updateThrows: true})
        try {
            expect(() => schedulerManager.stop('sched-1')).not.toThrow()
        } finally { restore() }
        expect(sent).toEqual([])
    })

    it('写库成功但读回抛异常 → 不抛给调用方（best-effort）', () => {
        const {restore} = stubRepo({getThrows: true})
        try {
            expect(() => schedulerManager.stop('sched-1')).not.toThrow()
        } finally { restore() }
        expect(sent).toEqual([])
    })

    it('广播钩子未注入（onRecordUpdated=null）→ 状态照常落库、不抛，但留一次 warn（不再静默失效）', () => {
        // 复核探针 [D4]：钩子缺失时原先 `sent=[]` 且无异常、无日志、无断言失败 —— 完全无声。
        const {writes, restore} = stubRepo({record: makeRecord()})
        const original = schedulerManager.onRecordUpdated
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        try {
            schedulerManager.onRecordUpdated = null
            expect(() => schedulerManager.stop('sched-1')).not.toThrow()
            // 状态照常写入，只是没有「变化」被广播出去
            expect(writes).toEqual([{id: 'sched-1', status: 'failure'}])
            expect(sent).toEqual([])
            const hits = warn.mock.calls.filter(c => String(c[0]).includes('onRecordUpdated not injected'))
            expect(hits).toHaveLength(1)
            // 一次性：再写一次也不会重复刷屏
            schedulerManager.stop('sched-1')
            expect(warn.mock.calls.filter(c => String(c[0]).includes('onRecordUpdated not injected'))).toHaveLength(1)
        } finally {
            warn.mockRestore()
            schedulerManager.onRecordUpdated = original
            restore()
        }
    })
})

describe('静态契约：不得把 electron 静态拉进 worker 闭包', () => {
    const readSrc = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf-8')

    it('index.ts 不引入 scheduleBroadcast / electron，只暴露注入点', () => {
        const src = readSrc('src/main/scheduler/index.ts')
        // 只看真实 import 语句（注释里为说明理由会提到这两个模块名）
        expect(src).not.toMatch(/^\s*import[^\n]*from '\.\/scheduleBroadcast'/m)
        expect(src).not.toMatch(/^\s*import[^\n]*from 'electron'/m)
        expect(src).toMatch(/onRecordUpdated/)
    })

    it('广播出口由 scheduleIPC（非 worker 闭包）注入，用的是唯一出口 broadcastSchedulesChanged', () => {
        const src = readSrc('src/main/scheduler/scheduleIPC.ts')
        expect(src).toMatch(/from '\.\/scheduleBroadcast'/)
        expect(src).toMatch(/onRecordUpdated = \(record\) => broadcastSchedulesChanged\(\{type: 'updated', record\}\)/)
    })
})
