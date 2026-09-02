/**
 * cleanStalePluginOverrides 回归测试
 *
 * 背景：该函数用于清理 agent_overrides 中已不存在 Agent 的残留记录。
 * 历史缺陷是调用方只以「插件 Agent id」作为白名单，导致每次全量扫描都误删
 * 仓库/本地 Agent 的启停覆盖，批量启停刷新后失效。
 *
 * 本测试锁定核心契约：凡出现在 validAgentIds（当前全部有效模板 id）中的
 * override 必须被保留；不在其中的才会被清理。
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// 隔离：把 getHclawDir() 重定向到 os.tmpdir() 下独立目录，绝不触碰真实 ~/.hclaw
vi.mock('../../../src/main/config', async () => {
    const os = await import('os')
    const path = await import('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-cleanstale-' + Date.now())
    fs.mkdirSync(path.join(testDir, 'agents'), {recursive: true})
    return {
        getHclawDir: () => testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
    }
})

import {getDatabase, saveDatabase, closeDatabase} from '../../../src/main/repositories/sqlite'
import {cleanStalePluginOverrides} from '../../../src/main/agent/agentLoader'

let db: ReturnType<typeof getDatabase>

function init() {
    db = getDatabase()
    // 迁移 011 建 agent_overrides 表
    db.exec(`CREATE TABLE IF NOT EXISTS agent_overrides (
        agent_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
    )`)
}

function insert(id: string, enabled: number) {
    db.prepare('INSERT OR REPLACE INTO agent_overrides (agent_id, enabled, updated_at) VALUES (?, ?, ?)')
        .run(id, enabled, Date.now())
}

function snapshot() {
    return db.prepare('SELECT agent_id FROM agent_overrides').all().map((r: {agent_id: string}) => r.agent_id)
}

describe('cleanStalePluginOverrides — 保留仍在用的 override', () => {
    beforeEach(init)
    afterEach(() => {
        try { closeDatabase() } catch { /* noop */ }
    })

    it('存在于 validAgentIds 中的仓库/本地 override 不被误删（回归：误删仓库启停）', async () => {
        // 模拟仓库/本地 Agent 与插件 Agent 的 override
        const repoAgentId = 'local-agency-agents@source\\agents\\java-reviewer'
        const pluginAgentId = 'local-ECC@github:agents/java-reviewer'
        insert(repoAgentId, 0)
        insert(pluginAgentId, 1)

        // 修复后：白名单是「全部有效模板 id」，包含仓库与插件
        const validAgentIds = new Set([repoAgentId, pluginAgentId])
        await cleanStalePluginOverrides(validAgentIds)

        const ids = snapshot()
        expect(ids).toContain(repoAgentId)
        expect(ids).toContain(pluginAgentId)
    })

    it('不在 validAgentIds 中的残留 override 被清理', async () => {
        insert('local-ECC@github:agents/ghost', 1)
        insert('local-agency-agents@source\\agents\\ghost', 1)

        await cleanStalePluginOverrides(new Set(['local-ECC@github:agents/real']))

        const ids = snapshot()
        expect(ids).not.toContain('local-ECC@github:agents/ghost')
        expect(ids).not.toContain('local-agency-agents@source\\agents\\ghost')
    })

    it('validAgentIds 为空时不做任何清理（防御守卫）', async () => {
        insert('local-agency-agents@source\\agents\\java-reviewer', 0)
        await cleanStalePluginOverrides(new Set<string>())
        expect(snapshot().length).toBe(1)
    })
})
