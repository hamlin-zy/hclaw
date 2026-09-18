// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {render, fireEvent} from '@testing-library/react'
import fs from 'fs'
import path from 'path'

const openPM = vi.fn()
const convState = {
    viewScope: {type: 'project', path: '/ws/proj'} as any,
    currentWorkspacePath: '/ws/proj',
    activeConversationId: null,
    searchQuery: '',
    collapsedGroupIds: [],
    pendingFocusProject: null,
    sectionWindowSizes: {},
    singleViewWindowHintShown: true,
    gitBranches: {},
    workspaces: {'/ws/proj': {lastOpenedAt: 1, conversations: []}},
    getScopedSections: () => [{
        key: '/ws/proj', projectPath: '/ws/proj', projectName: 'proj', gitBranch: null,
        collapsed: false, count: 0, hasMore: false, rows: [],
    }],
    expandSection: () => {}, toggleSectionCollapsed: () => {}, focusProjectSegment: () => {},
    clearFocusProject: () => {}, setSearchQuery: () => {}, setProjectGroupView: () => {},
    dismissWindowHint: () => {},
    refreshVisibleBranches: vi.fn(async () => {}),
    getFilteredConversations: () => [],
}
vi.mock('../../../src/renderer/stores/conversationStore', () => ({
    useConversationStore: Object.assign((sel: (s: unknown) => unknown) => sel(convState), {getState: () => convState}),
}))
vi.mock('../../../src/renderer/stores/agentStore', () => ({useAgentStore: (sel: (s: unknown) => unknown) => sel({convAgentStates: {}})}))
vi.mock('../../../src/renderer/stores/sidebarStore', () => ({useSidebarStore: {getState: () => ({leftCollapsed: false})}}))
vi.mock('../../../src/renderer/stores/themeStore', () => ({useThemeStore: {getState: () => ({theme: 'light'})}}))

import {ConversationList} from '../../../src/renderer/components/ConversationSidebar'
import * as Sidebar from '../../../src/renderer/components/ConversationSidebar'

const SIDEBAR_TSX = path.resolve(process.cwd(), 'src/renderer/components/ConversationSidebar.tsx')

beforeEach(() => {
    vi.clearAllMocks()
    ;(window as any).electronAPI = {projectManager: {openProjectManager: openPM}}
})

describe('段头文件夹图标 = PM 入口（D15：顶部原按钮已移除）', () => {
    it('点击用项目路径调 openProjectManager', () => {
        render(<ConversationList/>)
        fireEvent.click(document.querySelector('[data-name="section-pm-button"]') as HTMLElement)
        expect(openPM).toHaveBeenCalledWith('/ws/proj')
    })

    it('aria-label 仍为「打开项目管理窗口」（无障碍名称不漂移）', () => {
        render(<ConversationList/>)
        expect(document.querySelector('[data-name="section-pm-button"]')?.getAttribute('aria-label'))
            .toBe('打开项目管理窗口')
    })
})

/**
 * 反向守卫（D15 入口唯一 / R-BJ）
 *
 * 原写法是 `render(<ConversationSidebar/>)` 后断言 folder-button 的 data-name 为 null —— 组件删除后
 * 该断言成了同义反复（data-name 只存在于被删组件里），且整机渲染要拖进一大票 store mock。
 * 改为静态契约断言：源码里不得再出现该 data-name / 组件标识符，且模块不再导出该组件。
 */
describe('顶部文件夹按钮已彻底移除（静态契约）', () => {
    it('源码中不再出现 conversation-sidebar-workspace-folder-button', () => {
        const src = fs.readFileSync(SIDEBAR_TSX, 'utf8')
        expect(src).not.toContain('conversation-sidebar-workspace-folder-button')
    })

    it('源码中不再出现 WorkspaceFolderButton 标识符', () => {
        const src = fs.readFileSync(SIDEBAR_TSX, 'utf8')
        expect(src).not.toContain('WorkspaceFolderButton')
    })

    it('模块不再导出 WorkspaceFolderButton', () => {
        expect((Sidebar as any).WorkspaceFolderButton).toBeUndefined()
    })
})
