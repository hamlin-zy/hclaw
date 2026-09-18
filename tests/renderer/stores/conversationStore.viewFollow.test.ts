// 覆盖 §5.2 跟随矩阵：
//  1) openConversationInWorkspace 后 viewScope 变为 {type:'project', path}
//  2) handleSessionCreated（handoff 分支，带 workspacePath）后同样跟随
//  3) onConversationCreated（后台事件，渠道/定时任务）**不**改 viewScope
//  4) switchActiveConversation 不改 viewScope（组视图内点会话行不跳视图）
// 用最小 electronAPI 桩（无 IPC 副作用），断言 store 的 viewScope 字段。
//
// 隔离说明：模块级 IPC 监听器在 import 时注册到 window 桩上，故 window 必须先就位
// 再动态 import（vi.resetModules + import，同 conversationStore.conversationCreated.test.ts）。
import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'

vi.mock('../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: {
        getState: () => ({
            convAgentStates: {}, updateConvData: () => {}, removeConvData: () => {},
            flushPendingStreamData: () => {}, reconcileStreamingContent: () => {},
            refreshActiveBatch: () => {},
        }),
        setState: () => {},
        subscribe: () => () => {},
    },
    createDefaultConvData: () => ({agentState: {status: 'idle', mode: 'auto', phase: 'idle'}}),
}))

vi.mock('../../../src/renderer/lib/search', () => ({
    fuzzyFilter: (items: unknown[]) => items,
}))

const WS_A = '/ws/a'
const WS_B = '/ws/b'

type CreatedHandler = (conv: Record<string, unknown>) => void
let createdHandler: CreatedHandler | null = null

function conv(id: string) {
    return {id, title: id, preview: '', createdAt: 1000, updatedAt: 2000}
}

/** 最小 electronAPI 桩：只提供被测路径会触达的方法，全部无副作用 */
function stubWindow() {
    ;(globalThis as any).window = {
        electronAPI: {
            configRead: vi.fn(async () => null),
            configWrite: vi.fn(async () => true),
            conversationReadTail: vi.fn(async () => ({messages: [], totalCount: 0})),
            conversationReadMeta: vi.fn(async () => null),
            workspace: {
                getByPath: vi.fn(async (p: string) => ({id: `ws-${p}`, path: p})),
                setCurrent: vi.fn(async () => true),
                getGitBranch: vi.fn(async () => 'main'),
                getGitBranches: vi.fn(async () => ({})),
                getCurrent: vi.fn(async () => null),
            },
            onConversationCreated: (cb: CreatedHandler) => {
                createdHandler = cb
                return () => { createdHandler = null }
            },
        },
    }
}

/** 全新 store 实例（模块级监听器随 import 注册到当前 window 桩） */
async function loadStore() {
    vi.resetModules()
    const mod = await import('../../../src/renderer/stores/conversationStore')
    return mod.useConversationStore as any
}

function seed(store: any) {
    store.setState({
        workspaces: {
            [WS_A]: {lastOpenedAt: 2, conversations: [conv('c-1'), conv('c-2')]},
            [WS_B]: {lastOpenedAt: 1, conversations: [conv('c-3')]},
        },
        currentWorkspacePath: WS_A,
        activeConversationId: null,
        messagesMap: {},
        loadedMessages: [],
        viewScope: {type: 'group', groupId: 'pg-a'},
        collapsedGroupIds: [],
    })
}

const settle = () => new Promise(r => setTimeout(r, 0))

beforeEach(() => {
    createdHandler = null
    stubWindow()
})

afterEach(() => {
    delete (globalThis as any).window
})

describe('视图跟随矩阵（§5.2）', () => {
    it('openConversationInWorkspace（PM 发送/备忘录跳转/配置窗口打开）→ viewScope 跟随目标项目', async () => {
        const store = await loadStore()
        seed(store)

        await store.getState().openConversationInWorkspace('c-3', WS_B)

        expect(store.getState().viewScope).toEqual({type: 'project', path: WS_B})
    })

    it('handleSessionCreated（handoff 新建会话，带 workspacePath）→ viewScope 跟随', async () => {
        const store = await loadStore()
        seed(store)

        store.getState().handleSessionCreated('c-new', '交接会话', WS_B, 'c-1', 3000, 3000)

        expect(store.getState().viewScope).toEqual({type: 'project', path: WS_B})
        await settle()
    })

    it('onConversationCreated（渠道 / 定时任务后台创建）→ 只更新列表，不改 viewScope', async () => {
        const store = await loadStore()
        seed(store)

        expect(createdHandler).toBeTypeOf('function')
        createdHandler!({
            id: 'c-channel', title: '[wechat] u1', workspacePath: WS_A,
            createdAt: 3000, updatedAt: 3000, channel: 'wechat',
        })

        const state = store.getState()
        expect(state.workspaces[WS_A].conversations.map((c: any) => c.id)).toContain('c-channel')
        expect(state.viewScope).toEqual({type: 'group', groupId: 'pg-a'})
        await settle()
    })

    it('switchActiveConversation（组视图内点会话行）→ 不离开组视图', async () => {
        const store = await loadStore()
        seed(store)

        await store.getState().setActiveConversation('c-3')

        expect(store.getState().activeConversationId).toBe('c-3')
        expect(store.getState().viewScope).toEqual({type: 'group', groupId: 'pg-a'})
    })
})
