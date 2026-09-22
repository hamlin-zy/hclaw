// @vitest-environment jsdom
/**
 * 组视图「最近会话」跨项目区块（spec §16 追加）
 *
 * 覆盖：渲染条件（组视图 / 非组视图 / 搜索态 / 空结果）、updatedAt desc 排序、
 * 项目徽章、运行脉冲与「待确认」徽章、点击跳转 openConversationInWorkspace。
 * mock 口径复刻 ConversationSidebar.sections.test.tsx。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, fireEvent, cleanup} from '@testing-library/react'

const section = (over: Partial<any> = {}) => ({
    key: '/ws/a', projectPath: '/ws/a', projectName: 'a', gitBranch: 'main',
    collapsed: false, count: 1, hasMore: false,
    rows: [{id: 'c-a1', indentLevel: 0, childCount: 0}], ...over,
})

const convState = vi.hoisted(() => ({
    viewScope: {type: 'group', groupId: 'pg-a'} as {type: string; groupId?: string; path?: string} | null,
    currentWorkspacePath: '/ws/a' as string | null,
    activeConversationId: null as string | null,
    searchQuery: '',
    collapsedGroupIds: [] as string[],
    sectionWindowSizes: {} as Record<string, number>,
    singleViewWindowHintShown: false,
    gitBranches: {} as Record<string, string | null>,
    gitBranch: 'main' as string | null,
    pendingFocusProject: null as string | null,
    workspaces: {} as Record<string, {lastOpenedAt: number; conversations: any[]}>,
    getScopedSections: vi.fn((): any[] => []),
    expandSection: vi.fn(),
    dismissWindowHint: vi.fn(),
    toggleSectionCollapsed: vi.fn(),
    focusProjectSegment: vi.fn(),
    clearFocusProject: vi.fn(),
    refreshVisibleBranches: vi.fn(async () => {}),
    setSearchQuery: vi.fn(),
    setProjectGroupView: vi.fn(),
    preloadConversation: vi.fn(async () => {}),
    openConversationInWorkspace: vi.fn(async () => {}),
}))
vi.mock('../../../src/renderer/stores/conversationStore', () => ({
    useConversationStore: Object.assign(
        (sel: (s: typeof convState) => unknown) => sel(convState),
        {getState: () => convState},
    ),
}))
const agentState = vi.hoisted(() => ({
    convAgentStates: {} as Record<string, any>,
    doneUnreadIds: {} as Record<string, number>,
    clearConvDoneUnread: vi.fn(),
}))
vi.mock('../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: (sel: (s: typeof agentState) => unknown) => sel(agentState),
}))
vi.mock('../../../src/renderer/stores/sidebarStore', () => ({
    useSidebarStore: {getState: () => ({leftCollapsed: false})},
}))
vi.mock('../../../src/renderer/stores/themeStore', () => ({
    useThemeStore: {getState: () => ({theme: 'light'})},
}))
vi.mock('../../../src/renderer/services/newConversation', () => ({
    newConversation: vi.fn(async () => 'conv-new'),
}))

import {ConversationList} from '../../../src/renderer/components/ConversationSidebar'
import {useProjectGroupStore} from '../../../src/renderer/stores/projectGroupStore'

const conv = (id: string, updatedAt: number, title = id) => ({
    id, title, preview: '', createdAt: 0, updatedAt, status: 'active',
})

/** 两个成员项目：/ws/a（c-a1 updated 100）/ /ws/b（c-b1 updated 300） */
function setupTwoProjects() {
    convState.getScopedSections.mockReturnValue([
        section(),
        section({key: '/ws/b', projectPath: '/ws/b', projectName: 'b', rows: [{id: 'c-b1', indentLevel: 0, childCount: 0}]}),
    ])
    convState.workspaces = {
        '/ws/a': {lastOpenedAt: 1, conversations: [conv('c-a1', 100)]},
        '/ws/b': {lastOpenedAt: 2, conversations: [conv('c-b1', 300)]},
    }
}

beforeEach(() => {
    vi.clearAllMocks()
    useProjectGroupStore.setState({groups: []})
    convState.viewScope = {type: 'group', groupId: 'pg-a'}
    convState.searchQuery = ''
    convState.activeConversationId = null
    agentState.convAgentStates = {}
    setupTwoProjects()
    ;(window as any).electronAPI = {projectManager: {openProjectManager: vi.fn()}}
})
afterEach(cleanup)

const sectionEl = () => document.querySelector('[data-name="sidebar-recent-section"]')
const rows = () => Array.from(document.querySelectorAll('[data-name="sidebar-recent-section"] [data-name="conversation-sidebar-item-row"]'))

describe('组视图「最近会话」区块', () => {
    it('组视图渲染：updatedAt desc 排序 + 项目徽章', () => {
        render(<ConversationList/>)
        expect(sectionEl()).not.toBeNull()
        expect(document.querySelector('[data-name="sidebar-recent-header"]')?.textContent).toContain('最近会话')
        expect(rows().map(r => r.getAttribute('data-name'))).toHaveLength(2)
        // 项目徽章（basename）
        const badges = Array.from(document.querySelectorAll('[data-name="recent-item-project-badge"]'))
        expect(badges.map(b => b.textContent)).toEqual(['b', 'a']) // b 项目 updatedAt 更新，排前
    })

    it('点击行 = openConversationInWorkspace(convId, workspacePath, {follow:false})（组视图内不写 viewScope）', () => {
        render(<ConversationList/>)
        fireEvent.click(rows()[0]) // 第一行 = c-b1（/ws/b）
        expect(convState.openConversationInWorkspace).toHaveBeenCalledWith('c-b1', '/ws/b', {follow: false})
    })

    it('非组视图（项目 scope）不渲染区块', () => {
        convState.viewScope = {type: 'project', path: '/ws/a'}
        render(<ConversationList/>)
        expect(sectionEl()).toBeNull()
    })

    it('搜索态不渲染区块', () => {
        convState.searchQuery = '关键词'
        render(<ConversationList/>)
        expect(sectionEl()).toBeNull()
    })

    it('运行中会话：脉冲环类（animate-running-pulse）', () => {
        agentState.convAgentStates = {'c-b1': {agentState: {status: 'running'}}}
        render(<ConversationList/>)
        expect(rows()[0].querySelector('.animate-running-pulse')).not.toBeNull()
    })

    it('待确认会话：「待确认」徽章', () => {
        agentState.convAgentStates = {'c-b1': {pendingQuestion: {question: 'q'}}}
        render(<ConversationList/>)
        expect(rows()[0].textContent).toContain('待确认')
    })
})
