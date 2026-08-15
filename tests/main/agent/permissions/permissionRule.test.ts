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
import * as os from 'os'
import * as path from 'path'

// 隔离：重定向到 os.tmpdir() 下的独立临时目录，绝不触碰真实 ~/.hclaw/data/hclaw.db
vi.mock('@/main/config', () => {
    const os = require('os')
    const path = require('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-permission-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
    }
})

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
