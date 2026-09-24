import {describe, expect, it, beforeEach, vi} from 'vitest'

const groupsState = {groups: [
    {id: 'pg-a', name: '组A', sortOrder: 0, createdAt: 1, updatedAt: 1,
     members: [{projectPath: '/ws/a', groupOrder: 0}, {projectPath: '/ws/b', groupOrder: 1}, {projectPath: '/ws/c', groupOrder: 2}]},
]}
vi.mock('../../../src/renderer/stores/projectGroupStore', () => ({
    useProjectGroupStore: {getState: () => groupsState},
    projectGroupOf: () => null,
}))
vi.mock('../../../src/renderer/lib/search', () => ({
    fuzzyFilter: (items: any[], q: string, keys: string[]) =>
        q ? items.filter(i => keys.some(k => String(i[k] ?? '').includes(q))) : items,
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

import {useConversationStore} from '../../../src/renderer/stores/conversationStore'

function conv(n: number, extra: Record<string, unknown> = {}) {
    return {id: `c-${n}`, title: `会话${n}`, preview: '', createdAt: 1000 + n, updatedAt: 2000 + n, ...extra}
}

beforeEach(() => {
    ;(globalThis as any).window = {electronAPI: {}}
    useConversationStore.setState({
        workspaces: {
            '/ws/a': {lastOpenedAt: 2, conversations: [conv(1), conv(2)]},
            '/ws/b': {lastOpenedAt: 1, conversations: [conv(3)]},
        },
        gitBranches: {'/ws/a': 'main', '/ws/b': 'dev'},
        currentWorkspacePath: '/ws/a',
        viewScope: {type: 'group', groupId: 'pg-a'},
        searchQuery: '',
        collapsedGroupIds: [],
        sectionWindowSizes: {},
    })
})

describe('getScopedSections — 组视图', () => {
    it('组内项目按 group_order 顺序分段，各自带分支', () => {
        const sections = useConversationStore.getState().getScopedSections()
        expect(sections.map(s => s.projectPath)).toEqual(['/ws/a', '/ws/b', '/ws/c'])
        expect(sections.map(s => s.gitBranch)).toEqual(['main', 'dev', null])
    })

    it('R-28：未加载 workspaces 的组成员仍出现段（空会话占位，不过滤）', () => {
        // /ws/c 在 groupsState 里但 workspaces 不含 → 改前 filter 掉，改后保留
        const sections = useConversationStore.getState().getScopedSections()
        const wsC = sections.find(s => s.projectPath === '/ws/c')
        expect(wsC).toBeDefined()
        expect(wsC!.rows).toEqual([])
        expect(wsC!.count).toBe(0)
    })

    it('组已不存在 → 回退到 currentWorkspacePath 单段（不渲染空列表）', () => {
        useConversationStore.setState({viewScope: {type: 'group', groupId: 'pg-gone'}})
        const sections = useConversationStore.getState().getScopedSections()
        expect(sections.map(s => s.projectPath)).toEqual(['/ws/a'])
    })

    it('viewScope 为 null 时按 currentWorkspacePath 取单段', () => {
        useConversationStore.setState({viewScope: null})
        expect(useConversationStore.getState().getScopedSections().map(s => s.projectPath)).toEqual(['/ws/a'])
    })

    it('sectionWindowSizes 影响该段窗口（expandSection 后行数增加）', () => {
        useConversationStore.setState({
            workspaces: {'/ws/a': {lastOpenedAt: 1, conversations: Array.from({length: 15}, (_, i) => conv(i))}},
            viewScope: {type: 'project', path: '/ws/a'},
        })
        expect(useConversationStore.getState().getScopedSections()[0].rows).toHaveLength(6)
        useConversationStore.getState().expandSection('/ws/a')
        expect(useConversationStore.getState().sectionWindowSizes['/ws/a']).toBe(16)
        expect(useConversationStore.getState().getScopedSections()[0].rows).toHaveLength(15)
    })

    it('collapsedGroupIds 命中的段 collapsed=true 且 rows 为空', () => {
        useConversationStore.setState({collapsedGroupIds: ['/ws/b']})
        const sections = useConversationStore.getState().getScopedSections()
        expect(sections[1].collapsed).toBe(true)
        expect(sections[1].rows).toEqual([])
        expect(sections[1].count).toBe(1)
    })

    it('搜索命中时强制展开含命中项的段', () => {
        useConversationStore.setState({collapsedGroupIds: ['/ws/b'], searchQuery: '会话3'})
        const sections = useConversationStore.getState().getScopedSections()
        expect(sections[1].collapsed).toBe(false)
    })
})

describe('getFilteredConversations — 兼容既有消费方', () => {
    it('组视图下返回组内两段的会话平铺（行集与 sections 一致）', () => {
        const flat = useConversationStore.getState().getFilteredConversations()
        expect(flat.map(c => c.id).sort()).toEqual(['c-1', 'c-2', 'c-3'])
    })

    it('项目视图下行为与改造前一致（该项目会话按 pinned→createdAt desc）', () => {
        useConversationStore.setState({
            viewScope: {type: 'project', path: '/ws/a'},
            workspaces: {'/ws/a': {lastOpenedAt: 1, conversations: [conv(1, {pinned: true}), conv(2)]}},
        })
        expect(useConversationStore.getState().getFilteredConversations().map(c => c.id)).toEqual(['c-1', 'c-2'])
    })
})

describe('refreshVisibleBranches — 批量只读', () => {
    it('对当前可见项目一次性调 getGitBranches（含未加载组员），不新增 watch', async () => {
        // 2026-09-24 口径修订（用户反馈「有分支却不显示徽章」）：组视图下 /ws/c 从未作为工作区打开，
        // 但它照样会被渲染成段（R-28 占位），所以这里也必须下发查询 —— 旧口径曾把它过滤掉，
        // 导致该项目的段头分支永远是 null。主进程对不存在/非 git 路径返回 null，无需渲染端预筛。
        const getGitBranches = vi.fn(async (_paths: string[]) => ({'/ws/a': 'main', '/ws/b': 'dev', '/ws/c': 'feat'}))
        ;(globalThis as any).window = {electronAPI: {workspace: {getGitBranches}}}
        await useConversationStore.getState().refreshVisibleBranches()
        expect(getGitBranches).toHaveBeenCalledTimes(1)
        expect(getGitBranches.mock.calls[0][0].slice().sort()).toEqual(['/ws/a', '/ws/b', '/ws/c'])
        expect(useConversationStore.getState().gitBranches)
            .toEqual({'/ws/a': 'main', '/ws/b': 'dev', '/ws/c': 'feat'})
    })

    it('electronAPI 缺失时安全返回', async () => {
        ;(globalThis as any).window = {}
        await expect(useConversationStore.getState().refreshVisibleBranches()).resolves.toBeUndefined()
    })
})

// R-AU：项目档也必须优先认 viewScope（与组档的回退对称）。
// 场景来源：组视图内点其他成员项目的会话行只调 setActiveConversation（组内换会话 ≠ 离开组视图），
// 此时 currentWorkspacePath 仍是 A、活跃会话在 B；随后 handoff 跟随到 B 只写 viewScope，
// 若取数仍按 currentWorkspacePath=A 走，跟随就沦为 no-op（矩阵「handoff → 跟随」在组视图下不生效）。
describe('getScopedSections — 路径键归一（加固 2）', () => {
    it('组内成员写的是等价串（分隔符不同）→ 段仍渲染，且段 key = workspaces 实际键', () => {
        const saved = groupsState.groups
        groupsState.groups = [{
            id: 'pg-a', name: '组A', sortOrder: 0, createdAt: 1, updatedAt: 1,
            members: [{projectPath: 'E:\\ws\\a', groupOrder: 0}, {projectPath: 'E:/ws/b', groupOrder: 1}],
        }] as any
        try {
            useConversationStore.setState({
                workspaces: {
                    'E:\\ws\\a': {lastOpenedAt: 2, conversations: [conv(1)]},
                    'E:\\ws\\b': {lastOpenedAt: 1, conversations: [conv(2)]},
                },
                currentWorkspacePath: 'E:\\ws\\a',
                viewScope: {type: 'group', groupId: 'pg-a'},
                gitBranches: {},
            })
            const sections = useConversationStore.getState().getScopedSections()
            // 旧实现只比字面（`p in workspaces`）→ 两个成员都被滤掉 → 退化成 currentWorkspacePath 单段
            expect(sections.map(s => s.projectPath)).toEqual(['E:\\ws\\a', 'E:\\ws\\b'])
            expect(sections.map(s => s.rows.length)).toEqual([1, 1])
        } finally {
            groupsState.groups = saved
        }
    })

    it('项目档 viewScope.path 是等价串 → 认 scope 段（不回退 currentWorkspacePath）', () => {
        useConversationStore.setState({
            workspaces: {'E:\\ws\\b': {lastOpenedAt: 1, conversations: [conv(3)]}},
            currentWorkspacePath: 'E:\\ws\\a',
            viewScope: {type: 'project', path: 'E:/ws/b'},
        })
        const sections = useConversationStore.getState().getScopedSections()
        expect(sections.map(s => s.projectPath)).toEqual(['E:\\ws\\b'])
    })
})

describe('getScopedSections — 项目档优先认 viewScope（R-AU）', () => {
    it('viewScope.path 与 currentWorkspacePath 漂移时，按 viewScope.path 取单段', () => {
        useConversationStore.setState({
            viewScope: {type: 'project', path: '/ws/b'},
            currentWorkspacePath: '/ws/a',
        })
        const sections = useConversationStore.getState().getScopedSections()
        expect(sections.map(s => s.projectPath)).toEqual(['/ws/b'])
        expect(sections[0].rows.map(r => r.id)).toEqual(['c-3'])
    })

    it('followScopeToProject 之后同样按目标项目取单段（不是 no-op）', () => {
        useConversationStore.setState({
            viewScope: {type: 'group', groupId: 'pg-a'},
            currentWorkspacePath: '/ws/a',
        })
        useConversationStore.getState().followScopeToProject('/ws/b')
        expect(useConversationStore.getState().viewScope).toEqual({type: 'project', path: '/ws/b'})
        expect(useConversationStore.getState().getScopedSections().map(s => s.projectPath)).toEqual(['/ws/b'])
    })

    it('viewScope.path 不在 workspaces 里 → 回退 currentWorkspacePath 单段', () => {
        useConversationStore.setState({
            viewScope: {type: 'project', path: '/ws/gone'},
            currentWorkspacePath: '/ws/a',
        })
        expect(useConversationStore.getState().getScopedSections().map(s => s.projectPath)).toEqual(['/ws/a'])
    })
})
