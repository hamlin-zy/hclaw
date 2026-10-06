/**
 * deleteSkillOverrides 回归测试
 *
 * 背景：skill_overrides 表此前只有写入路径（writeSkillOverride / writeSkillOverrides），
 * 没有任何删除路径。仓库卸载时需要清掉被卸载仓库下技能的残留启停覆盖，
 * 否则同名 id 重新出现时会带上陈旧的 enabled 覆盖值。
 *
 * 本测试锁定契约：
 * 1. 按 id 精确删除（IN 占位符），未命中的行必须保留；
 * 2. 传入空数组为 no-op，不得清空全表；
 * 3. 失败仅记日志、不抛（卸载流程只把 override 清理失败计入 warnings）。
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// 隔离：把 getHclawDir() 重定向到 os.tmpdir() 下独立目录，绝不触碰真实 ~/.hclaw
vi.mock('../../../src/main/config', async () => {
    const os = await import('os')
    const path = await import('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-skilldel-' + Date.now())
    fs.mkdirSync(path.join(testDir, 'skills'), {recursive: true})
    return {
        getHclawDir: () => testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
    }
})
vi.mock('../../../src/main/hclawPaths', async () => await import('../../../src/main/config'))

import {getDatabase, closeDatabase} from '../../../src/main/repositories/sqlite'
import {deleteSkillOverrides, writeSkillOverride} from '../../../src/main/agent/skills/loader'
import {logger} from '../../../src/main/agent/logger'

let db: ReturnType<typeof getDatabase>

function init() {
    db = getDatabase()
    // 迁移 011 建 skill_overrides 表
    db.exec(`CREATE TABLE IF NOT EXISTS skill_overrides (
        skill_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
    )`)
    // 同一文件内的用例共享同一 tmp DB（getHclawDir 固定），逐例清空以保证隔离
    db.exec('DELETE FROM skill_overrides')
}

function snapshot(): string[] {
    return db.prepare('SELECT skill_id FROM skill_overrides ORDER BY skill_id')
        .all()
        .map((r: {skill_id: string}) => r.skill_id)
}

describe('deleteSkillOverrides — 按 id 精确删除技能覆盖', () => {
    beforeEach(init)
    afterEach(() => {
        vi.restoreAllMocks()
        try { closeDatabase() } catch { /* noop */ }
    })

    it('删除传入 id，未命中的 override 保留', () => {
        writeSkillOverride('a', false)
        writeSkillOverride('b', true)
        writeSkillOverride('c', false)
        expect(snapshot()).toEqual(['a', 'b', 'c'])

        deleteSkillOverrides(['a', 'b'])

        expect(snapshot()).toEqual(['c'])
    })

    it('空数组为 no-op，不得清空全表', () => {
        writeSkillOverride('a', false)
        writeSkillOverride('b', true)

        deleteSkillOverrides([])

        expect(snapshot()).toEqual(['a', 'b'])
    })

    it('失败仅记日志、不抛（表缺失场景）', () => {
        const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {})
        db.exec('DROP TABLE skill_overrides')

        expect(() => deleteSkillOverrides(['a'])).not.toThrow()
        expect(errorSpy).toHaveBeenCalled()
    })
})
