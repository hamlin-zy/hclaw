// 覆盖最终评审 I-1（跨任务缝隙：viewScope「我在看谁」与 currentWorkspacePath「我在哪干活」的分工）
//
// 夹具统一为「组视图 + 操作对象属于非当前项目」：
//   viewScope = {type:'group', groupId:'pg-a'}，currentWorkspacePath = A，组内成员 = [A, B]
//   —— 这正是旧代码暴露缺陷的唯一可达空间：会话操作按 currentWorkspacePath（A）展开/改写，
//      而右键的对象属于 B。
//
// 逐条覆盖：
//   (b) deleteConversation / deleteConversations / togglePinConversation / updateConversationMeta
//       按**会话自身所属项目**读写（含 B 的后代一并删除、B 的列表条目标题/置顶真的变化）
//   (a) syncCurrentProject：switchActiveConversation 解析出目标会话所属项目后同步「在哪干活」
//       （且**不写 viewScope**——组内换会话不离开组视图）、followScopeToProject 同时同步
//   I-4 ensureWorkspaceRegistered 登记后补渲染端空条目 → 新成员段立即可渲染（getScopedSections 含该段）
//
// 隔离说明：模块级 IPC 监听器在 import 时注册到 window 桩上，故 window 必须先就位
// 再动态 import（vi.resetModules + import，同 conversationStore.viewFollow.test.ts）。
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
const WS_NEW = '/ws/new'

/** 组 pg-a = [A, B]（members 顺序即分段顺序） */
const GROUPS = [
    {
        id: 'pg-a', name: '组A', sortOrder: 0, createdAt: 1, updatedAt: 1,
        members: [{projectPath: WS_A, groupOrder: 0}, {projectPath: WS_B, groupOrder: 1}],
    },
]

function conv(id: string, over: Record<string, unknown> = {}) {
    return {id, title: id, preview: '', createdAt: 1000, updatedAt: 2000, ...over}
}

/** 最小 electronAPI 桩：只提供被测路径会触达的方法，全部无副作用 */
function stubWindow() {
    ;(globalThis as any).window = {
        electronAPI: {
            configRead: vi.fn(async () => null),
            configWrite: vi.fn(async () => true),
            conversationReadTail: vi.fn(async () => ({messages: [], totalCount: 0})),
            conversationReadMeta: vi.fn(async () => null),
            conversationDeleteBatch: vi.fn(async () => true),
            conversationUpdateMeta: vi.fn(async () => true),
            projectGroup: {list: vi.fn(async () => GROUPS)},
            workspace: {
                getByPath: vi.fn(async (p: string) => ({id: `ws-${p}`, path: p})),
                setCurrent: vi.fn(async () => true),
                getGitBranch: vi.fn(async () => 'main'),
                getGitBranches: vi.fn(async () => ({})),
                getCurrent: vi.fn(async () => null),
            },
        },
    }
}

/** 全新 store 实例（模块级监听器随 import 注册到当前 window 桩）。
 *  同时返回同一次模块注册表里的 projectGroupStore —— 必须是同一个实例，
 *  否则 getScopedSections 读到的组数据与夹具设的不是同一份。 */
async function loadStores() {
    vi.resetModules()
    const mod = await import('../../../src/renderer/stores/conversationStore')
    const groupMod = await import('../../../src/renderer/stores/projectGroupStore')
    return {
        store: mod.useConversationStore as any,
        groupStore: groupMod.useProjectGroupStore as any,
    }
}

function seed(store: any, groupStore: any) {
    groupStore.setState({groups: GROUPS})
    store.setState({
        workspaces: {
            [WS_A]: {lastOpenedAt: 2, conversations: [conv('c-a1')]},
            // B 的根会话带一个子会话（后代展开的判别力来源）
            [WS_B]: {lastOpenedAt: 1, conversations: [conv('c-b1'), conv('c-b2', {parentConvId: 'c-b1'})]},
        },
        currentWorkspacePath: WS_A,
        activeConversationId: null,
        messagesMap: {},
        loadedMessages: [],
        viewScope: {type: 'group', groupId: 'pg-a'},
        collapsedGroupIds: [],
        gitBranch: 'main',
    })
}

const settle = () => new Promise(r => setTimeout(r, 0))

beforeEach(() => {
    stubWindow()
})

afterEach(() => {
    delete (globalThis as any).window
})

describe('I-1(b) 会话操作按「会话自身所属项目」（组视图 + 非当前项目）', () => {
    it('deleteConversation：B 的后代一并进实删集、且 B 的列表里该行消失（A 的列表不受影响）', async () => {
        const {store, groupStore} = await loadStores()
        seed(store, groupStore)

        await store.getState().deleteConversation('c-b1')

        // 实删集精确 = {c-b1, c-b2}（旧代码按 currentWorkspacePath=A 展开 → 只有 c-b1，B 的子会话成孤儿）
        const deleted = (globalThis as any).window.electronAPI.conversationDeleteBatch.mock.calls[0][0]
        expect([...deleted].sort()).toEqual(['c-b1', 'c-b2'])
        expect(store.getState().workspaces[WS_B].conversations).toEqual([])
        expect(store.getState().workspaces[WS_A].conversations.map((c: any) => c.id)).toEqual(['c-a1'])
    })

    it('deleteConversations：入参会话的后代跨项目展开（不只看 currentWorkspacePath）', async () => {
        const {store, groupStore} = await loadStores()
        seed(store, groupStore)

        await store.getState().deleteConversations(['c-b1'])

        const deleted = (globalThis as any).window.electronAPI.conversationDeleteBatch.mock.calls[0][0]
        expect([...deleted].sort()).toEqual(['c-b1', 'c-b2'])
        expect(store.getState().workspaces[WS_B].conversations.map((c: any) => c.id)).toEqual([])
    })

    it('togglePinConversation：pinned 真的落到 B 的列表条目 + 真落库（不是恒 false）', async () => {
        const {store, groupStore} = await loadStores()
        seed(store, groupStore)

        store.getState().togglePinConversation('c-b1')

        const pinned = store.getState().workspaces[WS_B].conversations.find((c: any) => c.id === 'c-b1')
        expect(pinned.pinned).toBe(true)
        // 旧代码按 A 改 → 找不到 c-b1，newPinned 恒 false，落库写的是 {pinned:false}
        expect((globalThis as any).window.electronAPI.conversationUpdateMeta)
            .toHaveBeenCalledWith('c-b1', {pinned: true})
    })

    it('updateConversationMeta：重命名真的更新 B 的列表条目标题', async () => {
        const {store, groupStore} = await loadStores()
        seed(store, groupStore)

        store.getState().updateConversationMeta('c-b1', {title: 'B 改名'})

        const renamed = store.getState().workspaces[WS_B].conversations.find((c: any) => c.id === 'c-b1')
        expect(renamed.title).toBe('B 改名')
        expect(store.getState().workspaces[WS_A].conversations.map((c: any) => c.title)).toEqual(['c-a1'])
    })
})

describe('I-1(a) syncCurrentProject —— 同步「我在哪干活」（不写 viewScope）', () => {
    it('switchActiveConversation 到 B 的会话 → currentWorkspacePath 跟随 B、viewScope 仍是组视图', async () => {
        const {store, groupStore} = await loadStores()
        seed(store, groupStore)

        await store.getState().setActiveConversation('c-b1')
        await settle()

        expect(store.getState().activeConversationId).toBe('c-b1')
        expect(store.getState().currentWorkspacePath).toBe(WS_B)
        // ★ 关键：组内换会话 ≠ 离开组视图（不写 viewScope）
        expect(store.getState().viewScope).toEqual({type: 'group', groupId: 'pg-a'})
        // 主进程当前项目同步（重启后 current_workspace_id 不落伍）
        expect((globalThis as any).window.electronAPI.workspace.setCurrent).toHaveBeenCalledWith(`ws-${WS_B}`)
    })

    it('switchActiveConversation 到子会话（B 的子）同样按所属项目同步「在哪干活」', async () => {
        const {store, groupStore} = await loadStores()
        seed(store, groupStore)

        await store.getState().setActiveConversation('c-b2')
        await settle()

        expect(store.getState().currentWorkspacePath).toBe(WS_B)
    })

    it('followScopeToProject：viewScope 与 currentWorkspacePath 一起走', async () => {
        const {store, groupStore} = await loadStores()
        seed(store, groupStore)

        store.getState().followScopeToProject(WS_B)

        expect(store.getState().viewScope).toEqual({type: 'project', path: WS_B})
        expect(store.getState().currentWorkspacePath).toBe(WS_B)
    })

    it('等价键（同目录另一种写法）同步时不新写键、不重复补条目', async () => {
        const {store, groupStore} = await loadStores()
        seed(store, groupStore)

        store.getState().syncCurrentProject(WS_A)

        expect(store.getState().currentWorkspacePath).toBe(WS_A)
        expect(Object.keys(store.getState().workspaces)).toEqual([WS_A, WS_B])
    })
})

describe('I-4 登记即渲染（组内「添加项目」的新成员段）', () => {
    it('ensureWorkspaceRegistered 成功 → workspaces 补空条目 → getScopedSections 含该段（不切视图）', async () => {
        const {store, groupStore} = await loadStores()
        seed(store, groupStore)
        groupStore.setState({groups: [{
            ...GROUPS[0],
            members: [...GROUPS[0].members, {projectPath: WS_NEW, groupOrder: 2}],
        }]})

        const key = await store.getState().ensureWorkspaceRegistered(WS_NEW)

        expect(key).toBe(WS_NEW)
        expect(store.getState().workspaces[WS_NEW]).toEqual({lastOpenedAt: expect.any(Number), conversations: []})
        // 段可渲染：resolveScopeProjectPaths 的「只保留可见项目」不再把它滤掉
        expect(store.getState().getScopedSections().map((s: any) => s.projectPath))
            .toEqual([WS_A, WS_B, WS_NEW])
        // 不切视图 / 不切当前项目
        expect(store.getState().currentWorkspacePath).toBe(WS_A)
        expect(store.getState().viewScope).toEqual({type: 'group', groupId: 'pg-a'})
    })

    it('已存在等价键时不重复补条目（复用既有键）', async () => {
        const {store, groupStore} = await loadStores()
        seed(store, groupStore)

        const key = await store.getState().ensureWorkspaceRegistered(WS_B)

        expect(key).toBe(WS_B)
        expect(Object.keys(store.getState().workspaces)).toEqual([WS_A, WS_B])
    })
})
