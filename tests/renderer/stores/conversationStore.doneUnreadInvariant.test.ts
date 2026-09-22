/**
 * 核心不变量（H2）：「已完成未读」标记不得随 convAgentStates 释放而丢失
 *
 * 背景：`releaseConvCaches` 同时服务三条路径 ——
 *   ① LRU 预算驱逐 evictConversations / enforceMessagesMapSizeLimit（每项目 3 常驻）
 *   ② 10 分钟渲染清理 cleanupInactiveConversations
 *   ③ 真实删除 releaseDeletedConvs（真删才该销毁标记）
 * 若有人把 clearConvDoneUnread 塞进 releaseConvCaches（"顺手统一清理"），①② 会让后台
 * 完成的信号静默消失 —— 正是本标记要消灭的缺陷。
 *
 * 本文件用**真实** conversationStore + **真实** agentStore 驱动 ①② 两条真实路径
 * （此前只有 agentStore.doneUnread.test.ts 里 `setState({convAgentStates:{}})` 的近似模拟，
 * 它无法抓住「标记清理被挂到 releaseConvCaches 上」这一回归）。
 */
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'

vi.mock('../../../src/renderer/lib/search', () => ({
    fuzzyFilter: (items: unknown[]) => items,
}))

const WS = '/ws/a'

function conv(id: string) {
    return {id, title: id, preview: '', createdAt: 0, updatedAt: 0, status: 'active'}
}

/** 最小 electronAPI 桩：全部无副作用，仅保证被触达的调用不抛 */
function stubWindow() {
    ;(globalThis as any).window = {
        // agentStore 用 zustand persist（默认存储 localStorage）：window 存在但 localStorage
        // 缺失时 persist 的 storage 退化为 undefined，任何 setState 都会抛
        localStorage: {
            getItem: () => null,
            setItem: () => {},
            removeItem: () => {},
        },
        electronAPI: {
            configRead: vi.fn(async () => null),
            configWrite: vi.fn(async () => true),
            conversationReadTail: vi.fn(async () => ({messages: [], totalCount: 0})),
            conversationReadMeta: vi.fn(async () => null),
            conversationDeleteBatch: vi.fn(async () => true),
            agentGetPermissionMode: vi.fn(async () => null),
            agentStatus: vi.fn(async () => ({})),
            taskBatches: {getActive: vi.fn(async () => null)},
            workspace: {
                setCurrent: vi.fn(async () => true),
                getGitBranch: vi.fn(async () => 'main'),
            },
        },
    }
}

/** 全新真实 store 实例（模块级监听器随 import 注册到当前 window 桩） */
async function loadStores() {
    vi.resetModules()
    const convMod = await import('../../../src/renderer/stores/conversationStore')
    const agentMod = await import('../../../src/renderer/stores/agentStore')
    const defMod = await import('../../../src/renderer/stores/agentStore/defaultState')
    return {
        conv: convMod.useConversationStore as any,
        agent: agentMod.useAgentStore as any,
        createDefaultConvData: defMod.createDefaultConvData,
    }
}

/** 一条 user 消息即可让 switchActiveConversation 短路 loadMessagesInitial（不走 IPC） */
const userMsg = (id: string) => ({id, role: 'user' as const, content: 'hi', timestamp: 1})

const TEN_MIN = 10 * 60 * 1000

beforeEach(stubWindow)
afterEach(() => { delete (globalThis as any).window })

describe('H2-a：预算驱逐（enforceMessagesMapSizeLimit → evictConversations）不动标记', () => {
    it('超出「每项目 3 常驻」被驱逐的会话：convAgentStates 没了，doneUnreadIds 还在', async () => {
        const {conv: store, agent, createDefaultConvData} = await loadStores()
        const ids = ['c1', 'c2', 'c3', 'c4', 'c5']

        store.setState({
            workspaces: {[WS]: {lastOpenedAt: 1, conversations: ids.map(conv)}},
            currentWorkspacePath: WS,
            activeConversationId: null,
            messagesMap: Object.fromEntries(ids.map(id => [id, [userMsg(`m-${id}`)]])),
            // c2 最冷 → 驱逐；c1 随后被激活（保护集）
            conversationLastActiveAt: {c1: 10, c2: 100, c3: 200, c4: 300, c5: 400},
            renderedConversationIds: [],
            loadedMessages: [],
        })
        agent.setState({
            convAgentStates: Object.fromEntries(ids.map(id => [id, createDefaultConvData()])),
            doneUnreadIds: {c2: 111, c3: 222},
        })

        await store.getState().setActiveConversation('c1')

        // 驱逐真的发生了（每项目预算 3：c1 保护 + c4/c5 保留 + c2/c3 被驱逐）
        const keys = Object.keys(store.getState().messagesMap)
        expect(keys).not.toContain('c2')
        expect(keys).not.toContain('c3')
        expect(keys).toContain('c1')

        // 运行时数据被释放
        expect(agent.getState().convAgentStates.c2).toBeUndefined()
        expect(agent.getState().convAgentStates.c3).toBeUndefined()

        // ★ 不变量：标记必须仍在（驱逐 ≠ 已读；用户还没看过这两个会话）
        expect(agent.getState().doneUnreadIds.c2).toBe(111)
        expect(agent.getState().doneUnreadIds.c3).toBe(222)
    })
})

describe('H2-b：10 分钟渲染清理（cleanupInactiveConversations）不动标记', () => {
    it('不活跃被清理的会话：convAgentStates 没了，doneUnreadIds 还在', async () => {
        const {conv: store, agent, createDefaultConvData} = await loadStores()
        const now = Date.now()

        store.setState({
            workspaces: {[WS]: {lastOpenedAt: 1, conversations: [conv('c-old'), conv('c-new')]}},
            currentWorkspacePath: WS,
            activeConversationId: 'c-new',
            messagesMap: {
                'c-old': [userMsg('m-old')],
                'c-new': [userMsg('m-new')],
            },
            conversationLastActiveAt: {'c-old': now - TEN_MIN - 1000, 'c-new': now},
            renderedConversationIds: ['c-old', 'c-new'],
            loadedMessages: [],
        })
        agent.setState({
            convAgentStates: {
                'c-old': createDefaultConvData(),
                'c-new': createDefaultConvData(),
            },
            doneUnreadIds: {'c-old': 333},
        })

        store.getState().cleanupInactiveConversations()

        // 清理真的发生了（渲染池与消息缓存都释放）
        expect(store.getState().renderedConversationIds).toEqual(['c-new'])
        expect(store.getState().messagesMap['c-old']).toBeUndefined()
        expect(agent.getState().convAgentStates['c-old']).toBeUndefined()

        // ★ 不变量：标记必须仍在（"后台跑完了" 这条信号不能因为 10 分钟没点开就消失）
        expect(agent.getState().doneUnreadIds['c-old']).toBe(333)
    })
})

describe('H2-c：真删路径 removeWorkspace（删除工作区）必须销毁标记', () => {
    it('删除工作区真删库内会话行 ⇒ doneUnreadIds 同步清除，未牵连的会话标记保留', async () => {
        const {conv: store, agent, createDefaultConvData} = await loadStores()
        const api = (globalThis as any).window.electronAPI
        // removeWorkspace 的完整链路：解析 workspace → 列出工作区会话 → 批量删库
        api.workspace.getByPath = vi.fn(async () => ({id: 'ws-1', path: WS}))
        api.workspace.list = vi.fn(async () => [])
        api.workspace.delete = vi.fn(async () => true)
        api.conversationListByWorkspace = vi.fn(async () => [{id: 'c1'}, {id: 'c2'}])

        store.setState({
            workspaces: {[WS]: {lastOpenedAt: 1, conversations: [conv('c1'), conv('c2'), conv('c-keep')]}},
            currentWorkspacePath: WS,
            activeConversationId: null,
            messagesMap: {c1: [userMsg('m1')], c2: [userMsg('m2')], 'c-keep': [userMsg('m3')]},
            conversationLastActiveAt: {},
            renderedConversationIds: [],
            loadedMessages: [],
        })
        agent.setState({
            convAgentStates: {
                c1: createDefaultConvData(),
                c2: createDefaultConvData(),
                'c-keep': createDefaultConvData(),
            },
            doneUnreadIds: {c1: 111, c2: 222, 'c-keep': 333},
        })

        await store.getState().removeWorkspace(WS)

        // 真删确实发生（库行被批量删除）
        expect(api.conversationDeleteBatch).toHaveBeenCalledWith(['c1', 'c2'])
        const msgKeys = Object.keys(store.getState().messagesMap)
        expect(msgKeys).not.toContain('c1')
        expect(msgKeys).not.toContain('c2')

        // ★ 不变量：真删必须销毁标记，否则 convId 成悬空 key 永久驻留
        expect(agent.getState().doneUnreadIds.c1).toBeUndefined()
        expect(agent.getState().doneUnreadIds.c2).toBeUndefined()
        // 未牵连的会话标记不受影响（不得退化成「清工作区就全清」）
        expect(agent.getState().doneUnreadIds['c-keep']).toBe(333)
    })
})
