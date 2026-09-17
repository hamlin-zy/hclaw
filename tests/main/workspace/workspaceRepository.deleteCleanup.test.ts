/**
 * 删除工作区 → 清理定时任务引用（数据一致性，票 task-670265c2）
 *
 * 现状（实证）：`workspaces` 表无外键约束，`schedules.workspace_id` 是裸 TEXT。
 * 侧边栏移除工作区只删 `workspaces` 记录 + 该工作区的会话，**不碰**引用它的
 * `schedules.workspace_id` —— 于是库里留下一批**悬空引用**（指向一个不存在的 id），
 * 任务永远卡在「工作目录失效」，没有任何入口能解释成因。
 *
 * 本用例钉住修复后的行为：删除工作区后，引用它的任务**不再持有悬空 id**
 * （`workspace_id` 被置 NULL），且**任务本身保留**（不越权删用户的任务）——
 * 下轮执行由工作目录守卫判成 `unset` 拦下，用户重选工作区即可恢复。
 *
 * SQLite 策略（与 ScheduleRepository.test.ts 一致）：vi.mock config 重定向到
 * os.tmpdir() 下的独立临时目录，走真实 SQLite，不 mock 仓储层，
 * 验证「读回的任务记录」而非「调用过某个函数」。
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'

// 隔离：重定向到 os.tmpdir() 下的独立临时目录，绝不触碰真实 ~/.hclaw/data/hclaw.db
vi.mock('@/main/config', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.mock 工厂被提升，不能引用文件级 const
    const os = require('os')
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- 同上
    const path = require('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-ws-delete-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
    }
})
vi.mock('@/main/hclawPaths', async () => await import('@/main/config'))  // 路径能力已下沉到叶子 hclawPaths：让叶子跟随本文件对 config 的桩，避免绕过 mock 落到真实 ~/.hclaw

import {initStorage} from '@/main/repositories'
import {closeDatabase, getDatabase} from '@/main/repositories/sqlite'
import {workspaceRepo} from '@/main/repositories/sqlite/workspaceRepository'
import {scheduleRepo} from '@/main/scheduler/ScheduleRepository'
import {checkScheduleWorkspace} from '@/main/scheduler/scheduleWorkspace'

const WS_KEEP = 'ws-keep-0001'
const WS_DOOMED = 'ws-doomed-0002'

/** 直接落库一条定时任务：本用例关心的是引用关系，不经 create 的其余校验 */
function seedSchedule(id: string, workspaceId: string | null): void {
    getDatabase().prepare(
        `INSERT INTO schedules (id, name, cron_expression, task_type, task_target, task_args,
            enabled, paused, workspace_id, created_at, updated_at)
         VALUES (?, ?, '*/5 * * * *', 'agent', 'x', '[]', 1, 0, ?, ?, ?)`,
    ).run(id, `任务 ${id}`, workspaceId, Date.now(), Date.now())
}

function resetTables(): void {
    const db = getDatabase()
    db.exec('DELETE FROM schedules')
    db.exec('DELETE FROM workspaces')
}

describe('删除工作区 · 清理由它引用的定时任务（task-670265c2）', () => {
    beforeEach(() => {
        initStorage()
        resetTables()
        workspaceRepo.create(WS_KEEP, 'E:\\proj\\keep', 'keep')
        workspaceRepo.create(WS_DOOMED, 'E:\\proj\\doomed', 'doomed')
        // 3 条任务指向将被删除的工作区，另 2 条对照（有效工作区 / 无工作目录）
        seedSchedule('sched-a', WS_DOOMED)
        seedSchedule('sched-b', WS_DOOMED)
        seedSchedule('sched-c', WS_DOOMED)
        seedSchedule('sched-keep', WS_KEEP)
        seedSchedule('sched-none', null)
    })
    afterEach(() => {
        closeDatabase()
    })

    it('删除后引用它的任务仍存在，但不再持有悬空 workspace_id（置 NULL）', () => {
        expect(workspaceRepo.delete(WS_DOOMED)).toBe(true)

        // 工作区记录确实没了
        expect(workspaceRepo.getById(WS_DOOMED)).toBeNull()

        // 任务**保留**（不是被连带删除），且 workspace_id 不再是那个已消失的 id
        const records = scheduleRepo.list()
        expect(records).toHaveLength(5)
        for (const id of ['sched-a', 'sched-b', 'sched-c']) {
            const record = records.find(r => r.id === id)
            expect(record).toBeDefined()
            expect(record!.workspaceId).toBeNull()
        }

        // 库里没有任何一行还指向被删掉的工作区（悬空引用归零）
        const dangling = getDatabase().prepare(
            'SELECT COUNT(*) AS n FROM schedules WHERE workspace_id = ?',
        ).get(WS_DOOMED) as {n: number}
        expect(dangling.n).toBe(0)
    })

    it('不引用该工作区的任务不受影响（有效工作区 / 无工作目录原样保留）', () => {
        workspaceRepo.delete(WS_DOOMED)

        const records = scheduleRepo.list()
        expect(records.find(r => r.id === 'sched-keep')!.workspaceId).toBe(WS_KEEP)
        expect(records.find(r => r.id === 'sched-none')!.workspaceId).toBeNull()
    })

    it('用户可见结果：受影响任务被守卫拦下，且是「未设置工作目录」而非悬空态', () => {
        workspaceRepo.delete(WS_DOOMED)
        const record = scheduleRepo.get('sched-a')!

        // 执行拦截的唯一权威判定（与 cron 到点、立即执行共用同一函数）
        const health = checkScheduleWorkspace(record.workspaceId)
        expect(health.state).toBe('unset')
        expect(health.reason).toBe('未设置工作目录')

        // 对照：不清理时这里会是 missing（「工作目录已不存在」）—— 那是悬空引用的症状
        expect(checkScheduleWorkspace(WS_DOOMED).state).toBe('missing')
    })

    it('删除不存在的工作区不影响任何任务（幂等）', () => {
        expect(workspaceRepo.delete('ws-not-exists')).toBe(true)

        const records = scheduleRepo.list()
        expect(records).toHaveLength(5)
        expect(records.find(r => r.id === 'sched-a')!.workspaceId).toBe(WS_DOOMED)
    })
})
