// @vitest-environment node
/**
 * PermissionEngine.cleanAndSave —— 会话级权限模式保全回归（真 manager + 临时 DB）
 *
 * 背景（P1）：worker 每轮检测到规则数变化后会调 cleanAndSave()。旧实现 = reloadRules()，
 * 会把引擎 mode 重置为 DB 全局默认值（system_settings.permission_mode），从而吞掉本
 * worker 的会话级模式：
 *   - 会话级 auto → 退回 safe（一直弹确认，UI 仍显示「自动」）；
 *   - 全局 auto + 会话级 safe → 被静默升级为 auto（权限放宽）。
 * 修复后 cleanAndSave = 只去重 + 落库，不重载 mode。
 *
 * SQLite 策略与 permissionRule.test.ts 一致：mock @/main/config 重定向到 os.tmpdir()
 * 独立临时目录，走真实 @photostructure/sqlite。
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'

vi.mock('@/main/config', async () => {
    const {tmpdir} = await import('node:os')
    const pathMod = await import('node:path')
    const testDir = pathMod.join(tmpdir(), 'hclaw-test-permengine-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
        getHclawDataDir: () => pathMod.join(testDir, 'data'),
    }
})
vi.mock('@/main/hclawPaths', async () => await import('@/main/config'))  // 路径能力已下沉到叶子 hclawPaths：让叶子跟随本文件对 config 的桩，避免绕过 mock 落到真实 ~/.hclaw

import {initStorage} from '@/main/repositories'
import {closeDatabase, getDatabase} from '@/main/repositories/sqlite'
import {PermissionRulesManager, permissionRulesManager} from '@/main/agent/permissions/permissionRule'
import {PermissionEngine} from '@/main/agent/tools/permission'
import type {PermissionRule} from '@shared/types'

function makeRule(tool: string, action: 'allow' | 'deny' | 'ask' = 'allow'): PermissionRule {
    return {tool, action}
}

function resetPermissionTables(): void {
    const db = getDatabase()
    db.exec('DELETE FROM permission_rules')
    db.exec('DELETE FROM system_settings WHERE key IN (\'permission_mode\', \'permission_pre_plan_mode\', \'permission_stripped_dangerous_rules\')')
}

describe('PermissionEngine.cleanAndSave — 会话级 mode 保全', () => {
    beforeEach(() => {
        initStorage()
        resetPermissionTables()
    })
    afterEach(() => {
        closeDatabase()
    })

    it('会话级 auto：cleanAndSave() 后仍为 auto（不退回 DB 全局 safe）', async () => {
        // 把全局单例拉到 DB 基线（safe / 无规则）
        await permissionRulesManager.reload()

        const engine = new PermissionEngine()
        await engine.ensureReady()
        await engine.applyModeFromMain('auto')
        expect(await engine.getMode()).toBe('auto')

        // 另一实例（模拟权限面板）写入一条规则并落库 —— 这正是触发规则数变化、进而触发
        // cleanAndSave 的场景
        const panel = new PermissionRulesManager()
        await panel.applyUpdate({type: 'addRule', rule: makeRule('m_github_create_issue', 'allow')})

        await engine.cleanAndSave()

        expect(await engine.getMode()).toBe('auto')
        expect((await engine.getRules()).map((r) => r.tool)).toEqual(['m_github_create_issue'])
        // DB 全局仍为 safe（cleanAndSave 不得把会话级 auto 写回全局）
        const fresh = new PermissionRulesManager()
        expect((await fresh.getContext()).mode).toBe('safe')
    })

    it('全局 auto + 会话级 safe：cleanAndSave() 后仍为 safe（不被静默升级为 auto）', async () => {
        // 先把 DB 全局默认置为 auto，并让全局单例与该基线对齐
        const seed = new PermissionRulesManager()
        await seed.applyUpdate({type: 'setMode', mode: 'auto'})
        await permissionRulesManager.reload()

        const engine = new PermissionEngine()
        await engine.ensureReady()
        expect(await engine.getMode()).toBe('auto')

        // 会话级降级到 safe（仅内存）
        await engine.applyModeFromMain('safe')
        await engine.cleanAndSave()

        expect(await engine.getMode()).toBe('safe')
    })
})
