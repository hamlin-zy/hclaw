// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, act} from '@testing-library/react'

const section = (over: Partial<any> = {}) => ({
    key: '/ws/a', projectPath: '/ws/a', projectName: 'a', gitBranch: 'main',
    collapsed: false, count: 3, hasMore: false,
    rows: [{id: 'c-1', indentLevel: 0, childCount: 0}], ...over,
})

const convState = vi.hoisted(() => ({
    // viewScope 两种形态（组 / 项目）都要能赋值：放宽为结构类型
    viewScope: {type: 'group', groupId: 'pg-a'} as {type: string; groupId?: string; path?: string} | null,
    currentWorkspacePath: '/ws/a' as string | null,
    activeConversationId: 'c-1' as string | null,
    searchQuery: '',
    collapsedGroupIds: [] as string[],
    sectionWindowSizes: {} as Record<string, number>,
    singleViewWindowHintShown: false,
    gitBranches: {} as Record<string, string | null>,
    gitBranch: 'main' as string | null,
    pendingFocusProject: null as string | null,
    workspaces: {'/ws/a': {lastOpenedAt: 1, conversations: []}} as Record<string, {lastOpenedAt: number; conversations: any[]}>,
    getScopedSections: vi.fn(() => [section()]),
    expandSection: vi.fn(),
    dismissWindowHint: vi.fn(),
    toggleSectionCollapsed: vi.fn(),
    focusProjectSegment: vi.fn(),
    clearFocusProject: vi.fn(),
    refreshVisibleBranches: vi.fn(async () => {}),
    setSearchQuery: vi.fn(),
    setProjectGroupView: vi.fn(),
    preloadConversation: vi.fn(async () => {}),
}))
vi.mock('../../../src/renderer/stores/conversationStore', () => ({
    useConversationStore: Object.assign(
        (sel: (s: typeof convState) => unknown) => sel(convState),
        {getState: () => convState},
    ),
}))
vi.mock('../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: (sel: (s: unknown) => unknown) => sel({convAgentStates: {}}),
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
import {newConversation} from '../../../src/renderer/services/newConversation'
import {useProjectGroupStore} from '../../../src/renderer/stores/projectGroupStore'

beforeEach(() => {
    vi.clearAllMocks()
    useProjectGroupStore.setState({groups: []})
    convState.getScopedSections.mockReturnValue([section()])
    convState.viewScope = {type: 'group', groupId: 'pg-a'}
    convState.currentWorkspacePath = '/ws/a'
    convState.activeConversationId = 'c-1'
    convState.collapsedGroupIds = []
    convState.gitBranch = 'main'
    convState.pendingFocusProject = null
    convState.singleViewWindowHintShown = false
    convState.workspaces = {'/ws/a': {lastOpenedAt: 1, conversations: []}}
    ;(window as any).electronAPI = {projectManager: {openProjectManager: vi.fn()}}
})

describe('ConversationList — 段头三操作分工（A 变体）', () => {
    it('chevron 点击 = toggleSectionCollapsed（不是切视图）', () => {
        render(<ConversationList/>)
        fireEvent.click(document.querySelector('[data-name="section-collapse-toggle"]') as HTMLElement)
        expect(convState.toggleSectionCollapsed).toHaveBeenCalledWith('/ws/a')
        expect(convState.setProjectGroupView).not.toHaveBeenCalled()
    })

    it('项目名单击 = toggleSectionCollapsed（与 chevron 同口径，不切视图）', () => {
        render(<ConversationList/>)
        fireEvent.click(document.querySelector('[data-name="section-project-name"]') as HTMLElement)
        expect(convState.toggleSectionCollapsed).toHaveBeenCalledWith('/ws/a')
        expect(convState.setProjectGroupView).not.toHaveBeenCalled()
    })

    it('文件夹图标 = 打开项目管理窗口（带项目路径）', () => {
        render(<ConversationList/>)
        fireEvent.click(document.querySelector('[data-name="section-pm-button"]') as HTMLElement)
        expect((window as any).electronAPI.projectManager.openProjectManager).toHaveBeenCalledWith('/ws/a')
    })

    it('「+」= 在该项目新建会话', () => {
        render(<ConversationList/>)
        fireEvent.click(document.querySelector('[data-name="section-new-conversation"]') as HTMLElement)
        expect(newConversation).toHaveBeenCalledWith({workspacePath: '/ws/a', stayInScope: true})
    })

    it('分支徽章带 title（hover 显示全分支名）', () => {
        convState.getScopedSections.mockReturnValue([section({gitBranch: 'feat/project-group-management'})])
        render(<ConversationList/>)
        expect(
            document.querySelector('[data-name="section-branch-badge"]')?.getAttribute('title'),
        ).toBe('feat/project-group-management')
    })

    it('项目名带 title（完整路径）且作为唯一弹性收缩项（不挤出右侧按钮）', () => {
        render(<ConversationList/>)
        const name = document.querySelector('[data-name="section-project-name"]') as HTMLElement
        expect(name.getAttribute('title')).toBe('/ws/a')
        expect(name.className).toContain('min-w-0')
        expect(name.className).toContain('truncate')
    })
})

describe('ConversationList — 折叠语义', () => {
    it('折叠态显示「N 条」，展开态不显示', () => {
        render(<ConversationList/>)
        expect(document.querySelector('[data-name="section-count"]')).toBeNull()
        convState.getScopedSections.mockReturnValue([section({collapsed: true, count: 7, rows: []})])
        const {unmount} = render(<ConversationList/>)
        expect(document.querySelector('[data-name="section-count"]')?.textContent).toContain('7 条')
        unmount()
    })

    it('单项目视图：无 chevron、无「+」（新建仍用顶部大按钮）', () => {
        convState.viewScope = {type: 'project', path: '/ws/a'}
        render(<ConversationList/>)
        expect(document.querySelector('[data-name="section-collapse-toggle"]')).toBeNull()
        expect(document.querySelector('[data-name="section-new-conversation"]')).toBeNull()
        expect(document.querySelector('[data-name="section-pm-button"]')).toBeTruthy()
    })
})

describe('ConversationList — 空态（§7.6 / §3.2）', () => {
    it('无项目 → 「选择项目或项目组」', () => {
        convState.getScopedSections.mockReturnValue([])
        convState.currentWorkspacePath = null
        render(<ConversationList/>)
        expect(screen.getByText('选择项目或项目组')).toBeTruthy()
    })

    it('项目无会话 → 「暂无会话」', () => {
        convState.getScopedSections.mockReturnValue([section({rows: [], count: 0})])
        render(<ConversationList/>)
        expect(screen.getByText('暂无会话')).toBeTruthy()
    })
})

describe('ConversationList — 段头分支徽章来源（I-1）', () => {
    it('挂载时调用 refreshVisibleBranches 一次（批量填充 gitBranches）', () => {
        render(<ConversationList/>)
        expect(convState.refreshVisibleBranches).toHaveBeenCalledTimes(1)
    })

    it('段集合（项目路径签名）变化时再次刷新分支', () => {
        const {rerender} = render(<ConversationList/>)
        expect(convState.refreshVisibleBranches).toHaveBeenCalledTimes(1)

        convState.workspaces = {
            '/ws/a': {lastOpenedAt: 1, conversations: []},
            '/ws/b': {lastOpenedAt: 2, conversations: []},
        }
        convState.getScopedSections.mockReturnValue([
            section(),
            section({key: '/ws/b', projectPath: '/ws/b', projectName: 'b'}),
        ])
        rerender(<ConversationList/>)
        expect(convState.refreshVisibleBranches).toHaveBeenCalledTimes(2)
    })

    it('gitBranch 变化 → 段头徽章随之更新（sections memo deps 覆盖 gitBranch）', () => {
        convState.getScopedSections.mockImplementation(() => [section({gitBranch: convState.gitBranch})])
        const {rerender} = render(<ConversationList/>)
        expect(
            document.querySelector('[data-name="section-branch-badge"]')?.getAttribute('title'),
        ).toBe('main')

        convState.gitBranch = 'feat/project-group-management'
        rerender(<ConversationList/>)
        expect(
            document.querySelector('[data-name="section-branch-badge"]')?.getAttribute('title'),
        ).toBe('feat/project-group-management')
    })
})

describe('ConversationList — 组数据变化驱动重算（I-2）', () => {
    it('projectGroupStore.groups 变化（抽屉拖入/拖出/解散/调序）→ sections 重算，段集合随之变化', async () => {
        convState.viewScope = {type: 'group', groupId: 'pg-a'}
        convState.getScopedSections.mockImplementation(() => [section()])
        render(<ConversationList/>)
        expect(document.querySelectorAll('[data-name="section-project-name"]')).toHaveLength(1)

        // 抽屉里把 /ws/b 拖入本组 → groups 变了（段集合应随之变化）。
        // 若 memo deps 缺 groups，下面这次 store 更新不会触发 sections 重算 → 仍是 1 段。
        convState.getScopedSections.mockImplementation(() => [
            section(),
            section({key: '/ws/b', projectPath: '/ws/b', projectName: 'b'}),
        ])
        await act(async () => {
            useProjectGroupStore.setState({groups: [
                {id: 'pg-a', name: '组A', sortOrder: 0, createdAt: 1, updatedAt: 1,
                 members: [{projectPath: '/ws/a', groupOrder: 0}, {projectPath: '/ws/b', groupOrder: 1}]},
            ] as any})
        })

        expect(document.querySelectorAll('[data-name="section-project-name"]')).toHaveLength(2)
    })
})

describe('ConversationList — 折叠→展开不误触发自动展开（I-2）', () => {
    const parentConv = {id: 'p-1', title: '父会话', createdAt: 2, updatedAt: 2, preview: '', pinned: false}
    const childConv = {id: 'k-1', title: '子会话', parentConvId: 'p-1', createdAt: 1, updatedAt: 1, preview: '', pinned: false}
    const expandedSection = () => section({
        rows: [
            {id: 'p-1', indentLevel: 0, childCount: 1},
            {id: 'k-1', parentConvId: 'p-1', indentLevel: 1, childCount: 0},
        ],
        count: 1,
    })

    it('折叠再展开后，段内带子会话的父会话不被自动展开', () => {
        // ★ 项目 scope：本用例断言「段内 DOM 无子会话」。组视图下侧栏新增「最近会话」
        //   跨项目区块（spec §16.7）会把同一批会话再渲染一遍（按 id 去重前），与
        //   getByText/getByText('子会话') 的"全文档唯一"断言冲突。子会话自动展开
        //   逻辑与 scope 无关，用项目 scope 隔离即可（回归意图不变）。
        convState.viewScope = {type: 'project', path: '/ws/a'}
        convState.activeConversationId = null
        convState.workspaces = {'/ws/a': {lastOpenedAt: 1, conversations: [parentConv, childConv]}}
        convState.getScopedSections.mockReturnValue([expandedSection()])
        const {rerender} = render(<ConversationList/>)
        // 基线：父会话渲染、子会话折叠（父未被展开）
        expect(screen.getByText('父会话')).toBeTruthy()
        expect(screen.queryByText('子会话')).toBeNull()

        // 折叠（rows 塌缩为 []）→ 展开集合被清 → 展开回来
        convState.collapsedGroupIds = ['/ws/a']
        convState.getScopedSections.mockReturnValue([section({collapsed: true, count: 1, rows: []})])
        rerender(<ConversationList/>)

        convState.collapsedGroupIds = []
        convState.getScopedSections.mockReturnValue([expandedSection()])
        rerender(<ConversationList/>)

        // 若把「折叠后重新出现的父会话」误判为新子会话，父会被自动展开 → 子会话可见
        expect(screen.getByText('父会话')).toBeTruthy()
        expect(screen.queryByText('子会话')).toBeNull()
    })
})

describe('ConversationList — 定位该项目段（I-4）', () => {
    it('目标段尚不存在时不复位；段出现后定位并复位', () => {
        convState.pendingFocusProject = '/ws/b'
        const {rerender} = render(<ConversationList/>)
        expect(convState.clearFocusProject).not.toHaveBeenCalled()

        convState.workspaces = {
            '/ws/a': {lastOpenedAt: 1, conversations: []},
            '/ws/b': {lastOpenedAt: 2, conversations: []},
        }
        convState.getScopedSections.mockReturnValue([
            section(),
            section({key: '/ws/b', projectPath: '/ws/b', projectName: 'b'}),
        ])
        rerender(<ConversationList/>)
        expect(convState.clearFocusProject).toHaveBeenCalledTimes(1)
    })

    it('目标段已在段集合内时立即定位并复位', () => {
        convState.pendingFocusProject = '/ws/a'
        render(<ConversationList/>)
        expect(convState.clearFocusProject).toHaveBeenCalledTimes(1)
    })
})

describe('ConversationList — 单项目视图窗口化一次性提示（§15.1⑤ / §13-2）', () => {
    it('单项目视图 + hasMore + 未提示过 → 显示一次性提示', () => {
        convState.viewScope = {type: 'project', path: '/ws/a'}
        convState.singleViewWindowHintShown = false
        convState.getScopedSections.mockReturnValue([section({hasMore: true})])
        render(<ConversationList/>)
        expect(screen.getByText(/点 ··· 可加载更多会话/)).toBeTruthy()
    })

    it('已提示过 → 不再显示', () => {
        convState.viewScope = {type: 'project', path: '/ws/a'}
        convState.singleViewWindowHintShown = true
        convState.getScopedSections.mockReturnValue([section({hasMore: true})])
        render(<ConversationList/>)
        expect(screen.queryByText(/点 ··· 可加载更多会话/)).toBeNull()
    })

    it('组视图不显示该提示（组视图每段本来就有 ···）', () => {
        convState.viewScope = {type: 'group', groupId: 'pg-a'}
        convState.singleViewWindowHintShown = false
        convState.getScopedSections.mockReturnValue([section({hasMore: true})])
        render(<ConversationList/>)
        expect(screen.queryByText(/点 ··· 可加载更多会话/)).toBeNull()
    })

    it('单项目视图点击「···」既展开段也置位已读（提示无独立关闭控件）', () => {
        convState.viewScope = {type: 'project', path: '/ws/a'}
        convState.singleViewWindowHintShown = false
        convState.getScopedSections.mockReturnValue([section({hasMore: true})])
        render(<ConversationList/>)
        fireEvent.click(document.querySelector('[data-name="section-show-more"]') as HTMLElement)
        expect(convState.expandSection).toHaveBeenCalledWith('/ws/a')
        expect(convState.dismissWindowHint).toHaveBeenCalledTimes(1)
    })

    it('组视图点击「···」只展开段，不置位全局一次性标记（不提前吃掉提示）', () => {
        convState.viewScope = {type: 'group', groupId: 'pg-a'}
        convState.singleViewWindowHintShown = false
        convState.getScopedSections.mockReturnValue([section({hasMore: true})])
        render(<ConversationList/>)
        fireEvent.click(document.querySelector('[data-name="section-show-more"]') as HTMLElement)
        expect(convState.expandSection).toHaveBeenCalledWith('/ws/a')
        expect(convState.dismissWindowHint).not.toHaveBeenCalled()
        expect(convState.singleViewWindowHintShown).toBe(false)
    })
})

describe('ConversationItem — hover 预热（§10.2-1：组视图禁用）', () => {
    const rowConv = {id: 'c-1', title: 't1', preview: '', createdAt: 1, updatedAt: 1}

    beforeEach(() => {
        // 行渲染要求会话摘要能在 workspaces 段内查到
        convState.workspaces = {'/ws/a': {lastOpenedAt: 1, conversations: [rowConv]}}
    })
    afterEach(() => vi.useRealTimers())

    function hoverRow() {
        const row = document.querySelector('[data-name="conversation-sidebar-item-row"]') as HTMLElement
        expect(row).toBeTruthy()
        fireEvent.mouseEnter(row)
        vi.advanceTimersByTime(400) // 超过 300ms 延迟
    }

    it('组视图：hover 不触发 preloadConversation（避免键数随项目数线性增长）', () => {
        vi.useFakeTimers()
        convState.viewScope = {type: 'group', groupId: 'pg-a'}
        render(<ConversationList/>)
        hoverRow()
        expect(convState.preloadConversation).not.toHaveBeenCalled()
    })

    it('单项目视图：hover 300ms 后触发 preloadConversation（回归：行为不变）', () => {
        vi.useFakeTimers()
        convState.viewScope = {type: 'project', path: '/ws/a'}
        render(<ConversationList/>)
        hoverRow()
        expect(convState.preloadConversation).toHaveBeenCalledWith('c-1')
    })
})
