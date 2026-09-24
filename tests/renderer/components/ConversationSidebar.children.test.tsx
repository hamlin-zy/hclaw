// @vitest-environment jsdom
/** 子会话独立分页（spec §5.5 / F14 / V5）；mock 样板逐字复制 Task 2 的 active.test.tsx */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, cleanup, fireEvent} from '@testing-library/react'

const convState = vi.hoisted(() => ({
    viewScope: {type: 'project', path: '/ws/a'} as any,
    currentWorkspacePath: '/ws/a' as string | null,
    activeConversationId: 'p1' as string | null,
    searchQuery: '', collapsedGroupIds: [] as string[], sectionWindowSizes: {} as Record<string, number>,
    childWindowSizes: {} as Record<string, number>,
    singleViewWindowHintShown: false, gitBranches: {} as Record<string, string | null>, gitBranch: 'main',
    pendingFocusProject: null as string | null,
    workspaces: {'/ws/a': {lastOpenedAt: 1, conversations: [] as any[]}},
    getScopedSections: vi.fn((): any[] => []),
    expandSection: vi.fn(), dismissWindowHint: vi.fn(), toggleSectionCollapsed: vi.fn(),
    expandChildParents: vi.fn(),
    setChildWindowSize: vi.fn(),
    focusProjectSegment: vi.fn(), clearFocusProject: vi.fn(), refreshVisibleBranches: vi.fn(async () => {}),
    setSearchQuery: vi.fn(), setProjectGroupView: vi.fn(), preloadConversation: vi.fn(async () => {}),
    openConversationInWorkspace: vi.fn(async () => {}), setActiveConversation: vi.fn(),
}))
vi.mock('../../../src/renderer/stores/conversationStore', () => ({
    useConversationStore: Object.assign((sel: any) => sel(convState), {getState: () => convState}),
}))
const agentState = vi.hoisted(() => ({convAgentStates: {} as Record<string, any>, doneUnreadIds: {} as Record<string, number>, clearConvDoneUnread: vi.fn()}))
vi.mock('../../../src/renderer/stores/agentStore', () => ({useAgentStore: (sel: any) => sel(agentState)}))
vi.mock('../../../src/renderer/stores/sidebarStore', async () => {
    // 透传真实 store：组件直接消费 useSidebarStore hook（Task 14 起），整体 mock 会落空
    const actual = await vi.importActual<Record<string, unknown>>('../../../src/renderer/stores/sidebarStore')
    return {...actual}
})
vi.mock('../../../src/renderer/stores/themeStore', () => ({useThemeStore: {getState: () => ({theme: 'light'})}}))
vi.mock('../../../src/renderer/services/newConversation', () => ({newConversation: vi.fn(async () => 'conv-new')}))

import {ConversationList} from '../../../src/renderer/components/ConversationSidebar'
import {useProjectGroupStore} from '../../../src/renderer/stores/projectGroupStore'

beforeEach(() => {
    vi.clearAllMocks()
    useProjectGroupStore.setState({groups: []})
    ;(window as any).electronAPI = {projectManager: {openProjectManager: vi.fn()}}
})
afterEach(cleanup)

describe('子会话分页', () => {
    const parent = {id: 'p1', title: 'p1', preview: '', createdAt: 900, updatedAt: 900, status: 'active'}
    const kids = Array.from({length: 7}, (_, i) => ({
        id: `k${i}`, title: `k${i}`, preview: '', createdAt: 800 - i, updatedAt: 800 - i, parentConvId: 'p1', status: 'active',
    }))

    beforeEach(() => {
        convState.workspaces['/ws/a'].conversations = [parent, ...kids]
        convState.getScopedSections.mockReturnValue([{
            key: '/ws/a', projectPath: '/ws/a', projectName: 'a', gitBranch: null,
            collapsed: false, count: 8, hasMore: false, totalRoots: 1,
            rows: [
                {id: 'p1', indentLevel: 0, childCount: 7, childShownCount: 3},
                ...kids.slice(0, 3).map(k => ({id: k.id, parentConvId: 'p1', indentLevel: 1, childCount: 0})),
            ],
        }])
    })

    it('子列表默认 3 条 + 末位控制条（∨∨ + 置灰 ∧∧∧），无「加载更多」', () => {
        render(<ConversationList/>)
        const bar = document.querySelector('[data-name="pager-bar"][data-pager-key="child"]') as HTMLElement
        expect(bar).not.toBeNull()
        expect(document.querySelector('[data-name="child-load-more"]')).toBeNull()
        expect((bar.querySelector('[data-name="pager-expand"]') as HTMLButtonElement).disabled).toBe(false)
    })

    it('子列表容器带引导线类且内容靠左排列', () => {
        render(<ConversationList/>)
        const list = document.querySelector('[data-name="child-list"]') as HTMLElement
        expect(list.className).toContain('tree-line')
        expect(list.className).toContain('items-start')
    })

    it('回炉反馈 1：子列表控制条与子行内容起点对齐（引导线内再缩进一步）', () => {
        render(<ConversationList/>)
        const bar = document.querySelector('[data-name="pager-bar"][data-pager-key="child"]') as HTMLElement
        // 改前红：旧实现无 paddingLeft —— 与子行（paddingLeft = 8px + n*indent-step）错位
        expect(bar.className).toContain('pl-[calc(8px+var(--indent-step))]')
    })

    it('回退迁位：子会话数徽章在会话图标角标位，不在行尾 meta 区', () => {
        render(<ConversationList/>)
        const row = document.querySelector('[data-name="conversation-sidebar-item-row"]')!
        const iconBox = row.firstElementChild as HTMLElement
        expect(iconBox.className).toContain('relative')
        const badge = iconBox.querySelector('[data-name="row-child-count-badge"]') as HTMLElement
        expect(badge).not.toBeNull()
        expect(badge.textContent).toBe('7')
        // 位置契约：绝对定位角标（-left-1 -top-1）叠在图标容器左上角
        expect(badge.className).toContain('absolute')
        // 行尾 meta 区不再有第二枚徽章：全文档仅一处
        expect(document.querySelectorAll('[data-name="row-child-count-badge"]').length).toBe(1)
        // 改前红：迁位版把角标移到行尾，图标容器内查不到该 data-name
    })

    it('点子级 ∨∨ 调 setChildWindowSize(p1, 6)', () => {
        render(<ConversationList/>)
        fireEvent.click(document.querySelector('[data-pager-key="child"] [data-name="pager-expand"]')!)
        expect(convState.setChildWindowSize).toHaveBeenCalledWith('p1', 6)
    })

    it('子会话数 ≤ 子会话第一页（3）：整条子级控制条不渲染（2026-09-24 收口新口径）', () => {
        convState.getScopedSections.mockReturnValue([{
            key: '/ws/a', projectPath: '/ws/a', projectName: 'a', gitBranch: null,
            collapsed: false, count: 4, hasMore: false, totalRoots: 1,
            rows: [
                {id: 'p1', indentLevel: 0, childCount: 3, childShownCount: 3},
                ...kids.slice(0, 3).map(k => ({id: k.id, parentConvId: 'p1', indentLevel: 1, childCount: 0})),
            ],
        }])
        render(<ConversationList/>)
        // 改前红：旧口径下渲染一条只含置灰 ∧∧∧ 的控制条（永远点不动的灰图标）
        expect(document.querySelector('[data-name="pager-bar"][data-pager-key="child"]')).toBeNull()
    })

    it('子行数量与顺序契约：默认窗口 3 条、按 createdAt desc 排在父行后（判别力：childrenOf 若顺序反转/漏兄弟行/多带全表，本用例即红）', () => {
        render(<ConversationList/>)
        const titles = Array.from(document.querySelectorAll('[data-name="conversation-sidebar-item-row"]'))
            .map(r => r.querySelector('[data-name="conversation-sidebar-item-title"]')?.textContent)
        // 改前红不存在（本用例是 2026-09-24 childrenOf 预建索引重构的判别力守卫：
        // 旧实现与其等价，两实现都须绿；实现若偏差才红）
        expect(titles).toEqual(['p1', 'k0', 'k1', 'k2'])
    })

    it('搜索态不渲染子级控制条', () => {
        const originalSearchQuery = convState.searchQuery
        try {
            convState.searchQuery = 'k'
            render(<ConversationList/>)
            expect(document.querySelector('[data-pager-key="child"]')).toBeNull()
        } finally {
            convState.searchQuery = originalSearchQuery
        }
    })
})

describe('新子会话自动展开收窄（2026-09-24 用户反馈：非激活会话诞生子会话不再抢占展开态）', () => {
    const mk = (id: string, extra: Record<string, unknown> = {}) =>
        ({id, title: id, preview: '', createdAt: 900, updatedAt: 900, status: 'active', ...extra})
    const sectionOf = (count: number, rows: any[]) => [{
        key: '/ws/a', projectPath: '/ws/a', projectName: 'a', gitBranch: null,
        collapsed: false, count, hasMore: false, totalRoots: 2, rows,
    }]

    beforeEach(() => {
        convState.activeConversationId = 'p1'
        convState.searchQuery = ''
        convState.viewScope = {type: 'project', path: '/ws/a'}
    })

    it('非激活父会话诞生新子会话：不自动展开该分支（改前红）', () => {
        const p1 = mk('p1', {createdAt: 900})
        const p2 = mk('p2', {createdAt: 800})
        const k7 = mk('k7', {createdAt: 700, parentConvId: 'p2'})
        convState.workspaces = {'/ws/a': {lastOpenedAt: 1, conversations: [p1, p2, k7]}}
        convState.getScopedSections.mockReturnValue(sectionOf(3, [
            {id: 'p1', indentLevel: 0, childCount: 0},
            {id: 'p2', indentLevel: 0, childCount: 1, childShownCount: 1},
            {id: 'k7', parentConvId: 'p2', indentLevel: 1, childCount: 0},
        ]) as any)
        const {rerender} = render(<ConversationList/>)
        expect(document.querySelector('[data-name="child-list"]')).toBeNull()

        // p2（非激活）诞生第二个子会话
        const k8 = mk('k8', {createdAt: 600, parentConvId: 'p2'})
        convState.workspaces = {'/ws/a': {lastOpenedAt: 1, conversations: [p1, p2, k7, k8]}}
        convState.getScopedSections.mockReturnValue(sectionOf(4, [
            {id: 'p1', indentLevel: 0, childCount: 0},
            {id: 'p2', indentLevel: 0, childCount: 2, childShownCount: 2},
            {id: 'k7', parentConvId: 'p2', indentLevel: 1, childCount: 0},
            {id: 'k8', parentConvId: 'p2', indentLevel: 1, childCount: 0},
        ]) as any)
        rerender(<ConversationList/>)

        // 改前红：旧实现无条件 addSelfAndAncestors → p2 的子列表被强行展开
        expect(document.querySelector('[data-name="child-list"]')).toBeNull()
    })

    it('激活会话诞生首个子会话：仍自动展开（回归守卫）', () => {
        const p1 = mk('p1', {createdAt: 900})
        const p2 = mk('p2', {createdAt: 800})
        const k7 = mk('k7', {createdAt: 700, parentConvId: 'p2'})
        convState.workspaces = {'/ws/a': {lastOpenedAt: 1, conversations: [p1, p2, k7]}}
        convState.getScopedSections.mockReturnValue(sectionOf(3, [
            {id: 'p1', indentLevel: 0, childCount: 0},
            {id: 'p2', indentLevel: 0, childCount: 1, childShownCount: 1},
            {id: 'k7', parentConvId: 'p2', indentLevel: 1, childCount: 0},
        ]) as any)
        const {rerender} = render(<ConversationList/>)
        expect(document.querySelector('[data-name="child-list"]')).toBeNull()

        // 激活会话 p1 诞生首个子会话（激活链 effect 不重跑 → 需本 effect 兜底展开）
        const k1 = mk('k1', {createdAt: 950, parentConvId: 'p1'})
        convState.workspaces = {'/ws/a': {lastOpenedAt: 1, conversations: [p1, p2, k7, k1]}}
        convState.getScopedSections.mockReturnValue(sectionOf(4, [
            {id: 'p1', indentLevel: 0, childCount: 1, childShownCount: 1},
            {id: 'k1', parentConvId: 'p1', indentLevel: 1, childCount: 0},
            {id: 'p2', indentLevel: 0, childCount: 1, childShownCount: 1},
            {id: 'k7', parentConvId: 'p2', indentLevel: 1, childCount: 0},
        ]) as any)
        rerender(<ConversationList/>)

        const list = document.querySelector('[data-name="child-list"]')
        expect(list).not.toBeNull()
        expect(list!.textContent).toContain('k1')
    })
})

describe('切视图：父会话子列表展开态重置（2026-09-24 用户反馈）', () => {
    it('手动展开的非激活父会话，切进组视图后子列表不再保持展开', () => {
        convState.activeConversationId = 'p1'
        convState.viewScope = {type: 'project', path: '/ws/a'}
        convState.workspaces['/ws/a'].conversations = [
            {id: 'p1', title: 'p1', preview: '', createdAt: 900, updatedAt: 900, status: 'active'},
            {id: 'p2', title: 'p2', preview: '', createdAt: 800, updatedAt: 800, status: 'active'},
            {id: 'k7', title: 'k7', preview: '', createdAt: 700, updatedAt: 700, parentConvId: 'p2', status: 'active'},
        ]
        convState.getScopedSections.mockReturnValue([{
            key: '/ws/a', projectPath: '/ws/a', projectName: 'a', gitBranch: null,
            collapsed: false, count: 3, hasMore: false, totalRoots: 2,
            rows: [
                {id: 'p1', indentLevel: 0, childCount: 0},
                {id: 'p2', indentLevel: 0, childCount: 1, childShownCount: 1},
                {id: 'k7', parentConvId: 'p2', indentLevel: 1, childCount: 0},
            ],
        }])
        const {rerender} = render(<ConversationList/>)
        // p2 = 第二个根行（非激活、有子会话）→ 点一次 = 展开它的子列表
        fireEvent.click(document.querySelectorAll('[data-name="conversation-sidebar-item-row"]')[1])
        expect(document.querySelector('[data-name="child-list"]')).not.toBeNull()

        // 切进组视图：段集合换了一套（这正是"新子会话"误判与历史展开项残留的现场）
        useProjectGroupStore.setState({
            groups: [{
                id: 'g1', name: 'g1', sortOrder: 0, createdAt: 1, updatedAt: 1,
                members: [{projectPath: '/ws/a', groupOrder: 0}],
            }] as never,
        })
        convState.viewScope = {type: 'group', groupId: 'g1'}
        rerender(<ConversationList/>)

        // 改前红：展开集合既不随视图切换重置、又不清理历史项 → 切过去后子列表照旧挂着（一片乱开）
        expect(document.querySelector('[data-name="child-list"]')).toBeNull()
    })
})
