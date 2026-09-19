/**
 * ScheduleRepository is_system 字段测试
 *
 * 验证：isSystem 字段的持久化与读取，以及省略时的默认值（false）。
 *
 * SQLite 策略与 ScheduleRepository.test.ts 一致：
 * vi.mock config 重定向到 os.tmpdir() 独立临时目录，走真实 SQLite。
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'
import * as os from 'os'
import * as path from 'path'

vi.mock('@/main/config', () => {
    const os = require('os')
    const path = require('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-schedule-issystem-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
    }
})
vi.mock('@/main/hclawPaths', async () => await import('@/main/config'))

import {initStorage} from '@/main/repositories'
import {closeDatabase, getDatabase} from '@/main/repositories/sqlite'
import {ScheduleRepository} from '@/main/scheduler/ScheduleRepository'

function resetScheduleTable(): void {
    const db = getDatabase()
    db.exec('DELETE FROM schedules')
}

let repo: ScheduleRepository

describe('ScheduleRepository is_system', () => {
    beforeEach(() => {
        initStorage()
        resetScheduleTable()
        repo = new ScheduleRepository()
    })
    afterEach(() => {
        closeDatabase()
    })

    it('should persist and read isSystem=true', () => {
        repo.create({
            id: 'test-1', name: 'Test', description: '', cronExpression: '0 * * * *',
            taskType: 'agent', taskTarget: 'General', taskArgs: [], enabled: true,
            paused: false, pausedAt: null, workspaceId: null, isSystem: true,
        })
        const record = repo.get('test-1')
        expect(record).toBeDefined()
        expect(record!.isSystem).toBe(true)
    })

    it('should default isSystem to false when not provided', () => {
        repo.create({
            id: 'test-2', name: 'User Task', description: '', cronExpression: '0 * * * *',
            taskType: 'script', taskTarget: 'test.ps1', taskArgs: [], enabled: true,
            paused: false, pausedAt: null, workspaceId: null,
        })
        const record = repo.get('test-2')
        expect(record!.isSystem).toBe(false)
    })

    it('should allow updating isSystem via update()', () => {
        repo.create({
            id: 'test-3', name: 'Switchable', description: '', cronExpression: '0 * * * *',
            taskType: 'agent', taskTarget: 'X', taskArgs: [], enabled: true,
            paused: false, pausedAt: null, workspaceId: null, isSystem: false,
        })
        repo.update('test-3', {isSystem: true})
        expect(repo.get('test-3')!.isSystem).toBe(true)

        repo.update('test-3', {isSystem: false})
        expect(repo.get('test-3')!.isSystem).toBe(false)
    })
})
