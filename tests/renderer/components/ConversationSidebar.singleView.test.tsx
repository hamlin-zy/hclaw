// @vitest-environment jsdom
/** 项目视图：无段头 + 入口行操作（spec §5.3 裁决 #1 / V8 / F11 / C3）
 *  mock 样板逐字复制 Task 2 的 ConversationSidebar.active.test.tsx（含 4 段 vi.mock）。 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, cleanup, fireEvent} from '@testing-library/react'

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
        collapsed: false, count: 1, hasMore: false, rows: [{id: 'c-a1', indentLevel: 0, childCount: 0}],
    }]),
    expandSection: vi.fn(), dismissWindowHint: vi.fn(), toggleSectionCollapsed: vi.fn(),
    expandChildParents: vi.fn(), focusProjectSegment: vi.fn(), clearFocusProject: vi.fn(),
    refreshVisibleBranches: vi.fn(async () => {}),
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

import {ConversationList, WorkspaceSelector} from '../../../src/renderer/components/ConversationSidebar'
import {useProjectGroupStore} from '../../../src/renderer/stores/projectGroupStore'

beforeEach(() => {
    vi.clearAllMocks()
    useProjectGroupStore.setState({groups: []})
    ;(window as any).electronAPI = {projectManager: {openProjectManager: vi.fn()}}
})
afterEach(cleanup)

describe('项目视图段头与操作入口', () => {
    it('项目视图不渲染段头，但段容器与 data-project-path 保留（C3）', () => {
        render(<ConversationList/>)
        expect(document.querySelector('[data-name="conversation-section-header"]')).toBeNull()
        expect(document.querySelector('[data-name="conversation-section"]')?.getAttribute('data-project-path')).toBe('/ws/a')
    })

    it('入口行右侧两枚项目级图标与入口按钮同级（不在按钮内部）', () => {
        render(<WorkspaceSelector/>)
        const entry = document.querySelector('[data-name="conversation-sidebar-workspace-select-button"]') as HTMLElement
        const pm = document.querySelector('[data-name="workspace-pm-button"]') as HTMLElement
        const nw = document.querySelector('[data-name="workspace-new-conversation"]') as HTMLElement
        expect(pm).not.toBeNull()
        expect(nw).not.toBeNull()
        expect(entry.contains(pm)).toBe(false)
        expect(entry.contains(nw)).toBe(false)
    })

    it('点入口行图标不开合抽屉（抽屉开关状态不变）', () => {
        render(<WorkspaceSelector/>)
        const nw = document.querySelector('[data-name="workspace-new-conversation"]') as HTMLElement
        const entry = document.querySelector('[data-name="conversation-sidebar-workspace-select-button"]') as HTMLElement
        // 初始抽屉关闭
        expect(entry.getAttribute('aria-expanded')).toBe('false')
        fireEvent.click(nw)
        // 抽屉开关状态不变：aria-expanded 仍为 false（新图标不接管抽屉开关）
        expect(entry.getAttribute('aria-expanded')).toBe('false')
    })

    it('组视图不渲染入口行两枚图标（操作由各成员段头承担）', () => {
        // 用 try/finally 还原 hoisted mock state（沿用 Task 3/4 的 getMockImplementation + finally 模式）
        const originalScope = convState.viewScope
        try {
            convState.viewScope = {type: 'group', groupId: 'pg-a'}
            render(<WorkspaceSelector/>)
            expect(document.querySelector('[data-name="workspace-pm-button"]')).toBeNull()
            expect(document.querySelector('[data-name="workspace-new-conversation"]')).toBeNull()
        } finally {
            convState.viewScope = originalScope
        }
    })
})
