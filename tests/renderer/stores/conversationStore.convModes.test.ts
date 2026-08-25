// @vitest-environment jsdom
/**
 * conversationStore 会话级模式初始化测试（Task 5）
 *
 * 覆盖：
 * 1. applyConvModesToAgentStore：meta 固化值 → 顶层按 meta 初始化
 * 2. applyConvModesToAgentStore：meta 无字段 → 回退全局默认
 *    （agentGetPermissionMode / config message-display-mode）
 * 3. createConversation：创建后顶层按固化默认初始化（不留上一会话残留）
 *
 * 隔离：mock window.electronAPI（conversationReadMeta / agentGetPermissionMode /
 * configRead / conversationCreate），使用真实 zustand store（断言顶层字段）。
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'

const {readMetaMock, agentGetModeMock, configReadMock, convCreateMock} = vi.hoisted(() => ({
    readMetaMock: vi.fn(),
    agentGetModeMock: vi.fn(async () => 'safe'),
    configReadMock: vi.fn(async (name: string) => name === 'message-display-mode' ? {mode: 'detailed'} : null),
    convCreateMock: vi.fn(async () => true),
}))

vi.stubGlobal('window', {
    electronAPI: {
        conversationReadMeta: readMetaMock,
        agentGetPermissionMode: agentGetModeMock,
        configRead: configReadMock,
        conversationCreate: convCreateMock,
    },
})

import {useConversationStore, applyConvModesToAgentStore} from '@/renderer/stores/conversationStore'
import {useAgentStore} from '@/renderer/stores/agentStore'

describe('会话级模式初始化（applyConvModesToAgentStore / createConversation）', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        useAgentStore.setState({permissionMode: 'safe', messageDisplayMode: 'detailed'})
    })

    it('meta 有固化值 → 顶层按 meta 初始化', async () => {
        readMetaMock.mockResolvedValue({permissionMode: 'auto', displayMode: 'compact'} as any)
        await applyConvModesToAgentStore('conv-a')
        expect(useAgentStore.getState().permissionMode).toBe('auto')
        expect(useAgentStore.getState().messageDisplayMode).toBe('compact')
    })

    it('meta 无字段 → 回退全局默认（agentGetPermissionMode / config message-display-mode）', async () => {
        readMetaMock.mockResolvedValue({id: 'conv-old'} as any)
        agentGetModeMock.mockResolvedValue('safe')
        configReadMock.mockResolvedValue({mode: 'ultra-compact'})
        await applyConvModesToAgentStore('conv-old')
        expect(useAgentStore.getState().permissionMode).toBe('safe')
        expect(useAgentStore.getState().messageDisplayMode).toBe('ultra-compact')
    })

    it('createConversation 创建后顶层按固化默认初始化（不留上一会话残留）', async () => {
        // 模拟新会话：meta 尚未落库（conversationReadMeta 返回 null）→ 固化逻辑读全局默认
        readMetaMock.mockResolvedValue(null)
        agentGetModeMock.mockResolvedValue('safe')
        configReadMock.mockResolvedValue({mode: 'detailed'})
        useConversationStore.setState({currentWorkspacePath: ''})
        await useConversationStore.getState().createConversation()
        // 核心行为：固化全局默认进 meta（conversationCreate 收到的 meta 含 'safe'/'detailed'）
        expect(convCreateMock).toHaveBeenCalledTimes(1)
        expect(convCreateMock).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({permissionMode: 'safe', displayMode: 'detailed'}),
        )
        // 顶层 = 全局默认（meta 无值 → 回退全局，而非透传 mock 注入值）
        await vi.waitFor(() => {
            expect(useAgentStore.getState().permissionMode).toBe('safe')
            expect(useAgentStore.getState().messageDisplayMode).toBe('detailed')
        })
    })
})
