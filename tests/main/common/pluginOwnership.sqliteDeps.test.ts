/**
 * pluginOwnership 默认依赖（SQLite 适配层）测试
 *
 * 覆盖此前无测试的真实 deps 路径：
 *   pluginOwnership.readOverrideMap / createSqliteOwnershipDeps
 *   → 惰性 require('../repositories/sqlite') → OVERRIDE_TABLES 的表名/列名。
 *
 * 锁定契约：agent/skill/command 各自读 agent_overrides / skill_overrides /
 * command_overrides 的 agent_id / skill_id / command_id 列，且互不串表。
 *
 * 隔离：把 getHclawDir() 重定向到 os.tmpdir() 下的独立目录，绝不触碰真实 ~/.hclaw。
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../../../src/main/config', async () => {
    const osMod = await import('os')
    const pathMod = await import('path')
    const testDir = pathMod.join(
        osMod.tmpdir(),
        'hclaw-test-ownership-' + Date.now() + '-' + Math.random().toString(36).slice(2),
    )
    fs.mkdirSync(testDir, {recursive: true})
    return {
        getHclawDir: () => testDir,
        getHclawDataDir: () => pathMod.join(testDir, 'data'),
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
    }
})

import {getDatabase, closeDatabase} from '../../../src/main/repositories/sqlite'
import {createSqliteOwnershipDeps} from '@/main/common/pluginOwnership'

let db: ReturnType<typeof getDatabase>

function init() {
    db = getDatabase()
    db.exec(`
        CREATE TABLE IF NOT EXISTS agent_overrides (
            agent_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS skill_overrides (
            skill_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS command_overrides (
            command_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    `)
}

function insert(table: string, column: string, id: string, enabled: number) {
    db.prepare(`INSERT OR REPLACE INTO ${table} (${column}, enabled, updated_at) VALUES (?, ?, ?)`)
        .run(id, enabled, Date.now())
}

describe('createSqliteOwnershipDeps — 真实 SQLite 读取（表名/列名契约）', () => {
    beforeEach(init)
    afterEach(() => {
        try { closeDatabase() } catch { /* noop */ }
    })

    it('按 kind 读取对应 override 表与 id 列，enabled 0/1 → false/true', () => {
        insert('agent_overrides', 'agent_id', 'demo:agents/x', 0)
        insert('skill_overrides', 'skill_id', 'demo:my-skill', 1)
        insert('command_overrides', 'command_id', 'demo:my-cmd', 0)

        const deps = createSqliteOwnershipDeps()

        expect(deps.getOverrideEnabled('agent', 'demo:agents/x')).toBe(false)
        expect(deps.getOverrideEnabled('skill', 'demo:my-skill')).toBe(true)
        expect(deps.getOverrideEnabled('command', 'demo:my-cmd')).toBe(false)
    })

    it('未覆盖的 id 返回 undefined（交由文件默认兜底）', () => {
        const deps = createSqliteOwnershipDeps()
        expect(deps.getOverrideEnabled('agent', 'nope')).toBeUndefined()
        expect(deps.getOverrideEnabled('skill', 'nope')).toBeUndefined()
        expect(deps.getOverrideEnabled('command', 'nope')).toBeUndefined()
    })

    it('不串表：仅存在于其他 kind 表的 id 不被返回', () => {
        insert('skill_overrides', 'skill_id', 'shared-id', 0)

        const deps = createSqliteOwnershipDeps()

        expect(deps.getOverrideEnabled('skill', 'shared-id')).toBe(false)
        expect(deps.getOverrideEnabled('agent', 'shared-id')).toBeUndefined()
        expect(deps.getOverrideEnabled('command', 'shared-id')).toBeUndefined()
    })

    it('同一实例内按 kind 快照一次（创建后再插入不可见）', () => {
        const deps = createSqliteOwnershipDeps()
        expect(deps.getOverrideEnabled('agent', 'late')).toBeUndefined()

        insert('agent_overrides', 'agent_id', 'late', 1)
        expect(deps.getOverrideEnabled('agent', 'late')).toBeUndefined()

        // 新实例重新读库可见
        expect(createSqliteOwnershipDeps().getOverrideEnabled('agent', 'late')).toBe(true)
    })

    it('getDisabledNames 走 PluginRegistry（未注册插件时为空集）', () => {
        const deps = createSqliteOwnershipDeps()
        expect(deps.getDisabledNames().size).toBe(0)
    })
})
