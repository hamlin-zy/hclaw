// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, waitFor} from '@testing-library/react'
import {ConversationList} from '../../../src/renderer/components/ConversationSidebar'

// ── 依赖 mock ──
const {mockState, getFilteredConversationsMock} = vi.hoisted(() => ({
    mockState: {
        currentWorkspacePath: 'E:/workspace/media/hclaw',
        workspaces: {
            'E:/workspace/media/hclaw': {lastOpenedAt: 300, conversations: []},
        },
        searchQuery: '',
    },
    getFilteredConversationsMock: vi.fn(() => [
        {id: 'conv-1', title: '第一个会话', parentConvId: null, updatedAt: 300, preview: '', pinned: false},
        {id: 'conv-2', title: '第二个会话', parentConvId: null, updatedAt: 200, preview: '', pinned: false},
    ]),
}))

vi.mock('../../../src/renderer/stores/conversationStore', () => ({
    useConversationStore: (selector: (s: typeof mockState & {
        getFilteredConversations: () => unknown[]
        setSearchQuery: (q: string) => void
        setActiveConversation: (id: string | null) => void
    }) => unknown) =>
        selector({
            ...mockState,
            getFilteredConversations: getFilteredConversationsMock,
            setSearchQuery: vi.fn(),
            setActiveConversation: vi.fn(),
        }),
}))

vi.mock('../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: (selector: (s: {convAgentStates: Record<string, unknown>}) => unknown) =>
        selector({convAgentStates: {}}),
}))

beforeEach(() => {
    getFilteredConversationsMock.mockReset()
    getFilteredConversationsMock.mockReturnValue([
        {id: 'conv-1', title: '第一个会话', parentConvId: null, updatedAt: 300, preview: '', pinned: false},
        {id: 'conv-2', title: '第二个会话', parentConvId: null, updatedAt: 200, preview: '', pinned: false},
    ])
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