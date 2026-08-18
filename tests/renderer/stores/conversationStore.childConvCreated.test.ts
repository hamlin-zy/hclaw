/**
 * handleChildConvCreated 行为单元测试
 *
 * 覆盖 bug 修复（App.tsx child_conv_created 事件处理器曾整体覆盖 workspaces，
 * 导致其他项目从项目选择器消失）引入的行为约定：
 * - 子会话插入当前工作区会话列表头部，不切换激活会话
 * - 其他工作区条目必须保留（回归断言：workspaces 不被整体覆盖）
 * - 重复事件（双投递）去重，不重复插入
 * - 无 currentWorkspacePath 时安全返回
 *
 * 隔离：mock window.electronAPI，不触碰真实 IPC / SQLite
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'
import type {Message} from '../../../src/shared/types/message'

// mock agentStore（conversationStore 依赖它，但仅 action 内部惰性调用 getState）
vi.mock('../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: {
        getState: () => ({
            convAgentStates: {},
            updateConvData: () => {},
            removeConvData: () => {},
            flushPendingStreamData: () => {},
            getState: () => ({convAgentStates: {}, activeConversationId: null}),
        }),
    },
    createDefaultConvData: () => ({agentState: {status: 'idle', mode: 'auto', phase: 'idle'}}),
}))

// mock search（纯函数）
vi.mock('../../../src/renderer/lib/search', () => ({
    fuzzyFilter: (items: unknown[]) => items,
}))

import {useConversationStore} from '../../../src/renderer/stores/conversationStore'

const WS_A = '/workspace-a'
const WS_B = '/workspace-b'
const ROOT_ID = 'conv-root'
const CHILD_ID = 'conv-child'

function setupWorkspace() {
    useConversationStore.setState({
        currentWorkspacePath: WS_A,
        activeConversationId: ROOT_ID,
        workspaces: {
            [WS_A]: {
                lastOpenedAt: 2000,
                conversations: [
                    {id: ROOT_ID, title: 'root-a', preview: '', createdAt: 0, updatedAt: 1000},
                ],
            },
            [WS_B]: {
                lastOpenedAt: 1000,
                conversations: [
                    {id: 'conv-root-b', title: 'root-b', preview: '', createdAt: 0, updatedAt: 500},
                ],
            },
        },
        messagesMap: {[ROOT_ID]: []},
        loadedMessages: [],
    })
}

beforeEach(() => {
    ;(globalThis as any).window = {
        electronAPI: {
            conversationReadTail: vi.fn(async () => ({messages: [], totalCount: 0})),
        },
    }
    setupWorkspace()
})

afterEach(() => {
    delete (globalThis as any).window
})

describe('handleChildConvCreated', () => {
    it('子会话插入当前工作区会话列表头部，不切换激活会话', () => {
        useConversationStore.getState().handleChildConvCreated(CHILD_ID, '子 Agent: 分析任务...', ROOT_ID)

        const state = useConversationStore.getState()
        const convs = state.workspaces[WS_A].conversations
        expect(convs).toHaveLength(2)
        expect(convs[0]).toMatchObject({id: CHILD_ID, title: '子 Agent: 分析任务...', parentConvId: ROOT_ID})
        expect(state.activeConversationId).toBe(ROOT_ID)
    })

    it('其他工作区条目保留，不被整体覆盖（回归：项目选择器丢失其他项目）', () => {
        useConversationStore.getState().handleChildConvCreated(CHILD_ID, '子 Agent', ROOT_ID)

        const state = useConversationStore.getState()
        expect(Object.keys(state.workspaces).sort()).toEqual([WS_A, WS_B])
        expect(state.workspaces[WS_B].conversations).toHaveLength(1)
        expect(state.workspaces[WS_B].conversations[0].id).toBe('conv-root-b')
    })

    it('重复事件（双投递）去重，不重复插入', () => {
        const store = useConversationStore.getState()
        store.handleChildConvCreated(CHILD_ID, '子 Agent', ROOT_ID)
        store.handleChildConvCreated(CHILD_ID, '子 Agent', ROOT_ID)

        const convs = useConversationStore.getState().workspaces[WS_A].conversations
        expect(convs.filter(c => c.id === CHILD_ID)).toHaveLength(1)
    })

    it('无 currentWorkspacePath 时安全返回，不抛错', () => {
        useConversationStore.setState({currentWorkspacePath: null})
        expect(() => {
            useConversationStore.getState().handleChildConvCreated(CHILD_ID, '子 Agent', ROOT_ID)
        }).not.toThrow()
    })

    it('parentConvId 缺失时仍可插入（字段为 undefined）', () => {
        useConversationStore.getState().handleChildConvCreated(CHILD_ID, '子 Agent')

        const convs = useConversationStore.getState().workspaces[WS_A].conversations
        expect(convs[0]).toMatchObject({id: CHILD_ID, parentConvId: undefined})
    })
})
