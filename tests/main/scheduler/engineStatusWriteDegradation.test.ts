/**
 * 引擎的运行状态写入是「显式降级的 best-effort 写」
 *
 * 背景：仓储层不再把存储失败降级为 false（改为抛 ScheduleError），但执行器的状态记账不该
 * 让执行 / 停止 / 删除链路中断——尤其是 stop() 夹在删除链路中间，一旦抛出，
 * deleteWorkerSchedule 与 repo.delete 都不会执行。
 *
 * 本文件把单例 manager 的 scheduleRepo 换成「updateRunStatus 恒抛」的桩，
 * 断言调用方（stop）不会把异常抛出来。
 */
import {describe, expect, it, vi} from 'vitest'
import * as os from 'os'
import * as path from 'path'

// 隔离：config 指向临时目录，避免触碰真实 ~/.hclaw
vi.mock('@/main/config', () => {
    const os = require('os')
    const path = require('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-scheduler-manager-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
    }
})
vi.mock('@/main/hclawPaths', async () => await import('@/main/config'))  // 路径能力已下沉到叶子 hclawPaths：让叶子跟随本文件对 config 的桩，避免绕过 mock 落到真实 ~/.hclaw

import {schedulerManager} from '@/main/scheduler'
import {ScheduleError} from '@/main/scheduler/scheduleErrors'

/** 把 manager 的仓储换成「状态写入恒失败」的桩；返回还原函数 */
function breakStatusWrite(): () => void {
    const original = schedulerManager.scheduleRepo
    schedulerManager.scheduleRepo = {
        get: () => null,
        list: () => [],
        listEnabled: () => [],
        create: () => {},
        update: () => {},
        delete: () => {},
        updateRunStatus: () => { throw new ScheduleError('STORAGE_FAILURE', '数据库不可用') },
    } as unknown as typeof schedulerManager.scheduleRepo
    return () => { schedulerManager.scheduleRepo = original }
}

describe('SchedulerManager — 存储异常时状态写入显式降级', () => {
    it('stop() 在 updateRunStatus 抛出（存储异常）时仍不抛给调用方', () => {
        const restore = breakStatusWrite()
        try {
            expect(() => schedulerManager.stop('sched-1')).not.toThrow()
        } finally { restore() }
    })

    it('stop() 对未知 id 也不抛（无 activeRuns 时不依赖引擎状态）', () => {
        const restore = breakStatusWrite()
        try {
            expect(() => schedulerManager.stop('unknown-id')).not.toThrow()
        } finally { restore() }
    })
})
