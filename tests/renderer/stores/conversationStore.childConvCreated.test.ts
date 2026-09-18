/**
 * handleChildConvCreated 行为单元测试
 *
 * 覆盖 bug 修复（App.tsx child_conv_created 事件处理器曾整体覆盖 workspaces，
 * 导致其他项目从项目选择器消失）引入的行为约定：
 * - 子会话按事件携带的 workspacePath（父会话所属工作区）插入会话列表头部，不切换激活会话
 * - workspacePath ≠ currentWorkspacePath 时插入 workspacePath 对应工作区（缺陷 1 回归）
 * - workspacePath 对应工作区未加载时新建条目，子会话插入该条目头部（不回退 currentWorkspacePath）
 * - 其他工作区条目必须保留（回归断言：workspaces 不被整体覆盖）
 * - 重复事件（双投递）去重，不重复插入
 * - workspacePath 为空/缺失时安全返回
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
    it('子会话插入指定工作区会话列表头部，不切换激活会话', () => {
        useConversationStore.getState().handleChildConvCreated(CHILD_ID, '子 Agent: 分析任务...', ROOT_ID, WS_A)

        const state = useConversationStore.getState()
        const convs = state.workspaces[WS_A].conversations
        expect(convs).toHaveLength(2)
        expect(convs[0]).toMatchObject({id: CHILD_ID, title: '子 Agent: 分析任务...', parentConvId: ROOT_ID})
        expect(state.activeConversationId).toBe(ROOT_ID)
    })

    it('workspacePath ≠ currentWorkspacePath：插入 workspacePath 对应工作区（缺陷 1 回归）', () => {
        // 当前工作区为 WS_A，但父会话所属工作区为 WS_B —— 子会话必须进 WS_B
        expect(useConversationStore.getState().currentWorkspacePath).toBe(WS_A)

        useConversationStore.getState().handleChildConvCreated(CHILD_ID, '子 Agent', 'conv-root-b', WS_B)

        const state = useConversationStore.getState()
        expect(state.workspaces[WS_B].conversations.map(c => c.id)).toEqual([CHILD_ID, 'conv-root-b'])
        // 当前工作区 WS_A 不得被污染
        expect(state.workspaces[WS_A].conversations.map(c => c.id)).toEqual([ROOT_ID])
    })

    it('workspacePath 对应工作区未加载：新建条目并插入该条目头部，不回退 currentWorkspacePath', () => {
        useConversationStore
            .getState()
            .handleChildConvCreated(CHILD_ID, '子 Agent', 'conv-root-x', '/workspace-not-loaded')

        const state = useConversationStore.getState()
        // 未加载的工作区新建条目，子会话插入头部
        expect(Object.keys(state.workspaces)).toContain('/workspace-not-loaded')
        expect(state.workspaces['/workspace-not-loaded'].conversations.map(c => c.id)).toEqual([CHILD_ID])
        // 也不得插入当前工作区
        expect(state.workspaces[WS_A].conversations.map(c => c.id)).toEqual([ROOT_ID])
    })

    it('其他工作区条目保留，不被整体覆盖（回归：项目选择器丢失其他项目）', () => {
        useConversationStore.getState().handleChildConvCreated(CHILD_ID, '子 Agent', ROOT_ID, WS_A)

        const state = useConversationStore.getState()
        expect(Object.keys(state.workspaces).sort()).toEqual([WS_A, WS_B])
        expect(state.workspaces[WS_B].conversations).toHaveLength(1)
        expect(state.workspaces[WS_B].conversations[0].id).toBe('conv-root-b')
    })

    it('重复事件（双投递）去重，不重复插入', () => {
        const store = useConversationStore.getState()
        store.handleChildConvCreated(CHILD_ID, '子 Agent', ROOT_ID, WS_A)
        store.handleChildConvCreated(CHILD_ID, '子 Agent', ROOT_ID, WS_A)

        const convs = useConversationStore.getState().workspaces[WS_A].conversations
        expect(convs.filter(c => c.id === CHILD_ID)).toHaveLength(1)
    })

    it('workspacePath 为空时安全返回，不抛错、不插入当前工作区、不新建空串条目', () => {
        expect(() => {
            useConversationStore.getState().handleChildConvCreated(CHILD_ID, '子 Agent', ROOT_ID, '')
        }).not.toThrow()

        const state = useConversationStore.getState()
        expect(state.workspaces[WS_A].conversations.map(c => c.id)).toEqual([ROOT_ID])
        expect(state.workspaces['']).toBeUndefined()
    })

    it('parentConvId 缺失时仍可插入（字段为 undefined）', () => {
        useConversationStore.getState().handleChildConvCreated(CHILD_ID, '子 Agent', undefined, WS_A)

        const convs = useConversationStore.getState().workspaces[WS_A].conversations
        expect(convs[0]).toMatchObject({id: CHILD_ID, parentConvId: undefined})
    })
})
