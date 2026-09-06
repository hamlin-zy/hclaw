/**
 * switchActiveConversation 主动水合待办批次测试
 *
 * 保护：切换会话时必须主动调用 refreshActiveBatch 从 DB 加载待办批次，
 * 而非依赖 TodoStrip 的被动 useEffect（条件不满足时水合会漏触发，
 * 导致"重启后进行中的待办列表不显示"）。
 *
 * 隔离：mock agentStore / electronAPI，不触碰真实 IPC / SQLite
 */
import {describe, expect, it, beforeEach, vi} from 'vitest'
import type {Message} from '../../../src/shared/types/message'

const refreshSpy = vi.hoisted(() => vi.fn())

vi.mock('../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: {
        getState: () => ({
            convAgentStates: {},
            updateConvData: () => {},
            removeConvData: () => {},
            flushPendingStreamData: () => {},
            reconcileStreamingContent: () => {},
            refreshActiveBatch: refreshSpy,
        }),
    },
    createDefaultConvData: () => ({agentState: {status: 'idle', mode: 'auto', phase: 'idle'}}),
}))

vi.mock('../../../src/renderer/lib/search', () => ({
    fuzzyFilter: (items: unknown[]) => items,
}))

import {useConversationStore} from '../../../src/renderer/stores/conversationStore'

const ROOT_ID = 'conv-root'
const CHILD_ID = 'conv-child'

function makeMsg(id: string, content: string, role: 'user' | 'assistant' = 'user', ts = 1000): Message {
    return {id, role, content, timestamp: ts}
}

function setupWorkspace() {
    useConversationStore.setState({
        currentWorkspacePath: '/ws',
        activeConversationId: ROOT_ID,
        workspaces: {
            '/ws': {
                lastOpenedAt: 0,
                conversations: [
                    {id: ROOT_ID, title: 'root', preview: '', createdAt: 0, updatedAt: 0},
                    {id: CHILD_ID, title: 'child', preview: '', createdAt: 0, updatedAt: 0, parentConvId: ROOT_ID},
                ],
            },
        },
        messagesMap: {
            [ROOT_ID]: [makeMsg('msg-1', 'hi')],
            [CHILD_ID]: [makeMsg('msg-2', 'hi2')],
        },
        loadedMessages: [],
    })
}

beforeEach(() => {
    refreshSpy.mockClear()
    ;(globalThis as unknown as {window: unknown}).window = {
        electronAPI: {
            conversationReadTail: vi.fn(async () => ({messages: [], totalCount: 0})),
        },
    }
    setupWorkspace()
})

describe('switchActiveConversation 主动水合待办批次', () => {
    it('切换会话 → 调用 refreshActiveBatch 从 DB 主动加载待办', async () => {
        const store = useConversationStore.getState()

        await store.setActiveConversation(CHILD_ID)

        expect(refreshSpy).toHaveBeenCalledWith(CHILD_ID)
    })

    it('首次激活会话（从 null 切到 root）→ 也调用 refreshActiveBatch', async () => {
        // 模拟重启场景：activeConversationId 从 null 切到某会话
        useConversationStore.setState({activeConversationId: null})
        const store = useConversationStore.getState()

        await store.setActiveConversation(ROOT_ID)

        expect(refreshSpy).toHaveBeenCalledWith(ROOT_ID)
    })
})
