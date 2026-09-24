// @vitest-environment jsdom
/**
 * 置顶的行尾角标（spec §5.1 / V2）
 *
 * mock 口径来源：ConversationSidebar.recent.test.tsx / ConversationSidebar.active.test.tsx。
 * 本文件顶部的 4 段 vi.mock 与 convState / agentState 声明逐字复制自
 * ConversationSidebar.active.test.tsx（刻意不抽共享 helper：各测试文件自洽，
 * 改口径时须三处同动）。
 *
 * 覆盖：置顶行在行尾渲染 10px 图钉角标（不参与点击）、非置顶行不渲染该角标。
 * 置顶字段的唯一来源见下方注释（renderSectionRows 按 id 从段内会话摘要取）。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, cleanup} from '@testing-library/react'

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
    // 既有 mock 遗漏的 store action：激活会话被子会话窗口截掉时（rowById 查不到）组件会调用它
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

/**
 * 渲染一行会话行并取角标。
 * 说明：`pinned` 的唯一来源是 `workspaces[段路径].conversations[]` 里的会话摘要
 * （renderSectionRows 用行 id 去该数组查摘要，再把 `conv.pinned` 传给 ConversationItem）；
 * 段 rows 本身只带 {id, parentConvId, indentLevel, childCount}，不带 pinned。
 */
function renderRow(pinned: boolean) {
    const originalSections = convState.getScopedSections.getMockImplementation()
    const originalWorkspaces = convState.workspaces
    try {
        convState.workspaces = {
            '/ws/a': {
                lastOpenedAt: 1,
                conversations: [{id: 'c-a1', title: 'a1', preview: '', createdAt: 5, updatedAt: 5, status: 'active', pinned}],
            },
        } as any
        render(<ConversationList/>)
        return document.querySelector('[data-name="row-pin-badge"]') as HTMLElement | null
    } finally {
        if (originalSections) convState.getScopedSections.mockImplementation(originalSections)
        convState.workspaces = originalWorkspaces
    }
}

describe('置顶行尾角标（V2）', () => {
    it('置顶行在行尾渲染 10px 图钉角标，且角标不参与点击', () => {
        const badge = renderRow(true)
        expect(badge).not.toBeNull()
        expect(badge!.className).toContain('pointer-events-none')
        expect(badge!.getAttribute('aria-hidden')).toBe('true')
        const svg = badge!.querySelector('svg')
        expect(svg).not.toBeNull()
        expect(svg!.getAttribute('width')).toBe('10')
        expect(svg!.getAttribute('height')).toBe('10')
        // 落点 = 行尾：角标排在标题之后（移到图标容器那种「行首」位置会立刻变红）
        const title = document.querySelector('[data-name="conversation-sidebar-item-title"]') as HTMLElement
        expect(title).not.toBeNull()
        expect(title.compareDocumentPosition(badge!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
        // 角标归属该会话行，且该行只渲染一个
        expect(badge!.closest('[data-name="conversation-sidebar-item-row"]')).not.toBeNull()
        expect(document.querySelectorAll('[data-name="row-pin-badge"]').length).toBe(1)
    })

    // 反向断言（判别力）：角标必须由置顶态门控。恒渲染的实现（去掉 {pinned && ...} 条件）会让上一条
    // 断言照样变绿，只有本用例能把那种实现判红。
    it('非置顶行不渲染角标', () => {
        expect(renderRow(false)).toBeNull()
    })
})
