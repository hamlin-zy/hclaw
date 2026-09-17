/**
 * releaseConvState —— 会话态内存缓存成对释放（内存泄漏 B 批 S2）
 *
 * 背景：sessionOverrides / sessionPermissionModes 是模块级 Map，键为 convId 且无任何
 * delete 路径 → 条目随会话数无界累积。会话删除 / run 结束清理（clearConversation）
 * 时必须成对释放。两 Map 均为「无 key = 未加载」语义，delete 后再次读取走既有懒回读
 * （override → meta.modelOverride；权限模式 → meta.permissionMode → 全局默认），
 * 因此释放不改变生效值，只回收内存。
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'

const {mockReadMeta, mockUpdateMeta, mockSysGet, mockSysSet} = vi.hoisted(() => ({
    mockReadMeta: vi.fn(),
    mockUpdateMeta: vi.fn(),
    mockSysGet: vi.fn(),
    mockSysSet: vi.fn(),
}))

// 与仓库既有约定一致（runtimeConfigManager.override.test.ts / convPermissionMode.test.ts）：
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

describe('releaseConvState：会话态成对释放', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockReadMeta.mockReturnValue(null)
        mockSysGet.mockReturnValue('safe')
    })

    it('释放 override：缓存失效后回读 DB，不返回释放前的缓存值', () => {
        runtimeConfigManager.setOverride('conv-rel-ov', {endpointId: 'p1', modelId: 'm-cache'})
        // 缓存已命中：不再读 DB
        mockReadMeta.mockClear()
        expect(runtimeConfigManager.getOverride('conv-rel-ov')).toEqual({endpointId: 'p1', modelId: 'm-cache'})
        expect(mockReadMeta).not.toHaveBeenCalled()

        runtimeConfigManager.releaseConvState('conv-rel-ov')

        // DB 内容与释放前的缓存不同：只有缓存真的被 delete 才会读到 DB 值
        mockReadMeta.mockReturnValue({id: 'conv-rel-ov', modelOverride: {endpointId: 'p9', modelId: 'm-db'}} as any)
        expect(runtimeConfigManager.getOverride('conv-rel-ov')).toEqual({endpointId: 'p9', modelId: 'm-db'})
        expect(mockReadMeta).toHaveBeenCalledWith('conv-rel-ov')
    })

    it('释放权限模式：缓存失效后回读 meta.permissionMode', () => {
        runtimeConfigManager.setConvPermissionMode('conv-rel-pm', 'auto')
        mockReadMeta.mockClear()
        expect(runtimeConfigManager.getConvModeOverride('conv-rel-pm')).toBe('auto')
        expect(mockReadMeta).not.toHaveBeenCalled()

        runtimeConfigManager.releaseConvState('conv-rel-pm')

        mockReadMeta.mockReturnValue({id: 'conv-rel-pm', permissionMode: 'safe'} as any)
        expect(runtimeConfigManager.getConvModeOverride('conv-rel-pm')).toBe('safe')
        expect(runtimeConfigManager.getConvPermissionMode('conv-rel-pm')).toBe('safe')
        expect(mockReadMeta).toHaveBeenCalledWith('conv-rel-pm')
    })

    it('只释放目标会话：其它会话的缓存条目不受影响（不产生额外 DB 读）', () => {
        runtimeConfigManager.setOverride('conv-rel-keep', {endpointId: 'p-keep', modelId: 'm-keep'})
        runtimeConfigManager.setOverride('conv-rel-drop', {endpointId: 'p-drop', modelId: 'm-drop'})
        runtimeConfigManager.setConvPermissionMode('conv-rel-keep', 'auto')
        runtimeConfigManager.setConvPermissionMode('conv-rel-drop', 'auto')

        runtimeConfigManager.releaseConvState('conv-rel-drop')

        mockReadMeta.mockClear()
        expect(runtimeConfigManager.getOverride('conv-rel-keep')).toEqual({endpointId: 'p-keep', modelId: 'm-keep'})
        expect(runtimeConfigManager.getConvModeOverride('conv-rel-keep')).toBe('auto')
        expect(mockReadMeta).not.toHaveBeenCalledWith('conv-rel-keep')
    })

    it('释放不存在的会话：no-op（不抛错）', () => {
        expect(() => runtimeConfigManager.releaseConvState('conv-rel-ghost')).not.toThrow()
    })

    it('重复释放幂等：再次释放不抛错，且不影响后续懒回读', () => {
        runtimeConfigManager.setOverride('conv-rel-twice', {endpointId: 'p1', modelId: 'm1'})
        runtimeConfigManager.releaseConvState('conv-rel-twice')
        runtimeConfigManager.releaseConvState('conv-rel-twice') // 幂等
        mockReadMeta.mockReturnValue({id: 'conv-rel-twice', modelOverride: {endpointId: 'p2', modelId: 'm2'}} as any)
        expect(runtimeConfigManager.getOverride('conv-rel-twice')).toEqual({endpointId: 'p2', modelId: 'm2'})
    })
})
