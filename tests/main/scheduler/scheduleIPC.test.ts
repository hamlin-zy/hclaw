/**
 * 定时任务 IPC 通道契约测试（本票主 seam）
 *
 * 模式照抄 tests/main/phrase/phraseIPC.test.ts 与 tests/main/memo/memoIPC.test.ts：
 * mock 掉 electron 的 ipcMain 捕获 handler 注册表 → 直接调用通道 → 断言返回形状与副作用。
 *
 * 断言三件事：
 * 1. 每个出口都是 {ok:true,data} | {ok:false,error}（不再有 {success} / 裸数组 / 裸字符串）
 * 2. 失败原因可判别（NOT_FOUND / INVALID_ARGUMENT / STORAGE_FAILURE → 可读字符串）
 * 3. 「停止一个不存在的任务」不再返回成功
 * 4. 变更广播带可区分载荷：新增 / 更新 带记录本体，删除只带 id（渲染层据此就地更新）
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'
import * as os from 'os'
import * as path from 'path'

type IpcHandler = (e: unknown, ...args: unknown[]) => unknown
const handlers = new Map<string, IpcHandler>()
const sent: string[] = []
/** 与 sent 同序：每次 webContents.send 的载荷（增量广播断言用） */
const sentChanges: unknown[] = []

vi.mock('electron', () => ({
    ipcMain: {handle: (ch: string, fn: IpcHandler) => { handlers.set(ch, fn) }},
    BrowserWindow: {getAllWindows: () => [{isDestroyed: () => false, webContents: {send: (ch: string, payload?: unknown) => { sent.push(ch); sentChanges.push(payload) }}}]},
}))

// 日志目录重定向到临时目录，避免触碰真实 ~/.hclaw
vi.mock('../../../src/main/config', () => ({
    getHclawDir: () => path.join(os.tmpdir(), 'hclaw-schedule-ipc-test'),
}))
vi.mock('../../../src/main/hclawPaths', async () => await import('../../../src/main/config'))  // 路径能力已下沉到叶子 hclawPaths：让叶子跟随本文件对 config 的桩，避免绕过 mock 落到真实 ~/.hclaw

vi.mock('../../../src/main/scheduler', () => ({
    schedulerManager: {
        stop: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
        runNow: vi.fn(),
        upsertWorkerSchedule: vi.fn(),
        deleteWorkerSchedule: vi.fn(),
    },
}))

vi.mock('../../../src/main/repositories', () => ({
    createConversationRepository: () => ({
        list: () => [
            {id: 'c-old', scheduleId: 's1', updatedAt: 1},
            {id: 'c-new', scheduleId: 's1', updatedAt: 9},
            {id: 'c-other', scheduleId: 's2', updatedAt: 5},
        ],
    }),
}))

vi.mock('../../../src/main/scheduler/ScheduleRepository', () => ({
    scheduleRepo: {
        list: vi.fn(() => []),
        get: vi.fn(() => null),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
    },
}))

/**
 * 工作区记录：票 11 起「工作目录可用」是立即执行的前置条件，
 * 故夹具里的任务统一挂在一个真实存在的目录上（系统临时目录），
 * 本文件的用例考的是通道形状与返回契约，不是工作目录守卫。
 */
vi.mock('../../../src/main/repositories/sqlite/workspaceRepository', () => ({
    SqliteWorkspaceRepository: class {
        getById(id: string) { return id === 'ws-fixture' ? {id, path: require('os').tmpdir(), name: 'fixture'} : null }
        /** 窄出口（工作区守卫消费）：夹具里没有故障，只报 ok / missing */
        tryGetById(id: string) {
            const found = id === 'ws-fixture' ? {id, path: require('os').tmpdir(), name: 'fixture'} : null
            return found ? {kind: 'ok', workspace: found} : {kind: 'missing'}
        }
        tryList() { return {kind: 'ok', workspaces: []} }
    },
}))

import {ScheduleError} from '../../../src/main/scheduler/scheduleErrors'
import {initScheduleIPC, SCRIPT_LOG_READ_LIMIT_BYTES} from '../../../src/main/scheduler/scheduleIPC'

// 生产环境由 src/main/index.ts 在启动时调用；测试里显式注册一次
initScheduleIPC()

const CHANNELS = [
    'scheduler-list', 'scheduler-create', 'scheduler-update', 'scheduler-delete',
    'scheduler-stop', 'scheduler-pause', 'scheduler-resume', 'scheduler-run-now',
    'scheduler-get-conversations',
    'scheduler-script-logs', 'scheduler-read-script-log',
    // 票 11 新增：工作目录健康度（只读派生查询，判定权仍在主进程）
    'scheduler-workspace-health',
    // 还原系统任务默认配置（仅 isSystem 记录）
    'scheduler-restore-default',
    // 系统任务漂移检测（还原默认按钮禁用态，只读派生查询）
    'scheduler-system-drift',
]

function recordOf(id: string) {
    return {
        id, name: '任务', description: '', cronExpression: '0 9 * * *', taskType: 'agent' as const,
        taskTarget: 't', taskArgs: [], enabled: true, paused: false, pausedAt: null,
        lastRunAt: null, lastRunStatus: 'none' as const, lastRunConversationId: null,
        runCount: 0, createdAt: 1, updatedAt: 1, workspaceId: 'ws-fixture' as string | null,
    }
}

async function repo() {
    return (await import('../../../src/main/scheduler/ScheduleRepository')).scheduleRepo as unknown as {
        list: ReturnType<typeof vi.fn>, get: ReturnType<typeof vi.fn>, create: ReturnType<typeof vi.fn>,
        update: ReturnType<typeof vi.fn>, delete: ReturnType<typeof vi.fn>,
    }
}

async function manager() {
    return (await import('../../../src/main/scheduler')).schedulerManager as unknown as {
        stop: ReturnType<typeof vi.fn>, pause: ReturnType<typeof vi.fn>, resume: ReturnType<typeof vi.fn>,
        runNow: ReturnType<typeof vi.fn>,
        upsertWorkerSchedule: ReturnType<typeof vi.fn>, deleteWorkerSchedule: ReturnType<typeof vi.fn>,
    }
}

const call = (ch: string, ...args: unknown[]) => handlers.get(ch)!(null, ...args) as any

beforeEach(async () => {
    sent.length = 0
    sentChanges.length = 0
    const r = await repo()
    r.list.mockReset().mockReturnValue([])
    r.get.mockReset().mockReturnValue(null)
    r.create.mockReset()
    r.update.mockReset()
    r.delete.mockReset()
    const m = await manager()
    m.stop.mockReset()
    m.pause.mockReset()
    m.resume.mockReset()
    m.runNow.mockReset()
    m.upsertWorkerSchedule.mockReset()
    m.deleteWorkerSchedule.mockReset()
})

describe('scheduleIPC — 通道注册', () => {
    it('注册全部 13 个通道，且不新增其它定时任务通道', () => {
        for (const ch of CHANNELS) expect(handlers.has(ch)).toBe(true)
        const schedulerChannels = [...handlers.keys()].filter(ch => ch.startsWith('scheduler-'))
        expect(schedulerChannels.sort()).toEqual([...CHANNELS].sort())
    })
})

describe('scheduleIPC — 统一返回形状', () => {
    it('scheduler-list 成功 → {ok:true,data:记录数组}', async () => {
        const r = await repo()
        r.list.mockReturnValueOnce([recordOf('s1')])
        expect(await call('scheduler-list')).toEqual({ok: true, data: [recordOf('s1')]})
    })

    it('scheduler-list 存储异常 → {ok:false,error}（不再降级为空数组）', async () => {
        const r = await repo()
        r.list.mockImplementationOnce(() => { throw new ScheduleError('STORAGE_FAILURE', '定时任务存储异常（query）：db closed') })
        const res = await call('scheduler-list')
        expect(res.ok).toBe(false)
        expect(res.error).toContain('存储异常')
    })

    it('scheduler-create 成功 → {ok:true,data:记录} + 广播 schedules-changed + 同步 cron 引擎', async () => {
        const r = await repo()
        const m = await manager()
        r.get.mockReturnValueOnce(recordOf('new-id'))
        const res = await call('scheduler-create', {name: '任务', cronExpression: '0 9 * * *', taskType: 'agent', taskTarget: 't'})
        expect(res.ok).toBe(true)
        expect(res.data.id).toBe('new-id')
        expect(r.create).toHaveBeenCalledTimes(1)
        // 落库入参：id 由主进程生成，默认启用且未暂停
        const written = r.create.mock.calls[0][0]
        expect(written.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
        expect(written).toMatchObject({paused: false, enabled: true, taskArgs: [], workspaceId: null})
        expect(sent).toContain('schedules-changed')
        expect(m.upsertWorkerSchedule).toHaveBeenCalledTimes(1)
    })

    it('scheduler-create 参数非法（ID 已存在）→ {ok:false,error} 且不广播', async () => {
        const r = await repo()
        r.create.mockImplementationOnce(() => { throw new ScheduleError('INVALID_ARGUMENT', '定时任务 ID 已存在：x') })
        const res = await call('scheduler-create', {name: '任务', cronExpression: '* * * * *', taskType: 'agent', taskTarget: 't'})
        expect(res.ok).toBe(false)
        expect(res.error).toContain('已存在')
        expect(sent).not.toContain('schedules-changed')
    })

    it('scheduler-update 目标不存在 → NOT_FOUND 可读消息，且不广播', async () => {
        const r = await repo()
        r.update.mockImplementationOnce(() => { throw new ScheduleError('NOT_FOUND', '未找到ID为 "nope" 的定时任务。') })
        const res = await call('scheduler-update', {id: 'nope', name: 'x'})
        expect(res).toEqual({ok: false, error: '未找到ID为 "nope" 的定时任务。'})
        expect(sent).not.toContain('schedules-changed')
    })

    it('scheduler-update 成功后按记录 enabled 决定同步/移除 cron 引擎', async () => {
        const r = await repo()
        const m = await manager()
        r.get.mockReturnValueOnce({...recordOf('s1'), enabled: false})
        const res = await call('scheduler-update', {id: 's1', enabled: false})
        expect(res.ok).toBe(true)
        expect(m.upsertWorkerSchedule).not.toHaveBeenCalled()
        expect(m.deleteWorkerSchedule).toHaveBeenCalledWith('s1')
        expect(sent).toContain('schedules-changed')
    })

    it('scheduler-delete 目标不存在 → {ok:false,error} 且不调用 stop、不广播', async () => {
        const m = await manager()
        const res = await call('scheduler-delete', 'nope')
        expect(res).toEqual({ok: false, error: '未找到ID为 "nope" 的定时任务。'})
        expect(m.stop).not.toHaveBeenCalled()
        expect(sent).not.toContain('schedules-changed')
    })

    it('scheduler-delete 成功 → {ok:true,data:true} + 广播', async () => {
        const r = await repo()
        const m = await manager()
        r.get.mockReturnValueOnce(recordOf('s1'))
        const res = await call('scheduler-delete', 's1')
        expect(res).toEqual({ok: true, data: true})
        expect(m.stop).toHaveBeenCalledWith('s1')
        expect(r.delete).toHaveBeenCalledWith('s1')
        expect(sent).toContain('schedules-changed')
    })
})

describe('scheduleIPC — 增量广播载荷（新增 / 更新 / 删除 可区分）', () => {
    it('scheduler-create → 广播 {type:"created", record}（带新记录本体）', async () => {
        const r = await repo()
        r.get.mockReturnValueOnce(recordOf('new-id'))
        await call('scheduler-create', {name: '任务', cronExpression: '0 9 * * *', taskType: 'agent', taskTarget: 't'})
        expect(sentChanges).toEqual([{type: 'created', record: recordOf('new-id')}])
    })

    it('scheduler-update → 广播 {type:"updated", record}（带更新后读回值）', async () => {
        const r = await repo()
        r.get.mockReturnValueOnce({...recordOf('s1'), name: '改名后'})
        await call('scheduler-update', {id: 's1', name: '改名后'})
        expect(sentChanges).toEqual([{type: 'updated', record: {...recordOf('s1'), name: '改名后'}}])
    })

    it('scheduler-delete → 广播 {type:"deleted", id}（只带 id，不夹带记录本体）', async () => {
        const r = await repo()
        r.get.mockReturnValueOnce(recordOf('s1'))
        await call('scheduler-delete', 's1')
        expect(sentChanges).toEqual([{type: 'deleted', id: 's1'}])
    })

    it('scheduler-pause / scheduler-resume → 都广播 {type:"updated", record}', async () => {
        const r = await repo()
        r.get.mockReturnValueOnce({...recordOf('s1'), paused: true, pausedAt: 123})
        await call('scheduler-pause', 's1')
        r.get.mockReturnValueOnce({...recordOf('s1'), paused: false, pausedAt: null})
        await call('scheduler-resume', 's1')
        expect(sentChanges).toEqual([
            {type: 'updated', record: {...recordOf('s1'), paused: true, pausedAt: 123}},
            {type: 'updated', record: {...recordOf('s1'), paused: false, pausedAt: null}},
        ])
    })

    it('三种形态互不相同：同一串操作广播出三种可判别的载荷', async () => {
        const r = await repo()
        r.get.mockReturnValue(recordOf('s1'))
        await call('scheduler-create', {name: '任务', cronExpression: '0 9 * * *', taskType: 'agent', taskTarget: 't'})
        await call('scheduler-update', {id: 's1', name: 'x'})
        await call('scheduler-delete', 's1')
        expect((sentChanges as Array<{type: string}>).map(c => c.type)).toEqual(['created', 'updated', 'deleted'])
    })
})

describe('scheduleIPC — 停止不存在的任务不再返回成功', () => {
    it('scheduler-stop 任务不存在 → {ok:false,error:未找到…}，且不调用引擎 stop', async () => {
        const m = await manager()
        const res = await call('scheduler-stop', 'nope')
        expect(res).toEqual({ok: false, error: '未找到ID为 "nope" 的定时任务。'})
        expect(m.stop).not.toHaveBeenCalled()
    })

    it('scheduler-stop 任务存在 → {ok:true,data:true} 且真的停了', async () => {
        const r = await repo()
        const m = await manager()
        r.get.mockReturnValueOnce(recordOf('s1'))
        const res = await call('scheduler-stop', 's1')
        expect(res).toEqual({ok: true, data: true})
        expect(m.stop).toHaveBeenCalledWith('s1')
    })
})

describe('scheduleIPC — 暂停与恢复', () => {
    it('scheduler-pause 成功 → {ok:true,data:记录(paused)} + 广播 + 通知引擎暂停', async () => {
        const r = await repo()
        const m = await manager()
        r.get.mockReturnValueOnce({...recordOf('s1'), paused: true, pausedAt: 123})
        const res = await call('scheduler-pause', 's1')
        expect(res.ok).toBe(true)
        expect(res.data.paused).toBe(true)
        // 落库的是暂停语义：paused=true 且带 pausedAt
        expect(r.update).toHaveBeenCalledWith('s1', expect.objectContaining({paused: true, pausedAt: expect.any(Number)}))
        expect(m.pause).toHaveBeenCalledWith('s1')
        expect(sent).toContain('schedules-changed')
    })

    it('scheduler-resume 成功 → {ok:true,data:记录} + 清掉 pausedAt + 通知引擎恢复', async () => {
        const r = await repo()
        const m = await manager()
        r.get.mockReturnValueOnce({...recordOf('s1'), paused: false, pausedAt: null})
        const res = await call('scheduler-resume', 's1')
        expect(res.ok).toBe(true)
        expect(r.update).toHaveBeenCalledWith('s1', {paused: false, pausedAt: null})
        expect(m.resume).toHaveBeenCalledWith('s1')
        expect(sent).toContain('schedules-changed')
    })

    it('scheduler-pause 目标不存在 → NOT_FOUND，不通知引擎、不广播', async () => {
        const r = await repo()
        const m = await manager()
        r.update.mockImplementationOnce(() => { throw new ScheduleError('NOT_FOUND', '未找到ID为 "nope" 的定时任务。') })
        const res = await call('scheduler-pause', 'nope')
        expect(res).toEqual({ok: false, error: '未找到ID为 "nope" 的定时任务。'})
        expect(m.pause).not.toHaveBeenCalled()
        expect(sent).not.toContain('schedules-changed')
    })

    it('scheduler-resume 目标不存在 → NOT_FOUND，不通知引擎、不广播', async () => {
        const r = await repo()
        const m = await manager()
        r.update.mockImplementationOnce(() => { throw new ScheduleError('NOT_FOUND', '未找到ID为 "nope" 的定时任务。') })
        const res = await call('scheduler-resume', 'nope')
        expect(res.ok).toBe(false)
        expect(m.resume).not.toHaveBeenCalled()
        expect(sent).not.toContain('schedules-changed')
    })

    it('暂停/恢复与「更新一条记录」不是同一条通道（各有独立通道）', () => {
        expect(handlers.get('scheduler-pause')).not.toBe(handlers.get('scheduler-update'))
        expect(handlers.get('scheduler-resume')).not.toBe(handlers.get('scheduler-update'))
    })
})

describe('scheduleIPC — 立即执行', () => {
    it('成功 → {ok:true,data:true}', async () => {
        const r = await repo()
        const m = await manager()
        r.get.mockReturnValueOnce(recordOf('s1'))
        m.runNow.mockResolvedValueOnce({success: true})
        expect(await call('scheduler-run-now', 's1')).toEqual({ok: true, data: true})
    })

    it('引擎拒绝（script 类型）→ {ok:false,error} 保留引擎原因', async () => {
        const r = await repo()
        const m = await manager()
        r.get.mockReturnValueOnce({...recordOf('s1'), taskType: 'script'})
        m.runNow.mockResolvedValueOnce({success: false, error: 'Script 类型不支持立即运行，请使用定时触发'})
        const res = await call('scheduler-run-now', 's1')
        expect(res.ok).toBe(false)
        expect(res.error).toContain('Script 类型不支持立即运行')
    })

    it('任务不存在 → NOT_FOUND，不进入引擎', async () => {
        const m = await manager()
        const res = await call('scheduler-run-now', 'nope')
        expect(res).toEqual({ok: false, error: '未找到ID为 "nope" 的定时任务。'})
        expect(m.runNow).not.toHaveBeenCalled()
    })
})

describe('scheduleIPC — 还原默认', () => {
    it('scheduler-restore-default 成功 → {ok:true,data:更新后记录} + 广播 {type:"updated", record}', async () => {
        const r = await repo()
        const def = (await import('../../../src/main/agent/defaults/systemSchedules'))
            .SYSTEM_SCHEDULE_DEFAULTS.find(d => d.id === 'sys-memory-accumulation')!
        r.get.mockReturnValueOnce({...recordOf('sys-memory-accumulation'), isSystem: true})
            .mockReturnValueOnce({...recordOf('sys-memory-accumulation'), isSystem: true,
                description: def.description, cronExpression: def.cronExpression, taskArgs: def.taskArgs})
        const res = await call('scheduler-restore-default', 'sys-memory-accumulation')
        expect(res.ok).toBe(true)
        expect(res.data.description).toBe(def.description)
        expect(r.update).toHaveBeenCalledWith('sys-memory-accumulation', {
            description: def.description, cronExpression: def.cronExpression, taskArgs: def.taskArgs,
        })
        expect(sentChanges).toEqual([{type: 'updated', record: res.data}])
    })

    it('非系统任务 → {ok:false,error}', async () => {
        const r = await repo()
        r.get.mockReturnValueOnce(recordOf('s1'))
        const res = await call('scheduler-restore-default', 's1')
        expect(res.ok).toBe(false)
        expect(res.error).toContain('仅系统内置任务')
    })
})

describe('scheduleIPC — 会话查询（同形状）', () => {
    it('scheduler-get-conversations → {ok:true,data:该任务的会话，按 updatedAt 倒序}', async () => {
        const res = await call('scheduler-get-conversations', 's1')
        expect(res.ok).toBe(true)
        expect(res.data.map((c: any) => c.id)).toEqual(['c-new', 'c-old'])
    })
})

describe('scheduleIPC — 脚本日志', () => {
    const logDir = path.join(os.tmpdir(), 'hclaw-schedule-ipc-test', 'logs', 'schedules')

    it('scheduler-script-logs 无日志目录 → {ok:true,data:[]}', async () => {
        expect(await call('scheduler-script-logs', 's1')).toEqual({ok: true, data: []})
    })

    it('scheduler-read-script-log 文件不在调度日志目录内 → {ok:false,error:…不在调度日志目录内}', async () => {
        const res = await call('scheduler-read-script-log', path.join(os.tmpdir(), 'outside.log'))
        expect(res.ok).toBe(false)
        expect(res.error).toContain('不在调度日志目录内')
    })

    it('scheduler-read-script-log 文件不存在 → {ok:false,error:…日志文件不存在}', async () => {
        const res = await call('scheduler-read-script-log', path.join(logDir, 'no-such-log-file.log'))
        expect(res.ok).toBe(false)
        expect(res.error).toContain('日志文件不存在')
    })

    it('scheduler-read-script-log 超上限的文件 → 只回前 N 字节 + 文件真实总大小', async () => {
        const fs = await import('fs')
        fs.mkdirSync(logDir, {recursive: true})
        const file = path.join(logDir, 's1-1700000000000.log')
        const body = 'x'.repeat(SCRIPT_LOG_READ_LIMIT_BYTES + 4096)
        fs.writeFileSync(file, body, 'utf-8')
        try {
            const res = await call('scheduler-read-script-log', file)
            expect(res.ok).toBe(true)
            // 载荷有上界：不是整份文件
            expect(res.data.content.length).toBe(SCRIPT_LOG_READ_LIMIT_BYTES)
            expect(res.data.content).toBe('x'.repeat(SCRIPT_LOG_READ_LIMIT_BYTES))
            // 总量是文件真实大小，不是收到的长度（渲染层据此判断「这一屏不完整」）
            expect(res.data.totalSize).toBe(body.length)
        } finally {
            fs.rmSync(file, {force: true})
        }
    })

    it('scheduler-read-script-log 未超上限的文件 → 全文 + 与内容等长的总大小', async () => {
        const fs = await import('fs')
        fs.mkdirSync(logDir, {recursive: true})
        const file = path.join(logDir, 's1-1700000000001.log')
        fs.writeFileSync(file, 'archive: done', 'utf-8')
        try {
            const res = await call('scheduler-read-script-log', file)
            expect(res).toEqual({ok: true, data: {content: 'archive: done', totalSize: 13}})
        } finally {
            fs.rmSync(file, {force: true})
        }
    })
})
