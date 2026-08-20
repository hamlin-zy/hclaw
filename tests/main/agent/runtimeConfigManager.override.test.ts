import {beforeEach, describe, expect, it, vi} from 'vitest'

// mock DB 依赖：runtimeConfigManager 顶层不 import conversationRepo，
// 测试通过 vi.mock 拦截 repository 模块（若实现中动态 import 则改为注入方式）
const {mockReadMeta, mockUpdateMeta} = vi.hoisted(() => ({
    mockReadMeta: vi.fn(),
    mockUpdateMeta: vi.fn(),
}))

vi.mock('../../../src/main/repositories', () => ({
    createConversationRepository: () => ({
        readMeta: mockReadMeta,
        updateMeta: mockUpdateMeta,
    }),
}))

import {runtimeConfigManager} from '@/main/agent/runtimeConfigManager'

describe('会话级模型 override 状态机', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockReadMeta.mockReturnValue(null)
    })

    it('setOverride 更新会话并落库', () => {
        runtimeConfigManager.setOverride('conv-a', {endpointId: 'p1', modelId: 'deepseek-v3'})
        expect(runtimeConfigManager.getOverride('conv-a')).toEqual({endpointId: 'p1', modelId: 'deepseek-v3'})
        expect(mockUpdateMeta).toHaveBeenCalledWith('conv-a', expect.objectContaining({modelOverride: {endpointId: 'p1', modelId: 'deepseek-v3'}}))
    })

    it('切回 auto（setOverride null）→ 会话固化 null', () => {
        runtimeConfigManager.setOverride('conv-a', {endpointId: 'p1', modelId: 'm1'})
        runtimeConfigManager.setOverride('conv-a', null)
        expect(runtimeConfigManager.getOverride('conv-a')).toBeNull()
        expect(mockUpdateMeta).toHaveBeenLastCalledWith('conv-a', expect.objectContaining({modelOverride: null}))
    })

    it('会话独立：A 改不影响 B', () => {
        runtimeConfigManager.setOverride('conv-a', {endpointId: 'p1', modelId: 'm-a'})
        runtimeConfigManager.setOverride('conv-b', {endpointId: 'p2', modelId: 'm-b'})
        expect(runtimeConfigManager.getOverride('conv-a')).toEqual({endpointId: 'p1', modelId: 'm-a'})
        expect(runtimeConfigManager.getOverride('conv-b')).toEqual({endpointId: 'p2', modelId: 'm-b'})
    })

    it('无记录会话懒加载 DB，缺省 null（老数据）', () => {
        mockReadMeta.mockReturnValue({id: 'conv-old'} as any) // 无 modelOverride 字段
        expect(runtimeConfigManager.getOverride('conv-old')).toBeNull()
        expect(mockReadMeta).toHaveBeenCalledWith('conv-old')
        // 命中缓存不再读 DB
        runtimeConfigManager.getOverride('conv-old')
        expect(mockReadMeta).toHaveBeenCalledTimes(1)
    })

    it('DB 有记录 → 懒加载返回固化值', () => {
        mockReadMeta.mockReturnValue({id: 'conv-db', modelOverride: {endpointId: 'p9', modelId: 'm9'}} as any)
        expect(runtimeConfigManager.getOverride('conv-db')).toEqual({endpointId: 'p9', modelId: 'm9'})
    })

    it('applyOverrideFromMain 仅设内存，不落库', () => {
        runtimeConfigManager.setOverride('conv-x', {endpointId: 'p1', modelId: 'm1'})
        mockUpdateMeta.mockClear()
        runtimeConfigManager.applyOverrideFromMain('conv-x', {endpointId: 'p7', modelId: 'm7'})
        expect(runtimeConfigManager.getOverride('conv-x')).toEqual({endpointId: 'p7', modelId: 'm7'})
        expect(mockUpdateMeta).not.toHaveBeenCalled()
    })
})
