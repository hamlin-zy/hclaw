/**
 * setActiveConversation(force) 测试
 *
 * 保护：「切工作区 + 进目标会话」场景。setWorkspace 会先把该目录首个根会话置为活跃
 * （conversationStore.setWorkspace），若目标恰是它，普通 setActiveConversation 会
 * 幂等短路 → 跳过消息合并 / reconcileStreamingContent / refreshActiveBatch，
 * 运行中会话只能显示 DB 半成品快照。force=true 必须重走完整切换流程。
 *
 * 隔离：mock agentStore / electronAPI，不触碰真实 IPC / SQLite
 */
import {describe, expect, it, beforeEach, vi} from 'vitest'
import type {Message} from '../../../src/shared/types/message'

const reconcileSpy = vi.hoisted(() => vi.fn())
const refreshSpy = vi.hoisted(() => vi.fn())

vi.mock('../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: {
        getState: () => ({
            convAgentStates: {},
            updateConvData: () => {},
            removeConvData: () => {},
            flushPendingStreamData: () => {},
            reconcileStreamingContent: reconcileSpy,
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
const OTHER_ID = 'conv-other'

function makeMsg(id: string, content: string, ts = 1000): Message {
    return {id, role: 'user', content, timestamp: ts}
}

beforeEach(() => {
    reconcileSpy.mockClear()
    refreshSpy.mockClear()
    ;(globalThis as unknown as {window: unknown}).window = {
        electronAPI: {
            conversationReadTail: vi.fn(async () => ({messages: [], totalCount: 0})),
        },
    }
    useConversationStore.setState({
        currentWorkspacePath: '/ws',
        activeConversationId: ROOT_ID,
        workspaces: {
            '/ws': {
                lastOpenedAt: 0,
                conversations: [
                    {id: ROOT_ID, title: 'root', preview: '', createdAt: 0, updatedAt: 0},
                    {id: OTHER_ID, title: 'other', preview: '', createdAt: 0, updatedAt: 0},
                ],
            },
        },
        messagesMap: {
            [ROOT_ID]: [makeMsg('msg-1', 'hi')],
            [OTHER_ID]: [makeMsg('msg-2', 'hi2')],
        },
        loadedMessages: [],
    })
})

describe('setActiveConversation 的 force 语义', () => {
    it('目标已是活跃会话（无 force）→ 幂等短路，不走切换流程', async () => {
        await useConversationStore.getState().setActiveConversation(ROOT_ID)

        expect(reconcileSpy).not.toHaveBeenCalled()
        expect(refreshSpy).not.toHaveBeenCalled()
    })

    it('目标已是活跃会话 + force=true → 重走完整切换（补合并与 agent 状态同步）', async () => {
        await useConversationStore.getState().setActiveConversation(ROOT_ID, {force: true})

        expect(reconcileSpy).toHaveBeenCalledWith(ROOT_ID)
        expect(refreshSpy).toHaveBeenCalledWith(ROOT_ID)
    })

    it('切到非活跃会话（无 force）→ 正常切换（force 不改变既有行为）', async () => {
        await useConversationStore.getState().setActiveConversation(OTHER_ID)

        expect(useConversationStore.getState().activeConversationId).toBe(OTHER_ID)
        expect(refreshSpy).toHaveBeenCalledWith(OTHER_ID)
    })
})
