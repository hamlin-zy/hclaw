// @vitest-environment jsdom
/**
 * 会话列表「完成」徽章渲染门禁（spec: 后台会话 done 后补一个「已完成未读」信号）
 *
 * 覆盖：
 * 1. doneUnreadIds 命中 → 行内渲染「完成」徽章（success 徽章，静态不脉冲）
 * 2. 无标记 → 不渲染
 * 3. 同会话仍有 pendingQuestion（待确认）→ 只渲染「待确认」，不与「完成」堆叠
 * 4. 激活该会话 → 标记被清除（render 侧兜底；主路径在 switchActiveConversation）
 *
 * mock 口径复刻 ConversationSidebar.recent.test.tsx。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, cleanup} from '@testing-library/react'

const sec = (over: Partial<any> = {}) => ({
    key: '/ws/a', projectPath: '/ws/a', projectName: 'a', gitBranch: 'main',
    collapsed: false, count: 1, hasMore: false,
    rows: [{id: 'c-a1', indentLevel: 0, childCount: 0}], ...over,
})

const convState = vi.hoisted(() => ({
    viewScope: {type: 'project', path: '/ws/a'} as {type: string; groupId?: string; path?: string} | null,
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
vi.mock('../../../src/renderer/stores/sidebarStore', async () => {
    // 透传真实 store：组件直接消费 useSidebarStore hook（Task 14 起），整体 mock 会落空
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
import {useProjectGroupStore} from '../../../src/renderer/stores/projectGroupStore'

const conv = (id: string, over: Record<string, unknown> = {}) => ({
    id, title: id, preview: '', createdAt: 0, updatedAt: 100, status: 'active', ...over,
})

beforeEach(() => {
    vi.clearAllMocks()
    useProjectGroupStore.setState({groups: []})
    convState.viewScope = {type: 'project', path: '/ws/a'}
    convState.activeConversationId = null
    agentState.convAgentStates = {}
    agentState.doneUnreadIds = {}
    convState.getScopedSections.mockReturnValue([sec()])
    convState.workspaces = {'/ws/a': {lastOpenedAt: 1, conversations: [conv('c-a1')]}}
    ;(window as any).electronAPI = {projectManager: {openProjectManager: vi.fn()}}
})
afterEach(cleanup)

const rows = () => Array.from(document.querySelectorAll('[data-name="conversation-sidebar-item-row"]'))

describe('会话行「完成」徽章', () => {
    it('doneUnreadIds 命中：渲染「完成」徽章，且为静态 success 徽章（不脉冲）', () => {
        agentState.doneUnreadIds = {'c-a1': 1}
        render(<ConversationList/>)
        const badge = Array.from(rows()[0].querySelectorAll('span')).find(s => s.textContent === '完成')
        expect(badge).toBeTruthy()
        // 「完成」不与三种阻塞态徽章同级：静态、不脉冲
        expect(badge!.className).not.toContain('animate-badge-pulse')
    })

    it('无标记：不渲染「完成」', () => {
        render(<ConversationList/>)
        expect(rows()[0].textContent).not.toContain('完成')
    })

    it('同会话仍有待确认：只渲染「待确认」，不与「完成」堆叠', () => {
        agentState.doneUnreadIds = {'c-a1': 1}
        agentState.convAgentStates = {'c-a1': {pendingQuestion: {question: 'q'}}}
        render(<ConversationList/>)
        expect(rows()[0].textContent).toContain('待确认')
        expect(rows()[0].textContent).not.toContain('完成')
    })

    it('该会话被激活：标记被清除（render 侧兜底）', () => {
        agentState.doneUnreadIds = {'c-a1': 1}
        convState.activeConversationId = 'c-a1'
        render(<ConversationList/>)
        expect(agentState.clearConvDoneUnread).toHaveBeenCalledWith('c-a1')
    })

    it('非激活会话不触发清除', () => {
        convState.activeConversationId = 'c-other'
        render(<ConversationList/>)
        expect(agentState.clearConvDoneUnread).not.toHaveBeenCalled()
    })

    // 口径 6：定时任务会话不亮「完成」。源侧置位时已按摘要排除 schedule，但那一刻若
    // 所属项目段未加载则摘要查不到、源侧放行 —— 渲染侧按 conv.channel 兜底。
    it('schedule 会话即使命中标记也不渲染「完成」', () => {
        agentState.doneUnreadIds = {'c-a1': 1}
        convState.workspaces = {'/ws/a': {lastOpenedAt: 1, conversations: [conv('c-a1', {channel: 'schedule'})]}}
        render(<ConversationList/>)
        expect(rows()[0].textContent).not.toContain('完成')
    })

    it('非 schedule 会话命中标记仍渲染「完成」（反向：门禁不误伤）', () => {
        agentState.doneUnreadIds = {'c-a1': 1}
        convState.workspaces = {'/ws/a': {lastOpenedAt: 1, conversations: [conv('c-a1', {channel: 'cli'})]}}
        render(<ConversationList/>)
        expect(rows()[0].textContent).toContain('完成')
    })
})

describe('StatusBadge 三态脉冲类回归（M1）', () => {
    const badgeOf = (text: string) =>
        Array.from(rows()[0].querySelectorAll('span')).find(s => s.textContent === text)

    it('待确认（pendingQuestion）→ animate-badge-pulse（error 态脉冲）', () => {
        agentState.convAgentStates = {'c-a1': {pendingQuestion: {question: 'q'}}}
        render(<ConversationList/>)
        const badge = badgeOf('待确认')
        expect(badge).toBeTruthy()
        expect(badge!.className).toContain('animate-badge-pulse')
        // 反向：不是 warning 变体的脉冲类（'animate-badge-pulse' 是后者的前缀，须显式排除）
        expect(badge!.className).not.toContain('animate-badge-pulse-warning')
    })

    it('权限确认（pendingPermissionConfirm）→ animate-badge-pulse-warning', () => {
        agentState.convAgentStates = {'c-a1': {pendingPermissionConfirm: {toolName: 'bash'}}}
        render(<ConversationList/>)
        const badge = badgeOf('权限确认')
        expect(badge).toBeTruthy()
        expect(badge!.className).toContain('animate-badge-pulse-warning')
    })

    it('工具确认（pendingToolsChangeConfirm）→ animate-badge-pulse-warning', () => {
        agentState.convAgentStates = {'c-a1': {pendingToolsChangeConfirm: {addedTools: []}}}
        render(<ConversationList/>)
        const badge = badgeOf('工具确认')
        expect(badge).toBeTruthy()
        expect(badge!.className).toContain('animate-badge-pulse-warning')
    })

    it('完成（success）→ 两种脉冲类都不含（静态徽章：完成不紧急）', () => {
        agentState.doneUnreadIds = {'c-a1': 1}
        render(<ConversationList/>)
        const badge = badgeOf('完成')
        expect(badge).toBeTruthy()
        expect(badge!.className).not.toContain('animate-badge-pulse')
        expect(badge!.className).not.toContain('animate-badge-pulse-warning')
    })

    // 配色回归：白字 + 纯 var(--success) 四主题实测仅 2.54~2.90:1，须保持混黑加深的配方。
    // 见 demo/done-badge-variants.html 的四主题对比度实测表。
    it('完成（success）底色须为混黑加深配方，不得退回纯 var(--success)', () => {
        agentState.doneUnreadIds = {'c-a1': 1}
        render(<ConversationList/>)
        const style = badgeOf('完成')!.getAttribute('style') ?? ''
        expect(style).toContain('--success')
        expect(style).toMatch(/62%/)
        expect(style).not.toBe('background-color: var(--success);')
    })

    // 反向：既有两态不动（本次只改 success 分支）
    it('待确认 / 权限确认 底色仍为语义色原值', () => {
        agentState.convAgentStates = {'c-a1': {pendingQuestion: {question: 'q'}}}
        render(<ConversationList/>)
        expect(badgeOf('待确认')!.getAttribute('style')).toContain('var(--error)')
        cleanup()
        agentState.convAgentStates = {}
        agentState.convAgentStates = {'c-a1': {pendingPermissionConfirm: {toolName: 'bash'}}}
        render(<ConversationList/>)
        expect(badgeOf('权限确认')!.getAttribute('style')).toContain('var(--warning)')
    })
})
