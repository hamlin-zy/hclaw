/**
 * 会话级权限模式 DB 集成测试（真实 SQLite，隔离于 os.tmpdir()）
 *
 * 隔离方式参照 tests/main/repositories/taskBatchRepository.test.ts：
 * vi.mock config → getHclawDir() 重定向到临时目录 → 真 getDatabase() + 生产迁移 DDL
 * → 每用例 DROP 重建，绝不触碰真实 ~/.hclaw/data/hclaw.db。
 *
 * 注意：setConvPermissionMode 走 updateMeta（纯 UPDATE），用例 1 必须先建会话行，
 * 否则无行可更新、readMeta 返回 null（updateMeta 不回退语义）。
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'

// vi.mock 工厂被提升：testDir 在工厂内计算（require 惰性执行），避免 TDZ
vi.mock('@/main/config', () => {
    const os = require('os')
    const path = require('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-convperm-' + Date.now())
    return {
        getHclawDir: () => testDir,
        HCLAW_DIR: testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
        isSafePath: (p: string) => p.startsWith(testDir),
    }
})

import {getDatabase, closeDatabase} from '@/main/repositories/sqlite'
import {runtimeConfigManager} from '@/main/agent/runtimeConfigManager'
import {createConversationRepository} from '@/main/repositories'
import {systemSettingsRepo} from '@/main/repositories/sqlite/systemSettingsRepository'

let db: ReturnType<typeof getDatabase>

// conversations + system_settings 表结构（与生产迁移 001_initial.sql 一致的最小子集）
function setupTables(): void {
    db.exec(`CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        workspace_path TEXT NOT NULL DEFAULT '',
        meta TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    )`)
    db.exec(`CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at INTEGER
    )`)
}

beforeEach(() => {
    db = getDatabase()
    db.exec('DROP TABLE IF EXISTS conversations')
    db.exec('DROP TABLE IF EXISTS system_settings')
    setupTables()
})

afterEach(() => {
    try {
        closeDatabase()
    } catch {
        // 忽略关闭异常
    }
})

describe('会话级权限模式 DB 集成（真实 SQLite）', () => {
    it('setConvPermissionMode → conversations.meta 真写入 permissionMode', () => {
        // updateMeta 是纯 UPDATE：先建会话行，否则影响 0 行、readMeta 返回 null
        createConversationRepository().create('conv-db', {
            id: 'conv-db', title: 'test', workspacePath: '', createdAt: Date.now(),
            updatedAt: Date.now(), preview: '', status: 'active',
        })
        runtimeConfigManager.setConvPermissionMode('conv-db', 'auto')
        const meta = createConversationRepository().readMeta('conv-db') as { permissionMode?: string } | null
        expect(meta?.permissionMode).toBe('auto')
        // 反向断言：会话级切换不写 system_settings（表已重建为空，非 null 即回归）
        expect(systemSettingsRepo.get('permission_mode')).toBeNull()
    })

    it('无 meta 记录 → getConvPermissionMode 回退 system_settings.permission_mode 真值', () => {
        systemSettingsRepo.set('permission_mode', 'auto')
        expect(runtimeConfigManager.getConvPermissionMode('conv-old')).toBe('auto')
    })

    it('applyConvPermissionModeFromMain 不触发 meta 写入', () => {
        runtimeConfigManager.applyConvPermissionModeFromMain('conv-mem', 'auto')
        expect(createConversationRepository().readMeta('conv-mem')).toBeNull()
    })
})
