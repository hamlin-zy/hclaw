// @vitest-environment jsdom
/** 段级分页控制条（spec §5.4 / F13 / F4 / F9 / F16）；mock 样板逐字复制 Task 2 的 active.test.tsx */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, cleanup, fireEvent} from '@testing-library/react'
import {resolve} from 'node:path'
import {readFileSync} from 'node:fs'

const convState = vi.hoisted(() => ({
    viewScope: {type: 'project', path: '/ws/a'} as any,
    currentWorkspacePath: '/ws/a' as string | null,
    activeConversationId: 'c-a1' as string | null,
    searchQuery: '', collapsedGroupIds: [] as string[], sectionWindowSizes: {} as Record<string, number>,
    singleViewWindowHintShown: false, gitBranches: {} as Record<string, string | null>, gitBranch: 'main',
    pendingFocusProject: null as string | null,
    workspaces: {'/ws/a': {lastOpenedAt: 1, conversations: [{id: 'c-a1', title: 'a1', preview: '', createdAt: 5, updatedAt: 5, status: 'active'}]}},
    getScopedSections: vi.fn((): any[] => [{
        key: '/ws/a', projectPath: '/ws/a', projectName: 'a', gitBranch: 'main',
        collapsed: false, count: 1, hasMore: false, totalRoots: 1,
        rows: [{id: 'c-a1', indentLevel: 0, childCount: 0}],
    }]),
    expandSection: vi.fn(), dismissWindowHint: vi.fn(), toggleSectionCollapsed: vi.fn(),
    setSectionWindowSize: vi.fn(),
    expandChildParents: vi.fn(),
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

describe('段级分页控制条', () => {
    const manyConvs = (n: number) => Array.from({length: n}, (_, i) => ({
        id: `c${i}`, title: `c${i}`, preview: '', createdAt: 1000 - i, updatedAt: 1000 - i, status: 'active',
    }))

    it('默认 6 条窗口：末尾渲染 ∨∨ 与置灰 ∧∧∧，且不再有「加载更多」', () => {
        const list = manyConvs(20)
        convState.workspaces['/ws/a'].conversations = list
        convState.getScopedSections.mockReturnValue([{
            key: '/ws/a', projectPath: '/ws/a', projectName: 'a', gitBranch: null,
            collapsed: false, count: 20, hasMore: true, totalRoots: 20,
            rows: list.slice(0, 6).map(c => ({id: c.id, indentLevel: 0, childCount: 0})),
        }])
        try {
            render(<ConversationList/>)
            expect(document.querySelector('[data-name="section-show-more"]')).toBeNull()
            const bar = document.querySelector('[data-name="pager-bar"][data-pager-key="section"]') as HTMLElement
            expect(bar).not.toBeNull()
            expect((bar.querySelector('[data-name="pager-expand"]') as HTMLButtonElement).disabled).toBe(false)
            expect((bar.querySelector('[data-name="pager-reset"]') as HTMLButtonElement).disabled).toBe(true)
            expect(bar.querySelector('[data-name="pager-collapse"]')).toBeNull()
        } finally {
            convState.workspaces['/ws/a'].conversations = [{id: 'c-a1', title: 'a1', preview: '', createdAt: 5, updatedAt: 5, status: 'active'}]
        }
    })

    it('段级控制条左对齐父会话图标左缘 + 底部负 margin = -按钮高度（2026-09-24 用户反馈）', () => {
        const list = manyConvs(20)
        const originalConvs = convState.workspaces['/ws/a'].conversations
        const originalSections = convState.getScopedSections.getMockImplementation()
        convState.workspaces['/ws/a'].conversations = list
        convState.getScopedSections.mockReturnValue([{
            key: '/ws/a', projectPath: '/ws/a', projectName: 'a', gitBranch: null,
            collapsed: false, count: 20, hasMore: true, totalRoots: 20,
            rows: list.slice(0, 6).map(c => ({id: c.id, indentLevel: 0, childCount: 0})),
        }])
        try {
            render(<ConversationList/>)
            const bar = document.querySelector('[data-name="pager-bar"][data-pager-key="section"]') as HTMLElement
            expect(bar).not.toBeNull()
            // ① 不再居中：改左对齐（原默认 justify-center 悬在段中间，与上面父会话行没关系）
            expect(bar.className).toContain('justify-start')
            expect(bar.className).not.toContain('justify-center')
            // ② 与父会话图标左缘对齐：行盒 mx-2(8) + px-2(8) = 16px（相对列表容器的 16px 内边距）
            expect(bar.className).toContain('pl-4')
            // ③ 段间距本就宽裕 → 用 -按钮高度 抵消控制条自身高度，行间不再被顶出一截
            expect(bar.className).toContain('-mb-[16px]')
        } finally {
            convState.workspaces['/ws/a'].conversations = originalConvs
            if (originalSections) convState.getScopedSections.mockImplementation(originalSections)
        }
    })

    it('点 ∨∨ 调 setSectionWindowSize(key, 16)（6 + 步长 10）', () => {
        const list = manyConvs(20)
        const originalConvs = convState.workspaces['/ws/a'].conversations
        const originalSections = convState.getScopedSections.getMockImplementation()
        convState.workspaces['/ws/a'].conversations = list
        convState.getScopedSections.mockReturnValue([{
            key: '/ws/a', projectPath: '/ws/a', projectName: 'a', gitBranch: null,
            collapsed: false, count: 20, hasMore: true, totalRoots: 20,
            rows: list.slice(0, 6).map(c => ({id: c.id, indentLevel: 0, childCount: 0})),
        }])
        try {
            render(<ConversationList/>)
            fireEvent.click(document.querySelector('[data-name="pager-expand"]')!)
            expect(convState.setSectionWindowSize).toHaveBeenCalledWith('/ws/a', 16)
        } finally {
            convState.workspaces['/ws/a'].conversations = originalConvs
            if (originalSections) convState.getScopedSections.mockImplementation(originalSections)
        }
    })

    it('搜索态不渲染三枚控制条（A4）', () => {
        const originalSearch = convState.searchQuery
        convState.searchQuery = 'c1'
        try {
            render(<ConversationList/>)
            expect(document.querySelector('[data-name="pager-bar"]')).toBeNull()
        } finally {
            convState.searchQuery = originalSearch
        }
    })

    it('无页可翻的段（totalRoots ≤ 默认 6）：整条段级控制条不渲染（2026-09-24 收尾新口径）', () => {
        const originalSections = convState.getScopedSections.getMockImplementation()
        convState.getScopedSections.mockReturnValue([{
            key: '/ws/a', projectPath: '/ws/a', projectName: 'a', gitBranch: null,
            collapsed: false, count: 2, hasMore: false, totalRoots: 2,
            rows: [{id: 'c-a1', indentLevel: 0, childCount: 0}, {id: 'c-a2', indentLevel: 0, childCount: 0}],
        }])
        try {
            render(<ConversationList/>)
            // 新口径：段内无页可翻 → 整条控制条（含 ∧∧∧）都不渲染，不再挂永不可点的复位图标。
            // 旧口径（Review Focus 1）为「渲染条 + ∧∧ 置灰」，此处断言由「条内按钮状态」升级为「条不存在」。
            expect(document.querySelector('[data-name="pager-bar"][data-pager-key="section"]')).toBeNull()
        } finally {
            if (originalSections) convState.getScopedSections.mockImplementation(originalSections)
        }
    })
})
