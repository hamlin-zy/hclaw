/**
 * PermissionRulesManager 单元测试
 *
 * 覆盖：规则增删改、模式转换状态机（safe↔auto 危险规则剥离/恢复）、持久化。
 *
 * SQLite 策略（与 conversationRepository.recovery.test.ts 一致）：
 * vi.mock config 重定向到 os.tmpdir() 独立临时目录，走真实 @photostructure/sqlite，
 * 不 mock repository 层，验证完整持久化链路。
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'

// 隔离：重定向到 os.tmpdir() 下的独立临时目录，绝不触碰真实 ~/.hclaw/data/hclaw.db
vi.mock('@/main/config', async () => {
    const {tmpdir} = await import('node:os')
    const pathMod = await import('node:path')
    const testDir = pathMod.join(tmpdir(), 'hclaw-test-permission-' + Date.now())
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
import type {PermissionRule, PermissionUpdate} from '@shared/types'

function makeRule(tool: string, action: 'allow' | 'deny' | 'ask' = 'allow'): PermissionRule {
    return {tool, action}
}

/** 清空权限表，保证每个用例从干净状态开始（与 recovery 测试 DROP 惯例一致） */
function resetPermissionTables(): void {
    const db = getDatabase()
    db.exec('DELETE FROM permission_rules')
    db.exec('DELETE FROM system_settings WHERE key IN (\'permission_mode\', \'permission_pre_plan_mode\', \'permission_stripped_dangerous_rules\')')
}

describe('PermissionRulesManager — 默认上下文', () => {
    beforeEach(() => {
        initStorage()
        resetPermissionTables()
    })
    afterEach(() => {
        closeDatabase()
    })

    it('默认模式为 safe，规则为空', async () => {
        const mgr = new PermissionRulesManager()
        const context = await mgr.getContext()
        expect(context.mode).toBe('safe')
        expect(context.rules).toEqual([])
        expect(context.isAutoModeAvailable).toBe(true)
    })

    it('从数据库加载已有规则和模式', async () => {
        // 先写入，再用新实例加载
        const seed = new PermissionRulesManager()
        await seed.applyUpdate({type: 'addRule', rule: makeRule('file_read')})
        await seed.applyUpdate({type: 'setMode', mode: 'auto'})

        const mgr = new PermissionRulesManager()
        const context = await mgr.getContext()
        expect(context.mode).toBe('auto')
        expect(context.rules).toHaveLength(1)
        expect(context.rules[0]!.tool).toBe('file_read')
    })
})

describe('PermissionRulesManager — 规则管理', () => {
    beforeEach(() => {
        initStorage()
        resetPermissionTables()
    })
    afterEach(() => {
        closeDatabase()
    })

    it('addRule 替换同 tool 旧规则', async () => {
        const mgr = new PermissionRulesManager()
        await mgr.applyUpdate({type: 'addRule', rule: makeRule('file_read')})
        await mgr.applyUpdate({type: 'addRule', rule: makeRule('file_read', 'deny')})

        const rules = await mgr.getRules()
        expect(rules).toHaveLength(1)
        expect(rules[0]!.action).toBe('deny')
    })

    it('removeRule 删除指定工具规则', async () => {
        const mgr = new PermissionRulesManager()
        await mgr.applyUpdate({type: 'addRule', rule: makeRule('bash')})
        await mgr.applyUpdate({type: 'addRule', rule: makeRule('file_read')})
        await mgr.applyUpdate({type: 'removeRule', tool: 'bash'})

        const rules = await mgr.getRules()
        expect(rules).toHaveLength(1)
        expect(rules[0]!.tool).toBe('file_read')
    })

    it('setRules 按 tool 去重（保留最后一条）', async () => {
        const mgr = new PermissionRulesManager()
        const update: PermissionUpdate = {
            type: 'setRules',
            rules: [
                makeRule('file_read'),
                makeRule('file_read', 'deny'),
                makeRule('glob'),
            ],
        }
        await mgr.applyUpdate(update)

        const rules = await mgr.getRules()
        expect(rules).toHaveLength(2)
        const fileReadRule = rules.find((r) => r.tool === 'file_read')
        expect(fileReadRule!.action).toBe('deny')
    })

    it('setRules 补充缺失的 createdAt', async () => {
        const mgr = new PermissionRulesManager()
        await mgr.applyUpdate({type: 'setRules', rules: [makeRule('file_read')]})
        const rules = await mgr.getRules()
        expect(rules[0]!.createdAt).toBeTypeOf('number')
    })
})

describe('PermissionRulesManager — 模式转换状态机', () => {
    beforeEach(() => {
        initStorage()
        resetPermissionTables()
    })
    afterEach(() => {
        closeDatabase()
    })

    it('safe→auto 剥离危险规则，auto→safe 恢复', async () => {
        const mgr = new PermissionRulesManager()
        await mgr.applyUpdate({
            type: 'setRules',
            rules: [
                makeRule('bash'),          // tool-level allow — 危险
                makeRule('bash:python:*'), // 解释器 — 危险
                makeRule('file_read'),     // 安全
            ],
        })

        // 进入 auto：剥离危险规则
        await mgr.applyUpdate({type: 'setMode', mode: 'auto'})
        const autoContext = await mgr.getContext()
        expect(autoContext.mode).toBe('auto')
        expect(autoContext.rules.map((r) => r.tool)).toEqual(['file_read'])
        expect(autoContext.strippedDangerousRules).toHaveLength(2)

        // 退出 auto：恢复危险规则
        await mgr.applyUpdate({type: 'setMode', mode: 'safe'})
        const safeContext = await mgr.getContext()
        expect(safeContext.mode).toBe('safe')
        expect(safeContext.rules).toHaveLength(3)
        expect(safeContext.strippedDangerousRules).toBeUndefined()
    })

    it('无危险规则时进入 auto 不产生 strippedDangerousRules', async () => {
        const mgr = new PermissionRulesManager()
        await mgr.applyUpdate({type: 'setRules', rules: [makeRule('file_read')]})
        await mgr.applyUpdate({type: 'setMode', mode: 'auto'})

        const context = await mgr.getContext()
        expect(context.mode).toBe('auto')
        expect(context.rules).toHaveLength(1)
        expect(context.strippedDangerousRules).toEqual([])
    })

    it('恢复危险规则时同 tool 规则以 stripped 版本为准', async () => {
        const mgr = new PermissionRulesManager()
        // 初始：bash 危险规则
        await mgr.applyUpdate({type: 'setRules', rules: [makeRule('bash')]})
        // 进入 auto：剥离 bash
        await mgr.applyUpdate({type: 'setMode', mode: 'auto'})
        // auto 模式下添加一条新的 bash 规则（deny）
        await mgr.applyUpdate({type: 'addRule', rule: makeRule('bash', 'deny')})
        // 退出 auto：stripped 的 allow 应覆盖 deny（stripped 优先）
        await mgr.applyUpdate({type: 'setMode', mode: 'safe'})

        const context = await mgr.getContext()
        const bashRule = context.rules.find((r) => r.tool === 'bash')
        expect(bashRule!.action).toBe('allow')
        expect(context.rules).toHaveLength(1)
    })

    it('相同模式切换为无操作', async () => {
        const mgr = new PermissionRulesManager()
        await mgr.applyUpdate({type: 'setMode', mode: 'safe'})
        await mgr.applyUpdate({type: 'setMode', mode: 'safe'})

        const context = await mgr.getContext()
        expect(context.mode).toBe('safe')
        expect(context.strippedDangerousRules).toBeUndefined()
    })
})

describe('PermissionRulesManager — 持久化与加载', () => {
    beforeEach(() => {
        initStorage()
        resetPermissionTables()
    })
    afterEach(() => {
        closeDatabase()
    })

    it('setMode 持久化模式配置，新实例可加载', async () => {
        const mgr = new PermissionRulesManager()
        await mgr.applyUpdate({type: 'setMode', mode: 'auto'})

        const fresh = new PermissionRulesManager()
        const context = await fresh.getContext()
        expect(context.mode).toBe('auto')
    })

    it('加载 strippedDangerousRules 配置', async () => {
        const seed = new PermissionRulesManager()
        await seed.applyUpdate({type: 'setRules', rules: [makeRule('bash')]})
        await seed.applyUpdate({type: 'setMode', mode: 'auto'})
        // 验证内存中被剥离的规则已持久化到配置
        const context = await seed.getContext()
        expect(context.strippedDangerousRules).toHaveLength(1)
        expect(context.strippedDangerousRules![0]!.tool).toBe('bash')
        expect(context.strippedDangerousRules![0]!.action).toBe('allow')

        // 新实例从数据库恢复（stripped 规则以 JSON 完整持久化，含 createdAt）
        const fresh = new PermissionRulesManager()
        const freshContext = await fresh.getContext()
        expect(freshContext.mode).toBe('auto')
        expect(freshContext.strippedDangerousRules).toHaveLength(1)
        expect(freshContext.strippedDangerousRules![0]!.tool).toBe('bash')
        expect(freshContext.strippedDangerousRules![0]!.action).toBe('allow')
    })
})

describe('PermissionRulesManager — reloadRulesOnly / dedupeAndSaveRules（只刷规则、保会话级 mode）', () => {
    beforeEach(() => {
        initStorage()
        resetPermissionTables()
    })
    afterEach(() => {
        closeDatabase()
    })

    it('reloadRulesOnly 刷新 DB 新规则，且保留会话级 auto（DB 全局 safe 不覆盖）', async () => {
        const mgr = new PermissionRulesManager()
        // 会话级 auto：仅内存，不落库
        await mgr.applyUpdateNoPersist({type: 'setMode', mode: 'auto'})
        // 面板（主进程）在 DB 新增一条 deny
        const panel = new PermissionRulesManager()
        await panel.applyUpdate({type: 'addRule', rule: makeRule('file_read', 'deny')})

        const rules = await mgr.reloadRulesOnly()

        expect(rules.map((r) => r.tool)).toEqual(['file_read'])
        expect(rules[0]!.action).toBe('deny')
        expect(await mgr.getMode()).toBe('auto')
        // DB 全局未被 reloadRulesOnly 改写
        const fresh = new PermissionRulesManager()
        expect((await fresh.getContext()).mode).toBe('safe')
    })

    it('reloadRulesOnly 在 auto 下重跑危险规则剥离（新载入的危险 allow 不复活）', async () => {
        const mgr = new PermissionRulesManager()
        await mgr.applyUpdateNoPersist({type: 'setMode', mode: 'auto'})
        const panel = new PermissionRulesManager()
        await panel.applyUpdate({type: 'addRule', rule: makeRule('bash:python:*', 'allow')})
        await panel.applyUpdate({type: 'addRule', rule: makeRule('file_read', 'allow')})

        const rules = await mgr.reloadRulesOnly()

        expect(rules.map((r) => r.tool)).toEqual(['file_read'])
        const ctx = await mgr.getContext()
        expect((ctx.strippedDangerousRules ?? []).map((r) => r.tool)).toContain('bash:python:*')
    })

    it('dedupeAndSaveRules 保会话级 auto，且规则集合完整落库', async () => {
        const mgr = new PermissionRulesManager()
        await mgr.applyUpdateNoPersist({type: 'setMode', mode: 'auto'})
        const panel = new PermissionRulesManager()
        await panel.applyUpdate({type: 'addRule', rule: makeRule('file_read', 'deny')})
        await panel.applyUpdate({type: 'addRule', rule: makeRule('m_a', 'allow')})

        const rules = await mgr.dedupeAndSaveRules()

        expect(new Set(rules.map((r) => r.tool))).toEqual(new Set(['file_read', 'm_a']))
        expect(await mgr.getMode()).toBe('auto')
        const fresh = new PermissionRulesManager()
        expect(new Set((await fresh.getRules()).map((r) => r.tool))).toEqual(new Set(['file_read', 'm_a']))
    })

    it('addRule 不把会话级 mode 写成全局默认（permission_mode 保持 DB 原值）', async () => {
        const mgr = new PermissionRulesManager()
        // 会话级 auto（仅内存）
        await mgr.applyUpdateNoPersist({type: 'setMode', mode: 'auto'})
        // 会话内「始终允许」→ addRule 落库规则，但不得回写会话级 mode
        await mgr.applyUpdate({type: 'addRule', rule: makeRule('m_github_create_issue', 'allow')})

        const fresh = new PermissionRulesManager()
        const ctx = await fresh.getContext()
        expect(ctx.mode).toBe('safe')
        expect(ctx.rules.map((r) => r.tool)).toEqual(['m_github_create_issue'])
    })
})

describe('permissionRulesManager 单例', () => {
    beforeEach(() => {
        initStorage()
        resetPermissionTables()
    })
    afterEach(() => {
        closeDatabase()
    })

    it('导出全局单例实例', () => {
        expect(permissionRulesManager).toBeInstanceOf(PermissionRulesManager)
    })
})
