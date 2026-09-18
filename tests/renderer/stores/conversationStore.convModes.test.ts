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

const {
    readMetaMock, agentGetModeMock, configReadMock, convCreateMock,
    getCurrentMock, branchMock, listMock, readTailMock, readMessagesMock,
} = vi.hoisted(() => ({
    readMetaMock: vi.fn(),
    agentGetModeMock: vi.fn(async () => 'safe'),
    configReadMock: vi.fn(async (name: string) => name === 'message-display-mode' ? {mode: 'detailed'} : null),
    convCreateMock: vi.fn(async () => true),
    getCurrentMock: vi.fn(async () => ({path: '/ws'})),
    branchMock: vi.fn(async () => null),
    listMock: vi.fn(async (): Promise<any[]> => []),
    readTailMock: vi.fn(async () => ({messages: [], totalCount: 0})),
    readMessagesMock: vi.fn(async () => ({messages: [], totalCount: 0})),
}))

vi.stubGlobal('window', {
    electronAPI: {
        conversationReadMeta: readMetaMock,
        agentGetPermissionMode: agentGetModeMock,
        configRead: configReadMock,
        conversationCreate: convCreateMock,
        conversationList: listMock,
        conversationReadTail: readTailMock,
        conversationReadMessages: readMessagesMock,
        workspace: {getCurrent: getCurrentMock, getGitBranch: branchMock},
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

describe('冷启动自动激活会话恢复会话级模式（回归）', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        useAgentStore.setState({permissionMode: 'safe', messageDisplayMode: 'detailed'})
    })

    it('loadConversations 自动激活根会话 → 顶层 permissionMode 等于会话 meta（而非被污染的全局默认）', async () => {
        // 会话 meta 固化 auto；全局默认返回 safe（对照：全局默认 ≠ 会话模式）
        readMetaMock.mockResolvedValue({permissionMode: 'auto'})
        agentGetModeMock.mockResolvedValue('safe')
        listMock.mockResolvedValue([
            {id: 'conv-root', title: 'root', workspacePath: '/ws', createdAt: 1, updatedAt: 1},
        ])
        useConversationStore.setState({
            currentWorkspacePath: null,
            activeConversationId: null,
            workspaces: {},
            messagesMap: {},
            loadedMessages: [],
            hasMoreMap: {},
            loadingMoreMap: {},
            renderedConversationIds: [],
            conversationLastActiveAt: {},
        })

        await useConversationStore.getState().loadConversations()

        expect(useConversationStore.getState().activeConversationId).toBe('conv-root')
        // 关键：按会话 meta 恢复，而不是穿透到 agentGetPermissionMode 的全局 'safe'
        await vi.waitFor(() => {
            expect(useAgentStore.getState().permissionMode).toBe('auto')
        })
    })
})
