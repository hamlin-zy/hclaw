/**
 * deleteAgentOverrides 回归测试
 *
 * 背景：agent_overrides 表已有 cleanStalePluginOverrides（按「全部有效模板 id」白名单反删），
 * 但缺少「按 id 精确删除」的能力——仓库卸载时白名单里仍可能包含待卸载仓库的模板 id，
 * 反删无法命中。两者互补：白名单反删清残留，精确删除清指定集合。
 *
 * 本测试锁定契约：
 * 1. 按 id 精确删除，未命中的行必须保留；
 * 2. 传入空数组为 no-op（与 cleanStalePluginOverrides 的防御守卫一致）；
 * 3. 异步签名返回 Promise，可 await；
 * 4. 失败仅记日志、不抛。
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// 隔离：把 getHclawDir() 重定向到 os.tmpdir() 下独立目录，绝不触碰真实 ~/.hclaw
vi.mock('../../../src/main/config', async () => {
    const os = await import('os')
    const path = await import('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-agentdel-' + Date.now())
    fs.mkdirSync(path.join(testDir, 'agents'), {recursive: true})
    return {
        getHclawDir: () => testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
    }
})
vi.mock('../../../src/main/hclawPaths', async () => await import('../../../src/main/config'))

import {getDatabase, closeDatabase} from '../../../src/main/repositories/sqlite'
import {deleteAgentOverrides, updatePluginAgentOverride} from '../../../src/main/agent/agentLoader'
import {logger} from '../../../src/main/agent/logger'

let db: ReturnType<typeof getDatabase>

function init() {
    db = getDatabase()
    // 迁移 011 建 agent_overrides 表
    db.exec(`CREATE TABLE IF NOT EXISTS agent_overrides (
        agent_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
    )`)
    // 同一文件内的用例共享同一 tmp DB（getHclawDir 固定），逐例清空以保证隔离
    db.exec('DELETE FROM agent_overrides')
}

function snapshot(): string[] {
    return db.prepare('SELECT agent_id FROM agent_overrides ORDER BY agent_id')
        .all()
        .map((r: {agent_id: string}) => r.agent_id)
}

describe('deleteAgentOverrides — 按 id 精确删除 Agent 覆盖', () => {
    beforeEach(init)
    afterEach(() => {
        vi.restoreAllMocks()
        try { closeDatabase() } catch { /* noop */ }
    })

    it('删除传入 id，未命中的 override 保留', async () => {
        await updatePluginAgentOverride('a', false)
        await updatePluginAgentOverride('b', true)
        await updatePluginAgentOverride('c', false)
        expect(snapshot()).toEqual(['a', 'b', 'c'])

        await deleteAgentOverrides(['a', 'b'])

        expect(snapshot()).toEqual(['c'])
    })

    it('空数组为 no-op，不得清空全表', async () => {
        await updatePluginAgentOverride('a', false)
        await updatePluginAgentOverride('b', true)

        await deleteAgentOverrides([])

        expect(snapshot()).toEqual(['a', 'b'])
    })

    it('返回 Promise（异步签名可 await）', async () => {
        const ret = deleteAgentOverrides([])
        expect(ret).toBeInstanceOf(Promise)
        await ret
    })

    it('失败仅记日志、不抛（表缺失场景）', async () => {
        const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {})
        db.exec('DROP TABLE agent_overrides')

        await expect(deleteAgentOverrides(['a'])).resolves.toBeUndefined()
        expect(errorSpy).toHaveBeenCalled()
    })
})
