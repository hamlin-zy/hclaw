/**
 * 配置变更广播 — 唯一出口与可区分载荷（本票主 seam 的补足）
 *
 * 断言三件事：
 * 1. 变更载荷可区分：新增 / 更新 / 删除 各自广播出不同形态（带记录本体 or 只带 id）
 * 2. 接收方口径：发给**所有未销毁的窗口**（多窗口同步），不只主窗口
 * 3. 入口合并的静态契约：界面路径与工具路径都汇入 scheduleBroadcast 这一个出口，
 *    不再各写一份 webContents.send / sendToMainWindow
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

type Win = {isDestroyed: () => boolean; webContents: {send: (ch: string, payload?: unknown) => void}}
const windows: Win[] = []
const sent: Array<{channel: string; payload: unknown}> = []

vi.mock('electron', () => ({
    ipcMain: {handle: vi.fn()},
    BrowserWindow: {getAllWindows: () => windows},
}))

vi.mock('../../../src/main/scheduler', () => ({
    schedulerManager: {
        stop: vi.fn(), pause: vi.fn(), resume: vi.fn(), runNow: vi.fn(),
        upsertWorkerSchedule: vi.fn(), deleteWorkerSchedule: vi.fn(),
    },
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
 * 故夹具里的任务统一挂在一个真实存在的目录上（系统临时目录）。
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

import {broadcastSchedulesChanged} from '../../../src/main/scheduler/scheduleBroadcast'
import {schedulerManageTool} from '../../../src/main/agent/tools/builtin/schedulerManageTool'

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

/** 记录工具通过 context.onEvent 抛出的变更事件 */
const events: any[] = []
const ctx = {
    workingDir: '',
    abortSignal: new AbortController().signal,
    sendMessage: () => {},
    onEvent: (e: any) => { events.push(e) },
} as any

const readSrc = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf-8')

beforeEach(async () => {
    sent.length = 0
    events.length = 0
    windows.length = 0
    windows.push(
        {isDestroyed: () => false, webContents: {send: (ch, payload) => sent.push({channel: ch, payload})}},
        {isDestroyed: () => false, webContents: {send: (ch, payload) => sent.push({channel: ch, payload})}},
    )
    const r = await repo()
    r.get.mockReset().mockReturnValue(null)
    r.create.mockReset()
    r.update.mockReset()
    r.delete.mockReset()
    const m = (await import('../../../src/main/scheduler')).schedulerManager as unknown as {runNow: ReturnType<typeof vi.fn>}
    m.runNow.mockReset().mockResolvedValue({success: true})
})

describe('broadcastSchedulesChanged — 唯一出口的接收方口径', () => {
    it('发给所有未销毁的窗口（多窗口同步），载荷原样透传', () => {
        windows.push({isDestroyed: () => true, webContents: {send: () => { throw new Error('已销毁窗口不应被发送') }}})
        broadcastSchedulesChanged({type: 'deleted', id: 's1'})
        expect(sent).toEqual([
            {channel: 'schedules-changed', payload: {type: 'deleted', id: 's1'}},
            {channel: 'schedules-changed', payload: {type: 'deleted', id: 's1'}},
        ])
    })
})

describe('智能体工具路径 — 广播可区分的变更载荷', () => {
    it('create → onEvent 携带 {type:"created", record}', async () => {
        const r = await repo()
        r.get.mockReturnValueOnce(recordOf('new-id'))
        const res = await schedulerManageTool.execute(
            {action: 'create', name: '任务', cronExpression: '0 9 * * *', taskType: 'agent', taskTarget: 't'} as any,
            ctx,
        )
        expect(res.success).toBe(true)
        expect(events).toEqual([{type: 'schedules-changed', change: {type: 'created', record: recordOf('new-id')}}])
    })

    it('update → onEvent 携带 {type:"updated", record}（记录本体为更新后的读回值）', async () => {
        const r = await repo()
        r.get.mockReturnValueOnce({...recordOf('s1'), name: '改名后'})
        const res = await schedulerManageTool.execute({action: 'update', id: 's1', name: '改名后'} as any, ctx)
        expect(res.success).toBe(true)
        expect(events[0].change).toEqual({type: 'updated', record: {...recordOf('s1'), name: '改名后'}})
    })

    it('delete → onEvent 携带 {type:"deleted", id}（不夹带记录本体）', async () => {
        const r = await repo()
        r.get.mockReturnValue(recordOf('s1'))
        const res = await schedulerManageTool.execute({action: 'delete', id: 's1'} as any, ctx)
        expect(res.success).toBe(true)
        expect(events).toEqual([{type: 'schedules-changed', change: {type: 'deleted', id: 's1'}}])
    })

    it('delete 收到前缀 id → 广播解析后的完整 id（口径与界面路径一致，渲染层才能就地删除）', async () => {
        const r = await repo()
        // 仓储的 get 支持前缀解析：工具对外回显 8 位短 id，agent 会复用它来调用
        r.get.mockReturnValue(recordOf('s1-full-uuid'))
        const res = await schedulerManageTool.execute({action: 'delete', id: 's1'} as any, ctx)
        expect(res.success).toBe(true)
        expect(events).toEqual([{type: 'schedules-changed', change: {type: 'deleted', id: 's1-full-uuid'}}])
    })

    it('run_now → onEvent 携带 {type:"updated", record}（读回记录，供各窗口就地更新）', async () => {
        const r = await repo()
        r.get.mockReturnValue(recordOf('s1'))
        const res = await schedulerManageTool.execute({action: 'run_now', id: 's1'} as any, ctx)
        expect(res.success).toBe(true)
        expect(events).toEqual([{type: 'schedules-changed', change: {type: 'updated', record: recordOf('s1')}}])
    })

    it('操作失败不广播（口径与界面路径一致）', async () => {
        const r = await repo()
        r.update.mockImplementationOnce(() => { throw new Error('boom') })
        const res = await schedulerManageTool.execute({action: 'update', id: 's1', name: 'x'} as any, ctx)
        expect(res.success).toBe(false)
        expect(events).toEqual([])
    })
})

describe('两条广播入口合并为一处的静态契约', () => {
    it('界面路径（scheduleIPC）从 scheduleBroadcast 取广播，自己不写 webContents.send', () => {
        const src = readSrc('src/main/scheduler/scheduleIPC.ts')
        expect(src).toMatch(/from '\.\/scheduleBroadcast'/)
        expect(src).not.toMatch(/webContents\.send/)
    })

    it('工具路径（manager.impl）走同一个出口，不再用 sendToMainWindow 发 schedules-changed', () => {
        const src = readSrc('src/main/agent/manager.impl.ts')
        expect(src).toMatch(/broadcastSchedulesChanged\(/)
        expect(src).not.toMatch(/sendToMainWindow\('schedules-changed'/)
    })

    it('工具自身不直接广播，只把载荷交给 context.onEvent（四处写路径都带 change）', () => {
        const src = readSrc('src/main/agent/tools/builtin/schedulerManageTool.ts')
        expect(src.match(/\{type: 'schedules-changed', change: /g)).toHaveLength(4)
        expect(src).not.toMatch(/onEvent\?\.\(\{type: 'schedules-changed'\}\)/)
    })
})
