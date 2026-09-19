/**
 * scheduleOps.updateSchedule — isSystem 结构性不可变
 *
 * 安全不变式：scheduler-update IPC 原样透传 updates 到 scheduleOps.updateSchedule，
 * 若 isSystem 可被写入，调用方可把用户任务提升为系统任务（不可删除 + workspace 守卫旁路）。
 * 本文件钉住：updateSchedule 剥离 updates.isSystem，普通任务读回仍为 false（系统任务也不会被降级）。
 *
 * 隔离策略与 ScheduleRepository.isSystem.test.ts / pauseResumeWiring.test.ts 一致：
 * config 指向临时目录 + 假 worker_threads，走真实 SQLite。
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'
import * as os from 'os'
import * as path from 'path'

vi.mock('@/main/config', () => {
    const os = require('os')
    const path = require('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-schedule-ops-immutable-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
    }
})
vi.mock('@/main/hclawPaths', async () => await import('@/main/config'))

vi.mock('worker_threads', () => {
    class FakeWorker {
        readonly posted: unknown[] = []
        readonly handlers: Record<string, (arg: unknown) => void> = {}
        on(event: string, handler: (arg: unknown) => void): void { this.handlers[event] = handler }
        postMessage(msg: unknown): void { this.posted.push(msg) }
        terminate(): Promise<void> { return Promise.resolve() }
    }
    return {Worker: FakeWorker}
})

import {initStorage} from '@/main/repositories'
import {closeDatabase, getDatabase} from '@/main/repositories/sqlite'
import {createSchedule, updateSchedule} from '@/main/scheduler/scheduleOps'
import {scheduleRepo} from '@/main/scheduler/ScheduleRepository'

function resetScheduleTable(): void {
    getDatabase().exec('DELETE FROM schedules')
}

describe('scheduleOps.updateSchedule — isSystem 不可变', () => {
    beforeEach(() => {
        initStorage()
        resetScheduleTable()
    })
    afterEach(() => {
        closeDatabase()
    })

    function createUserTask(id: string): void {
        const result = createSchedule({
            id, name: 'User Task', description: '', cronExpression: '0 * * * *',
            taskType: 'agent', taskTarget: 'X', taskArgs: [], enabled: true, workspaceId: null,
        })
        if (!result.ok) throw new Error(result.error)
    }

    it('updateSchedule({isSystem: true}) 对普通任务无效：读回仍为 false', () => {
        createUserTask('u-1')
        const result = updateSchedule('u-1', {isSystem: true} as any)
        expect(result.ok).toBe(true)
        expect(scheduleRepo.get('u-1')!.isSystem).toBe(false)
    })

    it('updateSchedule({isSystem: false}) 不能把系统任务降级（strip 双向生效）', () => {
        const result = createSchedule({
            id: 's-1', name: 'System Task', description: '', cronExpression: '0 * * * *',
            taskType: 'agent', taskTarget: 'X', taskArgs: [], enabled: true, workspaceId: null,
        })
        if (!result.ok) throw new Error(result.error)
        scheduleRepo.update('s-1', {isSystem: true}) // 系统任务由播种路径写入（repo 层保留该能力）
        const updated = updateSchedule('s-1', {isSystem: false} as any)
        expect(updated.ok).toBe(true)
        expect(scheduleRepo.get('s-1')!.isSystem).toBe(true)
    })

    it('剥离后其余字段照常更新', () => {
        createUserTask('u-2')
        const result = updateSchedule('u-2', {isSystem: true, description: '改动过'} as any)
        expect(result.ok).toBe(true)
        const record = scheduleRepo.get('u-2')!
        expect(record.description).toBe('改动过')
        expect(record.isSystem).toBe(false)
    })
})
