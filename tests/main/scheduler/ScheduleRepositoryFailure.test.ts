/**
 * ScheduleRepository — 存储异常不再降级为 fallback 值
 *
 * 隔离：mock 掉 sqlite 模块，让每一次 DB 调用都失败（模拟数据库坏掉/不可用）。
 * 断言仓储层抛带 code 的 ScheduleError('STORAGE_FAILURE')，
 * 而不是旧行为那样把写失败吞成 false / 把读失败吞成 null / []。
 *
 * 用独立文件是因为这里的 vi.mock 与 ScheduleRepository.test.ts 的真实 SQLite 策略互斥。
 */
import {describe, expect, it, vi} from 'vitest'

vi.mock('@/main/repositories/sqlite', () => ({
    getDatabase: () => { throw new Error('database is closed') },
    saveDatabase: () => {},
}))

import {ScheduleRepository} from '@/main/scheduler/ScheduleRepository'
import {ScheduleError} from '@/main/scheduler/scheduleErrors'

const repo = new ScheduleRepository()

const newRecord = {
    id: 'sched-broken', name: '坏存储', description: '', cronExpression: '* * * * *',
    taskType: 'agent' as const, taskTarget: 't', taskArgs: [], enabled: true, paused: false,
    pausedAt: null, workspaceId: null,
}

/** 断言抛出的是 STORAGE_FAILURE，而不是被降级成返回值 */
function expectStorageFailure(fn: () => unknown): void {
    let thrown: unknown
    try { fn() } catch (err) { thrown = err }
    expect(thrown).toBeInstanceOf(ScheduleError)
    expect((thrown as ScheduleError).code).toBe('STORAGE_FAILURE')
}

describe('ScheduleRepository — 存储异常', () => {
    it('list / listEnabled 抛 STORAGE_FAILURE（不再返回 []）', () => {
        expectStorageFailure(() => repo.list())
        expectStorageFailure(() => repo.listEnabled())
    })

    it('get 抛 STORAGE_FAILURE（不再返回 null）', () => {
        expectStorageFailure(() => repo.get('sched-broken'))
    })

    it('create 抛 STORAGE_FAILURE（不再返回 false）', () => {
        expectStorageFailure(() => repo.create(newRecord))
    })

    it('update 抛 STORAGE_FAILURE（不再返回 false）', () => {
        expectStorageFailure(() => repo.update('sched-broken', {name: 'x'}))
    })

    it('delete 抛 STORAGE_FAILURE（不再返回 false）', () => {
        expectStorageFailure(() => repo.delete('sched-broken'))
    })

    it('updateRunStatus 抛 STORAGE_FAILURE（不再返回 false）', () => {
        expectStorageFailure(() => repo.updateRunStatus('sched-broken', 'failure'))
    })
})
