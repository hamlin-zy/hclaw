// @vitest-environment node
/**
 * scheduleOps.systemScheduleDrift — 系统任务「还原默认」按钮漂移检测
 *
 * 钉住三条口径：
 * - 出厂配置（与 SYSTEM_SCHEDULE_DEFAULTS 同源）→ drifted=false；
 * - description / cronExpression / taskArgs 任一不等 → drifted=true 且 changedFields 正确；
 * - 仅 isSystem 记录进 map；defaults 中找不到 id 的记录不进 map。
 *
 * 隔离策略与 scheduleOps.isSystemImmutable.test.ts 一致：临时目录 + 假 worker_threads，走真实 SQLite。
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'

vi.mock('@/main/config', () => {
    const os = require('os')
    const path = require('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-schedule-drift-' + Date.now())
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
import {createSchedule, systemScheduleDrift} from '@/main/scheduler/scheduleOps'
import {scheduleRepo} from '@/main/scheduler/ScheduleRepository'
import {SYSTEM_SCHEDULE_DEFAULTS} from '@/main/agent/defaults/systemSchedules'

const DEF = SYSTEM_SCHEDULE_DEFAULTS[0]
if (!DEF) throw new Error('SYSTEM_SCHEDULE_DEFAULTS 为空')

function resetScheduleTable(): void {
    getDatabase().exec('DELETE FROM schedules')
}

/** 按出厂值播种一条系统任务（先 create 再由播种路径补 isSystem） */
function seedSystemTask(id: string, over: Record<string, unknown> = {}): void {
    const result = createSchedule({
        id,
        name: DEF.name,
        description: DEF.description,
        cronExpression: DEF.cronExpression,
        taskType: DEF.taskType,
        taskTarget: DEF.taskTarget,
        taskArgs: DEF.taskArgs,
        enabled: true,
        workspaceId: null,
        ...over,
    })
    if (!result.ok) throw new Error(result.error)
    if (over.isSystem !== false) scheduleRepo.update(id, {isSystem: true})
}

describe('scheduleOps.systemScheduleDrift', () => {
    beforeEach(() => {
        initStorage()
        resetScheduleTable()
    })
    afterEach(() => {
        closeDatabase()
    })

    it('出厂配置 → drifted=false', () => {
        seedSystemTask(DEF.id)
        const result = systemScheduleDrift()
        expect(result.ok).toBe(true)
        expect(result.ok && result.data[DEF.id]).toEqual({drifted: false, changedFields: []})
    })

    it('description / cronExpression / taskArgs 任一不等 → drifted=true 且 changedFields 正确', () => {
        seedSystemTask(DEF.id, {description: '用户改过的描述', cronExpression: '0 5 * * *', taskArgs: ['改过的提示词']})
        const result = systemScheduleDrift()
        expect(result.ok).toBe(true)
        const info = result.ok ? result.data[DEF.id] : undefined
        expect(info!.drifted).toBe(true)
        expect(info!.changedFields.sort()).toEqual(['cronExpression', 'description', 'taskArgs'].sort())
    })

    it('仅改 cron → 只报 cronExpression', () => {
        seedSystemTask(DEF.id, {cronExpression: '30 8 * * *'})
        const result = systemScheduleDrift()
        expect(result.ok && result.data[DEF.id]).toEqual({drifted: true, changedFields: ['cronExpression']})
    })

    it('description null 与出厂空串等价（DB 中可能为 null）', () => {
        // 追加一个 description 为空串的假默认（SYSTEM_SCHEDULE_DEFAULTS 是可变数组），
        // 否则唯一出厂项 description 非空，null 归一等价无从构造
        const fakeDef = {id: 'sys-empty-desc', name: '空描述', description: '',
            cronExpression: '0 1 * * *', taskType: 'agent', taskTarget: 'X', taskArgs: []} as any
        SYSTEM_SCHEDULE_DEFAULTS.push(fakeDef)
        seedSystemTask('sys-empty-desc', {description: '', cronExpression: fakeDef.cronExpression, taskArgs: fakeDef.taskArgs})
        const result = systemScheduleDrift()
        expect(result.ok && result.data['sys-empty-desc']).toEqual({drifted: false, changedFields: []})
    })

    it('非系统任务不进 map；defaults 中找不到 id 的系统任务也不进 map', () => {
        seedSystemTask(DEF.id)
        seedSystemTask('user-1', {isSystem: false})
        seedSystemTask('sys-unknown-id')
        const result = systemScheduleDrift()
        expect(result.ok).toBe(true)
        const map = result.ok ? result.data : {}
        expect(Object.keys(map)).not.toContain('user-1')
        expect(Object.keys(map)).not.toContain('sys-unknown-id')
        expect(Object.keys(map)).toEqual([DEF.id])
    })
})
