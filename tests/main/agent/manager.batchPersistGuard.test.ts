/**
 * AgentManager — 任务批次持久化旁路显式守卫单测（Task 3 修复轮 1 · M1）
 *
 * 背景：handleStreamEvent 持久化块此前用 `event.batchName!`/`event.batchStatus!`
 * 非空断言，字段缺失时 undefined 绑定异常被 catch 吞掉，问题难以排查。
 * 现改为显式守卫：任一字段为 null/undefined 时 log.warn 并跳过落库。
 *
 * taskBatchRepository 以 mock 隔离（不触真实 DB）；electron/config 对齐
 * manager.mergePersist.wiring.test.ts 的隔离模式。
 */
import {describe, expect, it, beforeEach, vi} from 'vitest'

// ── 隔离：config 重定向到独立临时目录（manager.impl → sqlite 链路需要）──
vi.mock('@/main/config', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.mock 工厂被提升，不能引用文件级 const
    const os = require('os')
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- 同上
    const path = require('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-batch-guard-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
    }
})

vi.mock('electron', () => ({
    BrowserWindow: class {},
    app: {getPath: () => '/tmp', isReady: () => true},
    dialog: {showErrorBox: vi.fn()},
    ipcMain: {handle: vi.fn(), on: vi.fn()},
}))

// ── logger mock：捕获守卫告警 ──
const loggerWarn = vi.fn()
vi.mock('@/main/agent/logger', () => ({
    createLogger: () => ({info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn()}),
    logger: {info: vi.fn(), warn: (...a: unknown[]) => loggerWarn(...a), error: vi.fn(), debug: vi.fn()},
}))

// ── upsertSnapshot mock：验证落库调用与否 ──
const upsertSnapshot = vi.fn()
vi.mock('@/main/repositories/sqlite/taskBatchRepository', () => ({
    upsertSnapshot: (...a: unknown[]) => upsertSnapshot(...a),
}))

import {AgentManager} from '@/main/agent/manager.impl'
import {closeDatabase, getDatabase} from '@/main/repositories/sqlite'

/** 构造 tasks_update 流事件 */
function tasksUpdateEvent(fields: Record<string, unknown>): {type: 'tasks_update'; tasks: Array<{id: string; title: string; status: string}>} & Record<string, unknown> {
    return {type: 'tasks_update', tasks: [{id: 't-1', title: 'A', status: 'pending'}], ...fields}
}

/** 经类型桥调用私有 handleStreamEvent（对齐 wiring.test 的括号注入模式） */
function callHandleStreamEvent(manager: AgentManager, event: ReturnType<typeof tasksUpdateEvent>): Promise<void> {
    const impl = manager as unknown as {handleStreamEvent: (convId: string, worker: unknown, event: unknown) => Promise<void>}
    return impl.handleStreamEvent('conv-1', {}, event)
}

beforeEach(() => {
    // 触碰真实 DB 初始化（与 wiring.test 相同链路），保证模块加载一致性后关闭
    getDatabase().exec('SELECT 1')
    closeDatabase()
    upsertSnapshot.mockClear()
    loggerWarn.mockClear()
})

describe('tasks_update 持久化旁路 — 批次字段守卫（M1）', () => {
    it('批次字段齐全：正常落库，无告警', async () => {
        const manager = new AgentManager()
        await callHandleStreamEvent(
            manager,
            tasksUpdateEvent({batchId: 'b-1', batchName: '批次一', batchStatus: 'active'}),
        )

        expect(upsertSnapshot).toHaveBeenCalledTimes(1)
        expect(upsertSnapshot).toHaveBeenCalledWith(
            'conv-1',
            {id: 'b-1', name: '批次一', status: 'active'},
            [{id: 't-1', title: 'A', status: 'pending'}],
        )
        expect(loggerWarn).not.toHaveBeenCalled()
    })

    it('batchStatus 缺失：log.warn 且跳过落库，不抛异常', async () => {
        const manager = new AgentManager()
        await expect(callHandleStreamEvent(manager,
            tasksUpdateEvent({batchId: 'b-2', batchName: '批次二'}),
        )).resolves.not.toThrow()

        expect(upsertSnapshot).not.toHaveBeenCalled()
        expect(loggerWarn).toHaveBeenCalledTimes(1)
        expect(String(loggerWarn.mock.calls[0][0])).toContain('persist skipped')
    })

    it('batchName 缺失：log.warn 且跳过落库，不抛异常', async () => {
        const manager = new AgentManager()
        await expect(callHandleStreamEvent(manager,
            tasksUpdateEvent({batchId: 'b-3', batchStatus: 'completed'}),
        )).resolves.not.toThrow()

        expect(upsertSnapshot).not.toHaveBeenCalled()
        expect(loggerWarn).toHaveBeenCalledTimes(1)
    })

    it('无 batchId 的事件：既不落库也不告警（非批次事件正常流转）', async () => {
        const manager = new AgentManager()
        await expect(callHandleStreamEvent(manager,
            tasksUpdateEvent({}),
        )).resolves.not.toThrow()

        expect(upsertSnapshot).not.toHaveBeenCalled()
        expect(loggerWarn).not.toHaveBeenCalled()
    })
})
