// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, waitFor} from '@testing-library/react'
import {ConversationList} from '../../../src/renderer/components/ConversationSidebar'

// ── 依赖 mock ──
// ★ Task 13：列表取数入口由 getFilteredConversations 换成 getScopedSections（spec §5.3），
//   本文件只更新数据夹具（段 + 段内会话摘要），右键菜单的断言与交互路径未变。
const {mockState, getScopedSectionsMock} = vi.hoisted(() => {
    const ws = 'E:/workspace/media/hclaw'
    const convs = () => ([
        {id: 'conv-1', title: '第一个会话', parentConvId: null, createdAt: Date.now(), updatedAt: 300, preview: '', pinned: false},
        {id: 'conv-2', title: '第二个会话', parentConvId: null, createdAt: Date.now() - 60000, updatedAt: 200, preview: '', pinned: false},
    ])
    const sections = () => [{
        key: ws,
        projectPath: ws,
        projectName: 'hclaw',
        gitBranch: null,
        collapsed: false,
        count: 2,
        hasMore: false,
        rows: convs().map(c => ({id: c.id, parentConvId: c.parentConvId, indentLevel: 0, childCount: 0})),
    }]
    return {
        mockState: {
            currentWorkspacePath: ws,
            viewScope: {type: 'project' as const, path: ws},
            workspaces: {
                [ws]: {lastOpenedAt: 300, conversations: convs()},
            },
            searchQuery: '',
        },
        getScopedSectionsMock: vi.fn(() => sections()),
    }
})

vi.mock('../../../src/renderer/stores/conversationStore', () => ({
    useConversationStore: (selector: (s: any) => unknown) =>
        selector({
            ...mockState,
            getScopedSections: getScopedSectionsMock,
            toggleSectionCollapsed: vi.fn(),
            expandSection: vi.fn(),
            clearFocusProject: vi.fn(),
            refreshVisibleBranches: vi.fn(async () => {}),
            setSearchQuery: vi.fn(),
            setActiveConversation: vi.fn(),
            updateConversationMeta: vi.fn(),
        }),
}))

vi.mock('../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: (selector: (s: {
        convAgentStates: Record<string, unknown>
        doneUnreadIds: Record<string, number>
        clearConvDoneUnread: (convId: string) => void
    }) => unknown) =>
        selector({convAgentStates: {}, doneUnreadIds: {}, clearConvDoneUnread: () => {}}),
}))

beforeEach(() => {
    getScopedSectionsMock.mockReset()
    const ws = 'E:/workspace/media/hclaw'
    const convs = [
        {id: 'conv-1', title: '第一个会话', parentConvId: null, createdAt: Date.now(), updatedAt: 300, preview: '', pinned: false},
        {id: 'conv-2', title: '第二个会话', parentConvId: null, createdAt: Date.now() - 60000, updatedAt: 200, preview: '', pinned: false},
    ]
    mockState.workspaces[ws].conversations = convs
    getScopedSectionsMock.mockReturnValue([{
        key: ws,
        projectPath: ws,
        projectName: 'hclaw',
        gitBranch: null,
        collapsed: false,
        count: 2,
        hasMore: false,
        rows: convs.map(c => ({id: c.id, parentConvId: c.parentConvId, indentLevel: 0, childCount: 0})),
    }])
})

afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

/** 通过右键菜单打开会话条目的右键菜单 */
function openContextMenu(): void {
    const item = screen.getByText('第一个会话').closest('div')
    if (!item) throw new Error('未找到会话条目')
    fireEvent.contextMenu(item, {clientX: 100, clientY: 100})
}

/** 菜单项（重命名）在 DOM 中可见 */
function renameMenuItem(): HTMLElement {
    return screen.getByText('重命名')
}

describe('ConversationList 右键菜单', () => {
    it('右键菜单打开后可见', () => {
        render(<ConversationList/>)
        openContextMenu()
        expect(renameMenuItem()).toBeTruthy()
    })

    it('★ 核心：messageList 自动滚动产生的 window scroll 事件不关闭菜单', () => {
        render(<ConversationList/>)
        openContextMenu()
        expect(renameMenuItem()).toBeTruthy()

        // 模拟 messageList 区域自动滚动产生的 scroll 事件：
        //   - 新消息到达时 scrollToBottom('auto')
        //   - 流式内容 MutationObserver 跟随写入 el.scrollTop
        //   - 初始化滚动到底部
        // 这些 scroll 事件都会传播到 window。
        fireEvent.scroll(window)
        fireEvent.scroll(window)
        fireEvent.scroll(window)

        // 菜单应保持打开
        expect(renameMenuItem()).toBeTruthy()
    })

    it('★ 核心：messageList DOM 更新（MutationObserver 触发的子树变化）不关闭菜单', () => {
        render(<ConversationList/>)
        openContextMenu()
        expect(renameMenuItem()).toBeTruthy()

        // 模拟 messageList 容器内 DOM 变化（新消息插入、流式文本更新）
        // MutationObserver 监听 childList/subtree/characterData，不产生 click/scroll 事件
        fireEvent.mouseMove(document.body)

        // 菜单应保持打开
        expect(renameMenuItem()).toBeTruthy()
    })

    it('点击菜单外部正常关闭菜单', async () => {
        render(<ConversationList/>)
        openContextMenu()
        expect(renameMenuItem()).toBeTruthy()

        fireEvent.click(document.body)
        // 菜单通过 AnimatePresence 退出动画卸载，等待 DOM 更新
        await waitFor(() => expect(screen.queryByText('重命名')).toBeNull())
    })

    it('右键菜单外区域（contextmenu）正常关闭菜单', async () => {
        render(<ConversationList/>)
        openContextMenu()
        expect(renameMenuItem()).toBeTruthy()

        fireEvent.contextMenu(document.body)
        await waitFor(() => expect(screen.queryByText('重命名')).toBeNull())
    })

    it('点击菜单项执行操作并关闭菜单', async () => {
        render(<ConversationList/>)
        openContextMenu()
        expect(renameMenuItem()).toBeTruthy()

        fireEvent.click(renameMenuItem())
        // 点击后菜单关闭（onStartRename 会 setContextMenu(null)）
        await waitFor(() => expect(screen.queryByText('重命名')).toBeNull())
    })
})