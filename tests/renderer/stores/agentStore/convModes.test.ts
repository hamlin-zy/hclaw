// @vitest-environment jsdom
import {beforeEach, describe, expect, it, vi} from 'vitest'

const {agentSetConvModeMock, convUpdateMetaMock} = vi.hoisted(() => ({
    agentSetConvModeMock: vi.fn(async () => ({success: true})),
    convUpdateMetaMock: vi.fn(async () => true),
}))

// 全局 window.electronAPI mock
vi.stubGlobal('window', {
    electronAPI: {
        agentSetConvPermissionMode: agentSetConvModeMock,
        conversationUpdateMeta: convUpdateMetaMock,
        agentSetPermissionMode: vi.fn(async () => true),
    },
})

import {useAgentStore} from '@/renderer/stores/agentStore'

describe('会话级模式 actions', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        useAgentStore.setState({permissionMode: 'safe', messageDisplayMode: 'detailed'})
    })

    it('setConvPermissionMode 调 agent-set-conv-permission-mode 并更新顶层', async () => {
        await useAgentStore.getState().setConvPermissionMode('conv-a', 'auto')
        expect(agentSetConvModeMock).toHaveBeenCalledWith('conv-a', 'auto')
        expect(useAgentStore.getState().permissionMode).toBe('auto')
    })

    it('setConvDisplayMode 写 meta 并更新顶层 messageDisplayMode', async () => {
        await useAgentStore.getState().setConvDisplayMode('conv-a', 'compact')
        expect(convUpdateMetaMock).toHaveBeenCalledWith('conv-a', expect.objectContaining({displayMode: 'compact'}))
        expect(useAgentStore.getState().messageDisplayMode).toBe('compact')
    })

    it('会话独立：改 A 不影响 B 的顶层（B 激活时由 switchActiveConversation 重新初始化）', async () => {
        await useAgentStore.getState().setConvPermissionMode('conv-a', 'auto')
        // 模拟切到 B：B 无 meta → 回退全局默认
        useAgentStore.setState({permissionMode: 'safe'})
        expect(useAgentStore.getState().permissionMode).toBe('safe')
    })
})
