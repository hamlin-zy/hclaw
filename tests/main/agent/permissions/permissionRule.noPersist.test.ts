// @vitest-environment node — 默认环境即可，无 DOM 依赖
import {describe, expect, it, vi, beforeEach} from 'vitest'

// mock 持久化依赖：systemSettingsRepo 与 permissionRepo，验证不落库
const {mockSysSet, mockSysDelete, mockRepo} = vi.hoisted(() => ({
    mockSysSet: vi.fn(),
    mockSysDelete: vi.fn(),
    mockRepo: {getRules: vi.fn(() => []), saveRules: vi.fn(), addRule: vi.fn(), removeRule: vi.fn()},
}))

vi.mock('@/main/repositories/sqlite/systemSettingsRepository', () => ({
    systemSettingsRepo: {get: vi.fn(() => null), set: mockSysSet, delete: mockSysDelete},
}))
vi.mock('@/main/repositories', () => ({
    createPermissionRepository: () => mockRepo,
}))

import {PermissionRulesManager} from '@/main/agent/permissions/permissionRule'

describe('PermissionRulesManager.applyUpdateNoPersist（会话级模式切换，不落库）', () => {
    let manager: PermissionRulesManager

    beforeEach(async () => {
        vi.clearAllMocks()
        manager = new PermissionRulesManager()
        // 触发懒初始化，loadFromDatabase 读全局默认 'safe'
        await manager.getMode()
    })

    it('setMode 切换内存 context，但不写 system_settings.permission_mode', async () => {
        const ctx = await manager.applyUpdateNoPersist({type: 'setMode', mode: 'auto'})
        expect(ctx.mode).toBe('auto')
        // 内存 context 已切换
        expect((await manager.getContext()).mode).toBe('auto')
        // 不落库：systemSettingsRepo.set 未被调用
        expect(mockSysSet).not.toHaveBeenCalled()
        expect(mockRepo.saveRules).not.toHaveBeenCalled()
    })

    it('safe → auto 切换剥离危险规则（内存内生效），再切回 safe 恢复', async () => {
        const autoCtx = await manager.applyUpdateNoPersist({type: 'setMode', mode: 'auto'})
        const safeCtx = await manager.applyUpdateNoPersist({type: 'setMode', mode: 'safe'})
        expect(safeCtx.mode).toBe('safe')
        expect(mockSysSet).not.toHaveBeenCalled()
    })
})
