import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'

/** 最小 electronAPI 桩：只提供本任务用到的 configRead/configWrite */
const api = {configRead: vi.fn(), configWrite: vi.fn()}

vi.mock('../../../src/renderer/lib/search', () => ({
    fuzzyFilter: (items: unknown[]) => items,
}))
vi.mock('../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: {
        getState: () => ({
            convAgentStates: {}, updateConvData: () => {}, removeConvData: () => {},
            flushPendingStreamData: () => {}, reconcileStreamingContent: () => {},
            refreshActiveBatch: () => {},
        }),
        setState: () => {},
    },
    createDefaultConvData: () => ({agentState: {status: 'idle', mode: 'auto', phase: 'idle'}}),
}))

import {
    useConversationStore,
    resolveScopeFallback,
    type ViewScope,
} from '../../../src/renderer/stores/conversationStore'

const GROUPS = [
    {id: 'pg-a', name: '组A', sortOrder: 0, createdAt: 1, updatedAt: 1,
     members: [{projectPath: '/ws/a', groupOrder: 0}, {projectPath: '/ws/b', groupOrder: 1}]},
]

beforeEach(() => {
    vi.resetAllMocks()
    ;(globalThis as any).window = {electronAPI: {...api, projectGroup: {list: vi.fn(async () => GROUPS)}}}
    useConversationStore.setState({
        workspaces: {
            '/ws/a': {lastOpenedAt: 1, conversations: []},
            '/ws/b': {lastOpenedAt: 1, conversations: []},
        },
        currentWorkspacePath: '/ws/a',
        activeConversationId: null,
        viewScope: null,
        expandedGroupIds: [],
        manualCollapsedGroupIds: [],
        singleViewWindowHintShown: false,
    })
})
afterEach(() => { delete (globalThis as any).window })

describe('viewScope — 状态语义', () => {
    it('setProjectGroupView 只改 viewScope，不动 currentWorkspacePath / activeConversationId', () => {
        useConversationStore.setState({activeConversationId: 'conv-1'})
        useConversationStore.getState().setProjectGroupView('pg-a')
        const s = useConversationStore.getState()
        expect(s.viewScope).toEqual({type: 'group', groupId: 'pg-a'})
        expect(s.currentWorkspacePath).toBe('/ws/a')
        expect(s.activeConversationId).toBe('conv-1')
    })

    it('setViewScope({type:\'project\'}) 同步 scope 到项目', () => {
        useConversationStore.getState().setViewScope({type: 'project', path: '/ws/b'})
        expect(useConversationStore.getState().viewScope).toEqual({type: 'project', path: '/ws/b'})
    })

    it('toggleSectionCollapsed 在同一 key 上反复切换（展开集语义：加入 → 移出）', () => {
        const {toggleSectionCollapsed} = useConversationStore.getState()
        toggleSectionCollapsed('pg-a')
        expect(useConversationStore.getState().expandedGroupIds).toEqual(['pg-a'])
        toggleSectionCollapsed('pg-a')
        expect(useConversationStore.getState().expandedGroupIds).toEqual([])
    })

    // ── 2026-10-14 三态修订：手动折叠是一等状态，压过「激活即展开」──────────
    describe('collapseSection — 显式折叠（互斥不变量 + 落盘）', () => {
        it('collapseSection 入手动折叠集，同时把该 key 移出展开集（互斥）', () => {
            useConversationStore.setState({expandedGroupIds: ['pg-a', '/ws/b'], manualCollapsedGroupIds: []})
            useConversationStore.getState().collapseSection('pg-a')
            const s = useConversationStore.getState()
            expect(s.manualCollapsedGroupIds).toEqual(['pg-a'])
            expect(s.expandedGroupIds).toEqual(['/ws/b'])
        })

        it('toggleSectionCollapsed 展开时同步清出手动折叠集（互斥）', () => {
            useConversationStore.setState({manualCollapsedGroupIds: ['pg-a'], expandedGroupIds: []})
            useConversationStore.getState().toggleSectionCollapsed('pg-a')
            const s = useConversationStore.getState()
            expect(s.expandedGroupIds).toEqual(['pg-a'])
            expect(s.manualCollapsedGroupIds).toEqual([])
        })

        it('反复 collapse 同一 key 不重复入集（幂等）', () => {
            const {collapseSection} = useConversationStore.getState()
            collapseSection('pg-a')
            collapseSection('pg-a')
            expect(useConversationStore.getState().manualCollapsedGroupIds).toEqual(['pg-a'])
        })

        it('collapseSection 落盘 manualCollapsedGroupIds（跨重启保留）', async () => {
            api.configWrite.mockResolvedValue(true)
            useConversationStore.setState({expandedGroupIds: ['pg-a'], manualCollapsedGroupIds: []})
            useConversationStore.getState().collapseSection('pg-a')
            await vi.waitFor(() => expect(api.configWrite).toHaveBeenCalled())
            expect(api.configWrite.mock.calls[0][1].manualCollapsedGroupIds).toEqual(['pg-a'])
            expect(api.configWrite.mock.calls[0][1].expandedGroupIds).toEqual([])
        })
    })
})

describe('viewScope — 持久化读写', () => {
    it('setViewScope 写入 configWrite("project-group-view", {viewScope, expandedGroupIds})', async () => {
        api.configWrite.mockResolvedValue(true)
        useConversationStore.getState().setViewScope({type: 'group', groupId: 'pg-a'})
        await vi.waitFor(() => expect(api.configWrite).toHaveBeenCalled())
        const [key, value] = api.configWrite.mock.calls[0]
        expect(key).toBe('project-group-view')
        expect(value).toEqual({
            viewScope: {type: 'group', groupId: 'pg-a'},
            expandedGroupIds: [],
            manualCollapsedGroupIds: [],
        })
    })

    it('toggleSectionCollapsed 同样落盘（展开集跨重启保留，⑥ 修订 2026-09-26）', async () => {
        api.configWrite.mockResolvedValue(true)
        useConversationStore.getState().toggleSectionCollapsed('pg-a')
        await vi.waitFor(() => expect(api.configWrite).toHaveBeenCalled())
        expect(api.configWrite.mock.calls[0][1].expandedGroupIds).toEqual(['pg-a'])
    })

    it('restoreScope 读回上次 scope 与展开集合', async () => {
        api.configRead.mockResolvedValue({
            viewScope: {type: 'group', groupId: 'pg-a'},
            expandedGroupIds: ['pg-a'],
        })
        await useConversationStore.getState().restoreScope()
        const s = useConversationStore.getState()
        expect(s.viewScope).toEqual({type: 'group', groupId: 'pg-a'})
        expect(s.expandedGroupIds).toEqual(['pg-a'])
    })

    it('restoreScope 读回手动折叠集（激活段折叠意图跨重启保留）', async () => {
        api.configRead.mockResolvedValue({
            viewScope: {type: 'group', groupId: 'pg-a'},
            expandedGroupIds: [],
            manualCollapsedGroupIds: ['pg-a'],
        })
        await useConversationStore.getState().restoreScope()
        const s = useConversationStore.getState()
        expect(s.manualCollapsedGroupIds).toEqual(['pg-a'])
    })

    it('存量 payload 无 manualCollapsedGroupIds 键 → 空集（行为与修订前一致）', async () => {
        useConversationStore.setState({manualCollapsedGroupIds: ['/ws/a']})
        api.configRead.mockResolvedValue({viewScope: null, expandedGroupIds: []})
        await useConversationStore.getState().restoreScope()
        expect(useConversationStore.getState().manualCollapsedGroupIds).toEqual([])
    })

    // ── §15.1⑤ 一次性提示已读标记（Task 14）─────────────────

    it('dismissWindowHint 置位并落盘', async () => {
        api.configWrite.mockResolvedValue(true)
        useConversationStore.getState().dismissWindowHint()
        await vi.waitFor(() => expect(api.configWrite).toHaveBeenCalled())
        expect(useConversationStore.getState().singleViewWindowHintShown).toBe(true)
        expect(api.configWrite.mock.calls[0][1].singleViewWindowHintShown).toBe(true)
    })

    it('restoreScope 读回 singleViewWindowHintShown', async () => {
        api.configRead.mockResolvedValue({viewScope: null, expandedGroupIds: [], singleViewWindowHintShown: true})
        await useConversationStore.getState().restoreScope()
        expect(useConversationStore.getState().singleViewWindowHintShown).toBe(true)
    })

    it('存量 payload 无该键 → 默认 false（未提示过）', async () => {
        useConversationStore.setState({singleViewWindowHintShown: true})
        api.configRead.mockResolvedValue({viewScope: null, expandedGroupIds: []})
        await useConversationStore.getState().restoreScope()
        expect(useConversationStore.getState().singleViewWindowHintShown).toBe(false)
    })

    // ── 载荷形状守卫（加固 1：system_settings 被篡改时不得让 App init 静默跳过后续初始化）──

    it('载荷被篡改（viewScope.path 非字符串）→ 不抛错，按「无持久化」回退', async () => {
        api.configRead.mockResolvedValue({
            viewScope: {type: 'project', path: 42},
            expandedGroupIds: 'not-an-array',
            manualCollapsedGroupIds: 'not-an-array',
            singleViewWindowHintShown: 'yes',
        })
        // 旧实现：workspacePathKey(42) → TypeError 逃出 restoreScope（App init 的 try 会整段跳过）
        await expect(useConversationStore.getState().restoreScope()).resolves.toBeUndefined()
        const s = useConversationStore.getState()
        expect(s.viewScope).toEqual({type: 'project', path: '/ws/a'})
        expect(s.expandedGroupIds).toEqual([])
        expect(s.manualCollapsedGroupIds).toEqual([])
        expect(s.singleViewWindowHintShown).toBe(false)
    })

    it('载荷非对象（字符串）→ 当作无持久化，同样不抛错', async () => {
        api.configRead.mockResolvedValue('garbage')
        await expect(useConversationStore.getState().restoreScope()).resolves.toBeUndefined()
        expect(useConversationStore.getState().viewScope).toEqual({type: 'project', path: '/ws/a'})
    })

    it('展开集合里的非字符串项被过滤（合法项保留）', async () => {
        api.configRead.mockResolvedValue({viewScope: null, expandedGroupIds: ['/ws/a', 7, null]})
        await useConversationStore.getState().restoreScope()
        expect(useConversationStore.getState().expandedGroupIds).toEqual(['/ws/a'])
    })

    it('手动折叠集合里的非字符串项被过滤（合法项保留）', async () => {
        api.configRead.mockResolvedValue({
            viewScope: null, expandedGroupIds: [],
            manualCollapsedGroupIds: ['/ws/a', 7, null],
        })
        await useConversationStore.getState().restoreScope()
        expect(useConversationStore.getState().manualCollapsedGroupIds).toEqual(['/ws/a'])
    })

    // 2026-10-14 三态修订：旧字段名 D19 前 collapsedGroupIds 已停读停写，**不得**被
    // 当成新的手动折叠集误读（同名不同义：旧字段属「默认展开」体系）。
    it('旧 payload 仅含 D19 前 collapsedGroupIds → 忽略，不回填 manualCollapsedGroupIds', async () => {
        api.configRead.mockResolvedValue({viewScope: null, expandedGroupIds: [], collapsedGroupIds: ['pg-a', '/ws/b']})
        await useConversationStore.getState().restoreScope()
        expect(useConversationStore.getState().manualCollapsedGroupIds).toEqual([])
    })

    // 2026-09-26 修订：旧字段 collapsedGroupIds 停读停写——老 payload 只含旧字段时
    // 一律忽略（不反向迁移、不双写），组视图回到「默认折叠」基线。
    it('旧 payload 仅含 collapsedGroupIds → 忽略，不回填 expandedGroupIds', async () => {
        api.configRead.mockResolvedValue({viewScope: null, collapsedGroupIds: ['pg-a', '/ws/b']})
        await useConversationStore.getState().restoreScope()
        expect(useConversationStore.getState().expandedGroupIds).toEqual([])
    })
})

describe('resolveScopeFallback — 重启三级回退', () => {
    it('组仍存在 → 原样恢复', () => {
        const stored: ViewScope = {type: 'group', groupId: 'pg-a'}
        expect(resolveScopeFallback({stored, groups: GROUPS, currentWorkspacePath: '/ws/a', activeConvWorkspacePath: null}))
            .toEqual(stored)
    })

    it('组已删除 → 回退到激活会话所属项目', () => {
        const stored: ViewScope = {type: 'group', groupId: 'pg-gone'}
        expect(resolveScopeFallback({stored, groups: GROUPS, currentWorkspacePath: '/ws/a', activeConvWorkspacePath: '/ws/b'}))
            .toEqual({type: 'project', path: '/ws/b'})
    })

    it('组已删除且无激活会话 → 回退到 currentWorkspacePath', () => {
        const stored: ViewScope = {type: 'group', groupId: 'pg-gone'}
        expect(resolveScopeFallback({stored, groups: GROUPS, currentWorkspacePath: '/ws/a', activeConvWorkspacePath: null}))
            .toEqual({type: 'project', path: '/ws/a'})
    })

    it('全空 → null（走现有空态）', () => {
        expect(resolveScopeFallback({stored: null, groups: [], currentWorkspacePath: null, activeConvWorkspacePath: null}))
            .toBeNull()
    })

    it('恢复的项目视角其项目已不存在 → 落到 currentWorkspacePath', () => {
        const stored: ViewScope = {type: 'project', path: '/ws/gone'}
        expect(resolveScopeFallback({stored, groups: [], currentWorkspacePath: '/ws/a', activeConvWorkspacePath: null}))
            .toEqual({type: 'project', path: '/ws/a'})
    })
})
