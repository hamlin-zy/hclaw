/**
 * ScheduleRepository 单元测试
 *
 * 覆盖：定时任务增删改查、enabled/paused 过滤、前缀 ID 解析、运行状态更新、持久化 round-trip。
 *
 * SQLite 策略（与 permissionRule.test.ts / conversationRepository.recovery.test.ts 一致）：
 * vi.mock config 重定向到 os.tmpdir() 独立临时目录，走真实 SQLite，
 * 不 mock repository 层，验证完整持久化链路。
 *
 * cron 表达式校验：ScheduleRepository 自身不解析 cron（解析在 worker.ts 中），
 * 本测试通过 cron-parser 的 CronExpressionParser 直接验证合法/非法表达式的解析行为。
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
    const testDir = path.join(os.tmpdir(), 'hclaw-test-schedule-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
    }
})

import {CronExpressionParser} from 'cron-parser'
import {initStorage} from '@/main/repositories'
import {closeDatabase, getDatabase} from '@/main/repositories/sqlite'
import {ScheduleRepository, scheduleRepo, type ScheduleRecord} from '@/main/scheduler/ScheduleRepository'

function makeSchedule(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
    return {
        id: overrides.id ?? 'sched-1',
        name: overrides.name ?? '每日巡检',
        description: overrides.description ?? '定时扫描项目目录',
        cronExpression: overrides.cronExpression ?? '*/5 * * * *',
        taskType: overrides.taskType ?? 'agent',
        taskTarget: overrides.taskTarget ?? '扫描当前工作目录',
        taskArgs: overrides.taskArgs ?? [],
        enabled: overrides.enabled ?? true,
        paused: overrides.paused ?? false,
        pausedAt: overrides.pausedAt ?? null,
        lastRunAt: overrides.lastRunAt ?? null,
        lastRunStatus: overrides.lastRunStatus ?? 'none',
        lastRunConversationId: overrides.lastRunConversationId ?? null,
        runCount: overrides.runCount ?? 0,
        createdAt: overrides.createdAt ?? 0,
        updatedAt: overrides.updatedAt ?? 0,
        workspaceId: overrides.workspaceId ?? null,
    }
}

/** 清空 schedules 表，保证每个用例从干净状态开始 */
function resetScheduleTable(): void {
    const db = getDatabase()
    db.exec('DELETE FROM schedules')
}

let repo: ScheduleRepository

describe('ScheduleRepository — 默认上下文', () => {
    beforeEach(() => {
        initStorage()
        resetScheduleTable()
        repo = new ScheduleRepository()
    })
    afterEach(() => {
        closeDatabase()
    })

    it('初始时列表为空', () => {
        expect(repo.list()).toEqual([])
        expect(repo.listEnabled()).toEqual([])
    })

    it('导出全局单例实例', () => {
        expect(scheduleRepo).toBeInstanceOf(ScheduleRepository)
    })
})

describe('ScheduleRepository — 增删改查', () => {
    beforeEach(() => {
        initStorage()
        resetScheduleTable()
        repo = new ScheduleRepository()
    })
    afterEach(() => {
        closeDatabase()
    })

    it('创建任务后可查询', () => {
        const created = makeSchedule({id: 'sched-create'})
        expect(repo.create(created)).toBe(true)

        const record = repo.get('sched-create')
        expect(record).not.toBeNull()
        expect(record!.id).toBe('sched-create')
        expect(record!.name).toBe('每日巡检')
        expect(record!.cronExpression).toBe('*/5 * * * *')
        expect(record!.taskType).toBe('agent')
        expect(record!.taskTarget).toBe('扫描当前工作目录')
        expect(record!.enabled).toBe(true)
        expect(record!.paused).toBe(false)
        // create 自动填充时间戳与运行状态
        expect(record!.createdAt).toBeTypeOf('number')
        expect(record!.updatedAt).toBeTypeOf('number')
        expect(record!.lastRunStatus).toBe('none')
        expect(record!.runCount).toBe(0)
    })

    it('create 返回 false 当 id 冲突（主键约束）', () => {
        const record = makeSchedule({id: 'sched-dupe'})
        expect(repo.create(record)).toBe(true)
        expect(repo.create(record)).toBe(false)
        // 原记录未被覆盖
        expect(repo.list()).toHaveLength(1)
    })

    it('更新任务字段', () => {
        repo.create(makeSchedule({id: 'sched-update'}))

        expect(repo.update('sched-update', {
            name: '更新后的任务',
            cronExpression: '0 9 * * *',
            taskArgs: ['x', 42],
        })).toBe(true)

        const record = repo.get('sched-update')!
        expect(record.name).toBe('更新后的任务')
        expect(record.cronExpression).toBe('0 9 * * *')
        expect(record.taskArgs).toEqual(['x', 42])
    })

    it('update 更新 enabled/paused 布尔字段', () => {
        repo.create(makeSchedule({id: 'sched-bool'}))

        expect(repo.update('sched-bool', {enabled: false})).toBe(true)
        expect(repo.get('sched-bool')!.enabled).toBe(false)

        expect(repo.update('sched-bool', {paused: true})).toBe(true)
        expect(repo.get('sched-bool')!.paused).toBe(true)
        expect(repo.get('sched-bool')!.enabled).toBe(false)
    })

    it('update 空更新返回 false', () => {
        repo.create(makeSchedule({id: 'sched-noop'}))
        expect(repo.update('sched-noop', {})).toBe(false)
    })

    it('update 不存在的 id 返回 false', () => {
        expect(repo.update('sched-missing', {name: 'nope'})).toBe(false)
    })

    it('删除任务', () => {
        repo.create(makeSchedule({id: 'sched-del'}))
        expect(repo.delete('sched-del')).toBe(true)
        expect(repo.get('sched-del')).toBeNull()
        expect(repo.list()).toHaveLength(0)
    })

    it('删除不存在的 id 返回 false', () => {
        expect(repo.delete('sched-missing')).toBe(false)
    })

    it('列出所有任务，按 created_at 倒序', () => {
        repo.create(makeSchedule({id: 'sched-old'}))
        repo.create(makeSchedule({id: 'sched-new'}))
        // 显式控制 created_at，避免 Date.now() 同毫秒导致排序不确定
        const db = getDatabase()
        db.prepare('UPDATE schedules SET created_at = 1000 WHERE id = ?').run('sched-old')
        db.prepare('UPDATE schedules SET created_at = 2000 WHERE id = ?').run('sched-new')

        const records = repo.list()
        expect(records).toHaveLength(2)
        expect(records[0]!.id).toBe('sched-new')
        expect(records[1]!.id).toBe('sched-old')
    })

    it('按 id 查询', () => {
        repo.create(makeSchedule({id: 'sched-get'}))
        const record = repo.get('sched-get')
        expect(record).not.toBeNull()
        expect(record!.id).toBe('sched-get')
    })

    it('按不存在的 id 查询返回 null', () => {
        expect(repo.get('sched-nope')).toBeNull()
    })

    it('支持前缀匹配 ID 解析', () => {
        repo.create(makeSchedule({id: 'sched-prefix-abc'}))
        const record = repo.get('sched-prefix')
        expect(record).not.toBeNull()
        expect(record!.id).toBe('sched-prefix-abc')
    })

    it('get/update/delete 对不存在的 id 前缀返回 null/false', () => {
        expect(repo.get('sched-missing')).toBeNull()
        expect(repo.update('sched-missing', {name: 'x'})).toBe(false)
        expect(repo.delete('sched-missing')).toBe(false)
    })
})

describe('ScheduleRepository — enabled/paused 过滤', () => {
    beforeEach(() => {
        initStorage()
        resetScheduleTable()
        repo = new ScheduleRepository()
    })
    afterEach(() => {
        closeDatabase()
    })

    it('listEnabled 只返回 enabled 且未 paused 的任务', () => {
        repo.create(makeSchedule({id: 'sched-on', enabled: true, paused: false}))
        repo.create(makeSchedule({id: 'sched-disabled', enabled: false}))
        repo.create(makeSchedule({id: 'sched-paused', enabled: true, paused: true}))

        const records = repo.listEnabled()
        expect(records.map(r => r.id)).toEqual(['sched-on'])
    })

    it('enabled 任务 pause 后从 listEnabled 移除，resume 后恢复', () => {
        repo.create(makeSchedule({id: 'sched-toggle'}))
        expect(repo.listEnabled()).toHaveLength(1)

        repo.update('sched-toggle', {paused: true, pausedAt: Date.now()})
        expect(repo.listEnabled()).toHaveLength(0)
        expect(repo.list()).toHaveLength(1)

        repo.update('sched-toggle', {paused: false})
        expect(repo.listEnabled()).toHaveLength(1)
    })
})

describe('ScheduleRepository — 运行状态更新', () => {
    beforeEach(() => {
        initStorage()
        resetScheduleTable()
        repo = new ScheduleRepository()
    })
    afterEach(() => {
        closeDatabase()
    })

    it('updateRunStatus 写入 running 状态，runCount 不变', () => {
        repo.create(makeSchedule({id: 'sched-run'}))

        expect(repo.updateRunStatus('sched-run', 'running', 'conv-1')).toBe(true)

        const record = repo.get('sched-run')!
        expect(record.lastRunStatus).toBe('running')
        expect(record.lastRunConversationId).toBe('conv-1')
        expect(record.lastRunAt).toBeTypeOf('number')
        expect(record.runCount).toBe(0)
    })

    it('updateRunStatus 成功后 runCount 递增', () => {
        repo.create(makeSchedule({id: 'sched-done'}))

        expect(repo.updateRunStatus('sched-done', 'success', 'conv-2')).toBe(true)

        const record = repo.get('sched-done')!
        expect(record.lastRunStatus).toBe('success')
        expect(record.lastRunConversationId).toBe('conv-2')
        expect(record.runCount).toBe(1)
    })
})

describe('ScheduleRepository — 持久化 round-trip', () => {
    beforeEach(() => {
        initStorage()
        resetScheduleTable()
        repo = new ScheduleRepository()
    })
    afterEach(() => {
        closeDatabase()
    })

    it('写入的任务可在新实例中读取（JSON 字段完整还原）', () => {
        const seed = new ScheduleRepository()
        seed.create(makeSchedule({
            id: 'sched-persist',
            name: '持久化任务',
            taskType: 'skill',
            taskArgs: ['--verbose', {mode: 'full'}],
            workspaceId: 'ws-123',
        }))
        seed.updateRunStatus('sched-persist', 'failure', 'conv-persist')
        seed.update('sched-persist', {enabled: false, paused: true})

        // 关闭后重新初始化，模拟应用重启
        closeDatabase()
        initStorage()
        const fresh = new ScheduleRepository()
        const record = fresh.get('sched-persist')
        expect(record).not.toBeNull()
        expect(record!.name).toBe('持久化任务')
        expect(record!.taskType).toBe('skill')
        expect(record!.taskArgs).toEqual(['--verbose', {mode: 'full'}])
        expect(record!.workspaceId).toBe('ws-123')
        expect(record!.enabled).toBe(false)
        expect(record!.paused).toBe(true)
        expect(record!.lastRunStatus).toBe('failure')
        expect(record!.lastRunConversationId).toBe('conv-persist')
        expect(record!.runCount).toBe(1)
    })
})

describe('ScheduleRepository — 数据边界', () => {
    beforeEach(() => {
        initStorage()
        resetScheduleTable()
        repo = new ScheduleRepository()
    })
    afterEach(() => {
        closeDatabase()
    })

    it('taskArgs 为空时返回空数组而非 null', () => {
        repo.create(makeSchedule({id: 'sched-args', taskArgs: []}))
        const record = repo.get('sched-args')!
        expect(record.taskArgs).toEqual([])
    })

    it('各种 taskType 均可创建', () => {
        for (const taskType of ['agent', 'skill', 'command', 'script'] as const) {
            const id = `sched-type-${taskType}`
            repo.create(makeSchedule({id, taskType}))
            expect(repo.get(id)!.taskType).toBe(taskType)
        }
    })
})

describe('cron 表达式校验 — cron-parser', () => {
    it('合法表达式可通过解析', () => {
        const valid = ['*/5 * * * *', '0 9 * * 1-5', '0 */2 * * *', '*/15 * * * *']
        for (const expr of valid) {
            expect(() => CronExpressionParser.parse(expr)).not.toThrow()
        }
    })

    it('非法表达式抛错', () => {
        const invalid = ['not-a-cron', '61 * * * *', '0 0 0 * *', '* * * 13 *']
        for (const expr of invalid) {
            expect(() => CronExpressionParser.parse(expr)).toThrow()
        }
    })
})
