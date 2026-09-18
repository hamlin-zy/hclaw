/**
 * 「未归属」虚拟分组回归测试：
 *  - loadConversations 收纳 workspacePath 为空的会话进 UNASSIGNED_WORKSPACE_KEY 段；
 *  - getScopedSections 组视图追加「未归属」段 / 单项目视图不显示 / 零项目时单独成段；
 *  - getFilteredConversations（含搜索）能覆盖未归属会话。
 *
 * 隔离：mock agentStore / electronAPI（不触碰真实 IPC / SQLite）。
 */
import {describe, expect, it, beforeEach, vi} from 'vitest'

const groupsState = {groups: [
    {id: 'pg-a', name: '组A', sortOrder: 0, createdAt: 1, updatedAt: 1,
     members: [{projectPath: '/ws/a', groupOrder: 0}]},
]}
vi.mock('../../../src/renderer/stores/projectGroupStore', () => ({
    useProjectGroupStore: {getState: () => groupsState},
    projectGroupOf: () => null,
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
vi.mock('../../../src/renderer/lib/search', () => ({
    fuzzyFilter: (items: any[], q: string, keys: string[]) =>
        q ? items.filter(i => keys.some(k => String(i[k] ?? '').includes(q))) : items,
}))

import {useConversationStore} from '../../../src/renderer/stores/conversationStore'
import {UNASSIGNED_WORKSPACE_KEY} from '../../../src/renderer/lib/workspacePath'

const listMock = vi.hoisted(() => vi.fn())

function conv(n: number, extra: Record<string, unknown> = {}) {
    return {id: `c-${n}`, title: `会话${n}`, preview: '', createdAt: 1000 + n, updatedAt: 2000 + n, ...extra}
}

beforeEach(() => {
    listMock.mockReset()
    ;(globalThis as any).window = {
        electronAPI: {
            conversationList: listMock,
            workspace: {
                getCurrent: vi.fn(async () => ({path: '/ws/a'})),
                getGitBranch: vi.fn(async () => null),
                getGitBranches: vi.fn(async () => ({})),
            },
        },
    }
    useConversationStore.setState({
        workspaces: {},
        currentWorkspacePath: '/ws/a',
        activeConversationId: null,
        viewScope: {type: 'group', groupId: 'pg-a'},
        searchQuery: '',
        collapsedGroupIds: [],
        sectionWindowSizes: {},
        messagesMap: {},
        loadedMessages: [],
        hasMoreMap: {},
        loadingMoreMap: {},
        renderedConversationIds: [],
        conversationLastActiveAt: {},
        gitBranches: {},
    })
})

describe('loadConversations — 未归属会话收纳', () => {
    it('workspacePath 为空的会话收入 UNASSIGNED_WORKSPACE_KEY 段，按 createdAt desc 排序', async () => {
        listMock.mockResolvedValue([
            {...conv(1), workspacePath: ''},
            {...conv(2), workspacePath: ''},
            {...conv(3), workspacePath: '/ws/a'},
        ])
        await useConversationStore.getState().loadConversations()
        const ws = useConversationStore.getState().workspaces
        expect(ws[UNASSIGNED_WORKSPACE_KEY].conversations.map(c => c.id)).toEqual(['c-2', 'c-1'])
        // 真实工作区不受影响
        expect(ws['/ws/a'].conversations.map(c => c.id)).toEqual(['c-3'])
    })
})

describe('getScopedSections — 未归属段可见性', () => {
    beforeEach(() => {
        useConversationStore.setState({
            workspaces: {
                '/ws/a': {lastOpenedAt: 2, conversations: [conv(1)]},
                [UNASSIGNED_WORKSPACE_KEY]: {lastOpenedAt: 1, conversations: [conv(2), conv(3)]},
            },
        })
    })

    it('组视图：未归属段追加在成员项目段之后，名称「未归属」、无分支', () => {
        const sections = useConversationStore.getState().getScopedSections()
        expect(sections.map(s => s.projectPath)).toEqual(['/ws/a', UNASSIGNED_WORKSPACE_KEY])
        expect(sections[1].projectName).toBe('未归属')
        expect(sections[1].gitBranch).toBeNull()
        expect(sections[1].count).toBe(2)
    })

    it('组视图：无未归属会话时不出现未归属段', () => {
        useConversationStore.setState({
            workspaces: {'/ws/a': {lastOpenedAt: 2, conversations: [conv(1)]}},
        })
        const sections = useConversationStore.getState().getScopedSections()
        expect(sections.map(s => s.projectPath)).toEqual(['/ws/a'])
    })

    it('单项目视图：不显示未归属段', () => {
        useConversationStore.setState({viewScope: {type: 'project', path: '/ws/a'}})
        const sections = useConversationStore.getState().getScopedSections()
        expect(sections.map(s => s.projectPath)).toEqual(['/ws/a'])
    })

    it('零项目但有未归属会话 → 单独一个未归属段', () => {
        useConversationStore.setState({
            viewScope: null,
            currentWorkspacePath: null,
            workspaces: {
                [UNASSIGNED_WORKSPACE_KEY]: {lastOpenedAt: 1, conversations: [conv(2)]},
            },
        })
        const sections = useConversationStore.getState().getScopedSections()
        expect(sections.map(s => s.projectPath)).toEqual([UNASSIGNED_WORKSPACE_KEY])
        expect(sections[0].projectName).toBe('未归属')
    })

    it('搜索可命中未归属会话（getFilteredConversations 覆盖虚拟段）', () => {
        useConversationStore.setState({searchQuery: '会话2'})
        const flat = useConversationStore.getState().getFilteredConversations()
        expect(flat.map(c => c.id)).toEqual(['c-2'])
    })
})
