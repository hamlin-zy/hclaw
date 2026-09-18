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
        collapsedGroupIds: [],
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

    it('toggleSectionCollapsed 在同一 key 上反复切换', () => {
        const {toggleSectionCollapsed} = useConversationStore.getState()
        toggleSectionCollapsed('pg-a')
        expect(useConversationStore.getState().collapsedGroupIds).toEqual(['pg-a'])
        toggleSectionCollapsed('pg-a')
        expect(useConversationStore.getState().collapsedGroupIds).toEqual([])
    })
})

describe('viewScope — 持久化读写', () => {
    it('setViewScope 写入 configWrite("project-group-view", {viewScope, collapsedGroupIds})', async () => {
        api.configWrite.mockResolvedValue(true)
        useConversationStore.getState().setViewScope({type: 'group', groupId: 'pg-a'})
        await vi.waitFor(() => expect(api.configWrite).toHaveBeenCalled())
        const [key, value] = api.configWrite.mock.calls[0]
        expect(key).toBe('project-group-view')
        expect(value).toEqual({viewScope: {type: 'group', groupId: 'pg-a'}, collapsedGroupIds: []})
    })

    it('toggleSectionCollapsed 同样落盘（折叠状态跨重启保留，⑥ 已定 (a)）', async () => {
        api.configWrite.mockResolvedValue(true)
        useConversationStore.getState().toggleSectionCollapsed('pg-a')
        await vi.waitFor(() => expect(api.configWrite).toHaveBeenCalled())
        expect(api.configWrite.mock.calls[0][1].collapsedGroupIds).toEqual(['pg-a'])
    })

    it('restoreScope 读回上次 scope 与折叠集合', async () => {
        api.configRead.mockResolvedValue({
            viewScope: {type: 'group', groupId: 'pg-a'},
            collapsedGroupIds: ['pg-a'],
        })
        await useConversationStore.getState().restoreScope()
        const s = useConversationStore.getState()
        expect(s.viewScope).toEqual({type: 'group', groupId: 'pg-a'})
        expect(s.collapsedGroupIds).toEqual(['pg-a'])
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
        api.configRead.mockResolvedValue({viewScope: null, collapsedGroupIds: [], singleViewWindowHintShown: true})
        await useConversationStore.getState().restoreScope()
        expect(useConversationStore.getState().singleViewWindowHintShown).toBe(true)
    })

    it('存量 payload 无该键 → 默认 false（未提示过）', async () => {
        useConversationStore.setState({singleViewWindowHintShown: true})
        api.configRead.mockResolvedValue({viewScope: null, collapsedGroupIds: []})
        await useConversationStore.getState().restoreScope()
        expect(useConversationStore.getState().singleViewWindowHintShown).toBe(false)
    })

    // ── 载荷形状守卫（加固 1：system_settings 被篡改时不得让 App init 静默跳过后续初始化）──

    it('载荷被篡改（viewScope.path 非字符串）→ 不抛错，按「无持久化」回退', async () => {
        api.configRead.mockResolvedValue({
            viewScope: {type: 'project', path: 42},
            collapsedGroupIds: 'not-an-array',
            singleViewWindowHintShown: 'yes',
        })
        // 旧实现：workspacePathKey(42) → TypeError 逃出 restoreScope（App init 的 try 会整段跳过）
        await expect(useConversationStore.getState().restoreScope()).resolves.toBeUndefined()
        const s = useConversationStore.getState()
        expect(s.viewScope).toEqual({type: 'project', path: '/ws/a'})
        expect(s.collapsedGroupIds).toEqual([])
        expect(s.singleViewWindowHintShown).toBe(false)
    })

    it('载荷非对象（字符串）→ 当作无持久化，同样不抛错', async () => {
        api.configRead.mockResolvedValue('garbage')
        await expect(useConversationStore.getState().restoreScope()).resolves.toBeUndefined()
        expect(useConversationStore.getState().viewScope).toEqual({type: 'project', path: '/ws/a'})
    })

    it('折叠集合里的非字符串项被过滤（合法项保留）', async () => {
        api.configRead.mockResolvedValue({viewScope: null, collapsedGroupIds: ['/ws/a', 7, null]})
        await useConversationStore.getState().restoreScope()
        expect(useConversationStore.getState().collapsedGroupIds).toEqual(['/ws/a'])
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
