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
// R-4：复位用例须断言真实 store（getState().recentHeight），mock 必须透传真实实现
vi.mock('../../../src/renderer/stores/sidebarStore', async () => {
    const actual = await vi.importActual<Record<string, unknown>>('../../../src/renderer/stores/sidebarStore')
    return {...actual}
})
vi.mock('../../../src/renderer/stores/themeStore', () => ({
    useThemeStore: {getState: () => ({theme: 'light'})},
}))
vi.mock('../../../src/renderer/services/newConversation', () => ({
    newConversation: vi.fn(async () => 'conv-new'),
}))

import {ConversationList} from '../../../src/renderer/components/ConversationSidebar'
import {useSidebarStore} from '../../../src/renderer/stores/sidebarStore'
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
afterEach(() => {
    cleanup()
    useSidebarStore.setState({recentHeight: null})
})

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
        // 徽章最大宽度 8ch（2026-09-24 由 6ch 加宽 2 个字符）：basename 常在 6 字符左右被截断
        expect(badges[0].className).toContain('max-w-[8ch]')
        expect(badges[0].className).toContain('truncate')
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

describe('最近会话区固定底部与控制条（§5.6 / V9）', () => {
    it('区块不在主滚动容器子树内，且 flex-shrink 为 0', () => {
        render(<ConversationList/>)
        const sec = document.querySelector('[data-name="sidebar-recent-section"]') as HTMLElement
        expect(sec.closest('[data-scroll-root]')).toBeNull()
        expect(sec.className).toContain('shrink-0')
        // findings Critical-1：容器 flex 列，让 .recent-list 以 flex 子项参与压缩，内部滚动才真实生效
        expect(sec.className).toContain('flex flex-col')
    })

    it('∧∧∧ 在标题右侧；∨∨/∧∧ 落在 .recent-list 内部末尾', () => {
        render(<ConversationList/>)   // 两个项目各 1 条 → 无页可翻
        const header = document.querySelector('[data-name="sidebar-recent-header"]') as HTMLElement
        expect(header.querySelector('[data-name="pager-reset"]')).not.toBeNull()
        const list = document.querySelector('.recent-list') as HTMLElement
        expect(list).not.toBeNull()
        // findings Critical-1：列表 flex-1 min-h-0（压缩前提）；handle/标题行 shrink-0 不被压缩
        expect(list.className).toContain('flex-1')
        expect(list.className).toContain('min-h-0')
        expect(header.className).toContain('shrink-0')
        const handle = document.querySelector('[data-name="recent-resize-handle"]') as HTMLElement
        expect(handle.className).toContain('shrink-0')
        expect(list.lastElementChild?.getAttribute('data-pager-key')).toBe('recent')
    })

    it('无页可翻时不渲染 ∨∨/∧∧（Review Focus 1）', () => {
        render(<ConversationList/>)
        const list = document.querySelector('.recent-list') as HTMLElement
        expect(list.querySelector('[data-name="pager-expand"]')).toBeNull()
        expect(list.querySelector('[data-name="pager-collapse"]')).toBeNull()
    })

    it('超过默认条数时 ∨∨ 可翻页：点击后多展示一页（判别力：截断真的跟着 recentCount 走）', () => {
        convState.workspaces = {
            '/ws/a': {lastOpenedAt: 1, conversations: Array.from({length: 6}, (_, i) => conv(`c-a${i}`, 100 + i))},
            '/ws/b': {lastOpenedAt: 2, conversations: Array.from({length: 5}, (_, i) => conv(`c-b${i}`, 200 + i))},
        }
        render(<ConversationList/>)
        expect(rows()).toHaveLength(10)   // RECENT_DEFAULT
        const expand = document.querySelector('.recent-list [data-name="pager-expand"]') as HTMLElement
        expect(expand).not.toBeNull()
        fireEvent.click(expand)
        expect(rows()).toHaveLength(11)
        // ★ only="reset" 的判别力：此时 count(20) > 默认(10)，若标题行没抑制，∧∧ 会冒进标题里
        const header = document.querySelector('[data-name="sidebar-recent-header"]') as HTMLElement
        expect(header.querySelector('[data-name="pager-reset"]')).not.toBeNull()
        expect(header.querySelector('[data-name="pager-collapse"]')).toBeNull()
        // 列表末尾仍留在列表内（翻页入口就发生在那里）
        expect(document.querySelector('.recent-list [data-name="pager-collapse"]')).not.toBeNull()
    })

    it('双击手柄复位为自然高度（setRecentHeight(null)，断言落在真实 store）', () => {
        render(<ConversationList/>)
        const handle = document.querySelector('[data-name="recent-resize-handle"]') as HTMLElement
        expect(handle).not.toBeNull()
        // 先置非空值证判别力：复位后必须回到 null
        useSidebarStore.getState().setRecentHeight(200)
        expect(useSidebarStore.getState().recentHeight).toBe(200)
        fireEvent.doubleClick(handle)
        expect(useSidebarStore.getState().recentHeight).toBeNull()
    })

    it('提交的拖拽高度会四舍五入入 store（setRecentHeight 契约）', () => {
        useSidebarStore.getState().setRecentHeight(199.4)
        expect(useSidebarStore.getState().recentHeight).toBe(199)
        useSidebarStore.getState().setRecentHeight(null)
        expect(useSidebarStore.getState().recentHeight).toBeNull()
    })

    it('.recent-list 含 overflow-y-auto（判别力：原为 overflow:hidden 裁切不可滚，改前类不存在）', () => {
        render(<ConversationList/>)
        const list = document.querySelector('.recent-list') as HTMLElement
        expect(list.className).toContain('overflow-y-auto')
        expect(list.className).toContain('min-h-0')
    })

    describe('拖动期实时钳上界（2026-09-24 收尾）', () => {
        /** jsdom 的 clientHeight 恒为 0 → 直接在**父容器实例**上打桩（不污染原型） */
        const stubBaseHeight = (h: number) => {
            const list = document.querySelector('[data-scroll-root]') as HTMLElement
            const base = list.parentElement as HTMLElement
            Object.defineProperty(base, 'clientHeight', {value: h, configurable: true})
            return base
        }

        it('向上拖很远：拖动中即钳到父容器一半（判别力：改前只钳下界，会得到远超 200 的高度）', () => {
            render(<ConversationList/>)
            const sec = document.querySelector('[data-name="sidebar-recent-section"]') as HTMLElement
            const handle = document.querySelector('[data-name="recent-resize-handle"]') as HTMLElement
            const base = stubBaseHeight(400)
            // 先证打桩生效：否则钳制分支不进（base ≤ 0 走防御退回），断言会假通
            expect(base.clientHeight).toBe(400)
            fireEvent.mouseDown(handle, {clientY: 300})
            fireEvent.mouseMove(window, {clientY: -2000}) // 原始高度 2300 → 钳到 400/2 = 200
            expect(sec.style.height).toBe('200px')
            fireEvent.mouseUp(window, {clientY: -2000}) // 收尾：摘掉 window 监听
        })

        it('基准为 0（未布局）时退回只钳下界（防御口径，与收敛 effect 同）', () => {
            render(<ConversationList/>)
            const sec = document.querySelector('[data-name="sidebar-recent-section"]') as HTMLElement
            const handle = document.querySelector('[data-name="recent-resize-handle"]') as HTMLElement
            fireEvent.mouseDown(handle, {clientY: 300})
            fireEvent.mouseMove(window, {clientY: -2000})
            expect(sec.style.height).toBe('2300px')
            fireEvent.mouseUp(window, {clientY: -2000})
        })
    })

    describe('高度收敛（spec §5.6：读取时按 clamp 收敛，Task 14 回炉）', () => {
        let clientH: number
        let roCb: ResizeObserverCallback | null = null
        class ROStub {
            constructor(cb: ResizeObserverCallback) { roCb = cb }
            observe() {}
            disconnect() { roCb = null }
        }
        beforeEach(() => {
            clientH = 800
            Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
                get: () => clientH, configurable: true,
            })
            ;(globalThis as any).ResizeObserver = ROStub
        })
        afterEach(() => {
            delete (globalThis as any).ResizeObserver
            delete (HTMLElement.prototype as any).clientHeight
            useSidebarStore.setState({recentHeight: null})
        })

        it('挂载时越界持久化值按主列表一半收敛落 store（判别力：改前渲染期钳制不落 store，终值仍 900）', () => {
            useSidebarStore.getState().setRecentHeight(900) // 800/2 = 400，越界
            render(<ConversationList/>)
            expect(useSidebarStore.getState().recentHeight).toBe(400)
        })

        it('ResizeObserver 触发（窗口缩小）时收敛，记录值不吃掉主列表一半以上', () => {
            useSidebarStore.getState().setRecentHeight(400) // clientH=800 下合法
            render(<ConversationList/>)
            expect(useSidebarStore.getState().recentHeight).toBe(400)
            clientH = 400 // 窗口缩小 → 上限变 200
            roCb!([] as any, {} as any)
            expect(useSidebarStore.getState().recentHeight).toBe(200)
        })

        it('合法值不产生收敛写（幂等：clamp 后与记录值相等则不调 setRecentHeight）', () => {
            useSidebarStore.getState().setRecentHeight(300)
            render(<ConversationList/>)
            expect(useSidebarStore.getState().recentHeight).toBe(300)
        })
    })
})
