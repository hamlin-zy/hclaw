/**
 * touchConversation 跨工作区/未归属段匹配行为单元测试
 *
 * 覆盖缺陷修复：touchConversation 只在 workspaces[currentWorkspacePath] 单段里
 * map 查找，未命中静默返回。message-finalized 事件（agentStore/index.ts:495-499
 * 驱动）触发的 updatedAt 更新无法到达：
 *  - 未归属会话（workspacePath 为空，存于 UNASSIGNED_WORKSPACE_KEY 虚拟段）
 *    与其他非当前工作区的会话 → updatedAt 不实时刷新 → 列表排序不动、
 *    预览位置不更新（重载后才恢复）。
 *
 * 行为约定（与 togglePinConversation / onConversationUpdated 的 findConvHome 范式一致）：
 * - 按 findConvHome 定位会话所在段（含未归属虚拟段），再 map 更新
 * - 所有段都未命中 → 无操作（不误更新、不抛错）
 * - currentWorkspacePath 为空（零项目场景）时不再整体早退
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'

vi.mock('../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: {
        getState: () => ({
            convAgentStates: {},
            updateConvData: () => {},
            removeConvData: () => {},
            flushPendingStreamData: () => {},
        }),
        setState: () => {},
        subscribe: () => () => {},
    },
    createDefaultConvData: () => ({agentState: {status: 'idle', mode: 'auto', phase: 'idle'}}),
}))

vi.mock('../../../src/renderer/lib/search', () => ({
    fuzzyFilter: (items: unknown[]) => items,
}))

import {UNASSIGNED_WORKSPACE_KEY} from '../../../src/renderer/lib/workspacePath'

const WS_A = '/workspace-a'
const WS_B = '/workspace-b'

async function loadStore() {
    vi.resetModules()
    const mod = await import('../../../src/renderer/stores/conversationStore')
    return mod.useConversationStore as any
}

function setupWorkspaces(store: any, opts: {currentWorkspacePath: string | null}) {
    store.setState({
        currentWorkspacePath: opts.currentWorkspacePath,
        activeConversationId: null,
        workspaces: {
            [WS_A]: {
                lastOpenedAt: 2000,
                conversations: [
                    {id: 'conv-a', title: '会话A', createdAt: 0, updatedAt: 1000},
                ],
            },
            [WS_B]: {
                lastOpenedAt: 1000,
                conversations: [
                    {id: 'conv-b', title: '会话B', createdAt: 0, updatedAt: 500},
                ],
            },
            [UNASSIGNED_WORKSPACE_KEY]: {
                lastOpenedAt: 0,
                conversations: [
                    {id: 'conv-unassigned', title: '未归属会话', createdAt: 0, updatedAt: 100},
                ],
            },
        },
        messagesMap: {},
        loadedMessages: [],
    })
}

beforeEach(() => {
    ;(globalThis as any).window = {
        electronAPI: {
            onConversationUpdated: () => () => {},
            onConversationCreated: () => () => {},
            onConversationDeleted: () => () => {},
            onAgentPersistEvent: () => () => {},
            conversationList: vi.fn(async () => []),
            conversationReadTail: vi.fn(async () => ({messages: [], totalCount: 0})),
            workspace: {getCurrent: vi.fn(async () => null)},
        },
    }
})

afterEach(() => {
    delete (globalThis as any).window
})

describe('touchConversation 跨工作区匹配', () => {
    it('★ 未归属虚拟段的会话 → updatedAt 更新（缺陷回归：列表不刷新）', async () => {
        const store = await loadStore()
        setupWorkspaces(store, {currentWorkspacePath: WS_B})

        store.getState().touchConversation('conv-unassigned', 9999)

        const conv = store.getState().workspaces[UNASSIGNED_WORKSPACE_KEY].conversations
            .find((c: any) => c.id === 'conv-unassigned')
        expect(conv.updatedAt).toBe(9999)
    })

    it('非当前工作区（已加载）的会话 → updatedAt 更新', async () => {
        const store = await loadStore()
        setupWorkspaces(store, {currentWorkspacePath: WS_B})

        store.getState().touchConversation('conv-a', 8888)

        const conv = store.getState().workspaces[WS_A].conversations.find((c: any) => c.id === 'conv-a')
        expect(conv.updatedAt).toBe(8888)
    })

    it('当前工作区的会话照常更新（高频路径回归保护）', async () => {
        const store = await loadStore()
        setupWorkspaces(store, {currentWorkspacePath: WS_B})

        store.getState().touchConversation('conv-b', 7777)

        const conv = store.getState().workspaces[WS_B].conversations.find((c: any) => c.id === 'conv-b')
        expect(conv.updatedAt).toBe(7777)
    })

    it('所有工作区均未命中 → 无操作不抛错', async () => {
        const store = await loadStore()
        setupWorkspaces(store, {currentWorkspacePath: WS_B})

        expect(() => store.getState().touchConversation('ghost-conv', 9999)).not.toThrow()
        expect(store.getState().workspaces[WS_A].conversations[0].updatedAt).toBe(1000)
        expect(store.getState().workspaces[UNASSIGNED_WORKSPACE_KEY].conversations[0].updatedAt).toBe(100)
    })

    it('currentWorkspacePath 为空（零项目场景）→ 未归属会话仍能更新', async () => {
        const store = await loadStore()
        setupWorkspaces(store, {currentWorkspacePath: null})

        store.getState().touchConversation('conv-unassigned', 6666)

        const conv = store.getState().workspaces[UNASSIGNED_WORKSPACE_KEY].conversations
            .find((c: any) => c.id === 'conv-unassigned')
        expect(conv.updatedAt).toBe(6666)
    })

    it('updatedAt 不会回退（取 max）', async () => {
        const store = await loadStore()
        setupWorkspaces(store, {currentWorkspacePath: WS_A})

        // conv-a 初始 updatedAt=1000，传入更小值不应回退
        store.getState().touchConversation('conv-a', 500)

        const conv = store.getState().workspaces[WS_A].conversations.find((c: any) => c.id === 'conv-a')
        expect(conv.updatedAt).toBe(1000)
    })
})
