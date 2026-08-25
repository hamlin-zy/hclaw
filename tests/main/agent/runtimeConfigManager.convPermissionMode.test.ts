import {beforeEach, describe, expect, it, vi} from 'vitest'

const {mockReadMeta, mockUpdateMeta, mockSysGet, mockSysSet} = vi.hoisted(() => ({
    mockReadMeta: vi.fn(),
    mockUpdateMeta: vi.fn(),
    mockSysGet: vi.fn(),
    mockSysSet: vi.fn(),
}))

// 与仓库既有约定一致（permissionRule.test.ts / runtimeConfigManager.override.test.ts）：
// mock 与 import 统一走 @/ 别名，保证解析到同一模块。
vi.mock('@/main/repositories', () => ({
    createConversationRepository: () => ({
        readMeta: mockReadMeta,
        updateMeta: mockUpdateMeta,
    }),
}))

vi.mock('@/main/repositories/sqlite/systemSettingsRepository', () => ({
    systemSettingsRepo: {get: mockSysGet, set: mockSysSet, delete: vi.fn()},
}))

import {runtimeConfigManager} from '@/main/agent/runtimeConfigManager'

describe('会话级权限模式状态机', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockReadMeta.mockReturnValue(null)
        mockSysGet.mockReturnValue('safe')
    })

    it('setConvPermissionMode 更新内存 Map 并固化到 meta（不写 system_settings）', () => {
        runtimeConfigManager.setConvPermissionMode('conv-a', 'auto')
        expect(runtimeConfigManager.getConvPermissionMode('conv-a')).toBe('auto')
        expect(mockUpdateMeta).toHaveBeenCalledWith('conv-a', expect.objectContaining({permissionMode: 'auto'}))
        expect(mockSysSet).not.toHaveBeenCalled() // 会话级切换绝不写 system_settings
    })

    it('会话独立：A 改 auto 不影响 B（B 回退全局）', () => {
        runtimeConfigManager.setConvPermissionMode('conv-a', 'auto')
        expect(runtimeConfigManager.getConvPermissionMode('conv-a')).toBe('auto')
        expect(runtimeConfigManager.getConvPermissionMode('conv-b')).toBe('safe') // 全局默认
    })

    it('无 meta 记录 → 懒加载回退全局 system_settings.permission_mode', () => {
        mockSysGet.mockReturnValue('auto')
        expect(runtimeConfigManager.getConvPermissionMode('conv-old')).toBe('auto')
        expect(mockReadMeta).toHaveBeenCalledWith('conv-old')
    })

    it('meta 有固化值 → 懒加载返回固化值，且命中缓存后不再读 DB', () => {
        mockReadMeta.mockReturnValue({id: 'conv-db', permissionMode: 'safe'} as any)
        expect(runtimeConfigManager.getConvPermissionMode('conv-db')).toBe('safe')
        runtimeConfigManager.getConvPermissionMode('conv-db')
        expect(mockReadMeta).toHaveBeenCalledTimes(1)
    })

    it('applyConvPermissionModeFromMain 仅设内存，不落库、不读 DB', () => {
        runtimeConfigManager.setConvPermissionMode('conv-x', 'safe')
        mockUpdateMeta.mockClear()
        runtimeConfigManager.applyConvPermissionModeFromMain('conv-x', 'auto')
        expect(runtimeConfigManager.getConvPermissionMode('conv-x')).toBe('auto')
        expect(mockUpdateMeta).not.toHaveBeenCalled()
    })
})
