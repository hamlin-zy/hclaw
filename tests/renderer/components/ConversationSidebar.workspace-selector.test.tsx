// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, waitFor, within, act} from '@testing-library/react'
import {WorkspaceSelector} from '../../../src/renderer/components/ConversationSidebar'
import {useProjectGroupStore} from '../../../src/renderer/stores/projectGroupStore'

// ── 依赖 mock ──
const {mockState, setWorkspaceMock, removeWorkspaceMock, openFolderDialogMock, openPathMock} =
    vi.hoisted(() => ({
        mockState: {
            currentWorkspacePath: 'E:/workspace/media/hclaw',
            // 视图作用域（R-AA：组视图下触发按钮无障碍名称附组名 + 成员数；其余为基串）
            viewScope: undefined as {type: string; groupId?: string; path?: string} | undefined,
            workspaces: {
                'E:/workspace/media/hclaw': {lastOpenedAt: 200, conversations: []},
                'E:/workspace/guali/guali-backend': {lastOpenedAt: 100, conversations: []},
                'C:/Users/Hamlin/.hclaw': {lastOpenedAt: 300, conversations: []},
            },
        },
        setWorkspaceMock: vi.fn(),
        removeWorkspaceMock: vi.fn(),
        openFolderDialogMock: vi.fn(),
        openPathMock: vi.fn(),
    }))

vi.mock('../../../src/renderer/stores/conversationStore', () => ({
    useConversationStore: (selector: (s: typeof mockState & {
        setWorkspace: (path: string | null) => void
        removeWorkspace: (path: string) => void
    }) => unknown) =>
        selector({
            ...mockState,
            setWorkspace: setWorkspaceMock,
            removeWorkspace: removeWorkspaceMock,
        }),
}))

beforeEach(() => {
    vi.stubGlobal('electronAPI', {
        openFolderDialog: openFolderDialogMock,
        openPath: openPathMock,
    })
    // jsdom 未实现 getBoundingClientRect 尺寸逻辑，返回合理值
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
        left: 16, right: 240, top: 40, bottom: 72,
        width: 224, height: 32, x: 16, y: 40,
        toJSON: () => ({}),
    } as DOMRect)
    Element.prototype.scrollIntoView = vi.fn()
    setWorkspaceMock.mockReset()
    removeWorkspaceMock.mockReset()
    openFolderDialogMock.mockReset()
    openPathMock.mockReset()
})

afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

function openDrawer(): void {
    fireEvent.click(screen.getByRole('button', {name: '切换项目 / 项目组'}))
}

/** 当前打开的面板（listbox），用于把查询限定在抽屉内（避免按钮上重复路径的干扰） */
function listbox(): HTMLElement {
    return screen.getByRole('listbox', {name: '项目列表'})
}

describe('WorkspaceSelector 抽屉', () => {
    it('点击按钮展开抽屉，展示全部目录且路径不截断', () => {
        render(<WorkspaceSelector/>)
        openDrawer()
        const panel = listbox()
        expect(within(panel).getByText('E:/workspace/guali/guali-backend')).toBeTruthy()
        expect(within(panel).getByText('E:/workspace/media/hclaw')).toBeTruthy()
    })

    it('按最近使用排序（lastOpenedAt 降序）', () => {
        render(<WorkspaceSelector/>)
        openDrawer()
        const options = within(listbox()).getAllByRole('option').map((el) => el.textContent)
        const idx = (p: string) => options.findIndex((t) => t?.includes(p))
        expect(idx('C:/Users/Hamlin/.hclaw')).toBeLessThan(idx('E:/workspace/media/hclaw'))
        expect(idx('E:/workspace/media/hclaw')).toBeLessThan(idx('E:/workspace/guali/guali-backend'))
    })

    it('搜索过滤目录', () => {
        render(<WorkspaceSelector/>)
        openDrawer()
        fireEvent.change(screen.getByPlaceholderText('搜索项目…'), {
            target: {value: 'guali'},
        })
        const panel = listbox()
        expect(within(panel).getByText('E:/workspace/guali/guali-backend')).toBeTruthy()
        expect(within(panel).queryByText('E:/workspace/media/hclaw')).toBeNull()
    })

    it('选中目录调用 setWorkspace 并关闭抽屉', () => {
        render(<WorkspaceSelector/>)
        openDrawer()
        fireEvent.click(within(listbox()).getByText('E:/workspace/guali/guali-backend'))
        expect(setWorkspaceMock).toHaveBeenCalledWith('E:/workspace/guali/guali-backend')
        expect(screen.queryAllByRole('option')).toHaveLength(0) // 抽屉已关闭
    })

    it('点击外部关闭抽屉', () => {
        render(<WorkspaceSelector/>)
        openDrawer()
        fireEvent.mouseDown(document.body)
        expect(screen.queryAllByRole('option')).toHaveLength(0)
    })

    it('点击抽屉内部（如列表项）不会关闭抽屉', () => {
        render(<WorkspaceSelector/>)
        openDrawer()
        fireEvent.mouseDown(screen.getByText('E:/workspace/guali/guali-backend'))
        expect(screen.getByRole('listbox')).toBeTruthy() // 抽屉保持打开
    })

    it('按 Esc 关闭抽屉', () => {
        render(<WorkspaceSelector/>)
        openDrawer()
        fireEvent.keyDown(document, {key: 'Escape'})
        expect(screen.queryAllByRole('option')).toHaveLength(0)
    })

    it('组名输入中按 Esc 只取消输入：stopPropagation 挡住 document 上的关闭监听', () => {
        render(<WorkspaceSelector/>)
        openDrawer()
        fireEvent.click(within(listbox()).getByText('创建项目组'))
        const nameInput = screen.getByPlaceholderText('项目组名称')
        // 从输入框冒泡到 document —— 真实用户按键的路径，也是侧栏 document 监听唯一能否收到该事件的地方。
        // 若内联输入的 Esc 处理丢掉 stopPropagation，事件会冒泡到 document → 抽屉被关掉（本用例转红）。
        fireEvent.keyDown(nameInput, {key: 'Escape'})
        expect(screen.queryByPlaceholderText('项目组名称')).toBeNull() // 输入已取消
        expect(screen.getByRole('listbox', {name: '项目列表'})).toBeTruthy() // 抽屉仍在
    })

    it('触发按钮箭头状态感知：收起时向右，展开时向左旋转 180°', async () => {
        render(<WorkspaceSelector/>)
        const btn = screen.getByRole('button', {name: '切换项目 / 项目组'})
        const chevron = btn.querySelector(':scope > svg') as SVGElement
        // 收起：默认向右箭头（无 rotate-180）
        expect(chevron.classList.contains('rotate-180')).toBe(false)
        // 展开：旋转 180° 指向左（setIsOpen 异步，等待 DOM 更新）
        openDrawer()
        await waitFor(() => expect(chevron.classList.contains('rotate-180')).toBe(true))
        // 关闭：恢复向右
        fireEvent.keyDown(document, {key: 'Escape'})
        await waitFor(() => expect(chevron.classList.contains('rotate-180')).toBe(false))
    })

    it('点击"添加项目"调用 openFolderDialog 并切换工作区', async () => {
        openFolderDialogMock.mockResolvedValue('E:/workspace/new')
        render(<WorkspaceSelector/>)
        openDrawer()
        fireEvent.click(within(listbox()).getByText('添加项目'))
        await waitFor(() => expect(openFolderDialogMock).toHaveBeenCalled())
        await waitFor(() => expect(setWorkspaceMock).toHaveBeenCalledWith('E:/workspace/new'))
        expect(screen.queryAllByRole('option')).toHaveLength(0)
    })

    it('当前工作区项显示选中态，hover 显示操作按钮', () => {
        render(<WorkspaceSelector/>)
        openDrawer()
        const panel = listbox()
        const current = within(panel).getAllByText('E:/workspace/media/hclaw')
            .map((el) => el.closest('[role="option"]'))
            .find(Boolean)
        expect(current?.getAttribute('aria-selected')).toBe('true')
        // 操作按钮在 hover 时可见（opacity 类切换），此处验证按钮存在
        expect(within(panel).getAllByRole('button', {name: '在文件管理器中打开'})).toHaveLength(3)
        expect(within(panel).getAllByRole('button', {name: '从历史中移除'})).toHaveLength(3)
    })

    it('点击"在文件管理器中打开"不触发选中', () => {
        render(<WorkspaceSelector/>)
        openDrawer()
        const panel = listbox()
        // 排序后第一个 option（lastOpenedAt 300）的打开按钮
        const openBtn = within(panel).getAllByRole('button', {name: '在文件管理器中打开'})[0]
        fireEvent.click(openBtn)
        expect(openPathMock).toHaveBeenCalledWith('C:/Users/Hamlin/.hclaw')
        expect(setWorkspaceMock).not.toHaveBeenCalled()
        // 抽屉保持打开
        expect(within(panel).getAllByRole('option').length).toBeGreaterThan(0)
    })

    // R-AA（progress.md:215）：组视图触发按钮的无障碍名称 = 基串 + 「：${组名}（${成员数} 个项目）」
    it('组视图：触发按钮无障碍名称附组名与成员数', () => {
        mockState.viewScope = {type: 'group', groupId: 'pg-a'}
        act(() => {
            useProjectGroupStore.setState({
                groups: [{
                    id: 'pg-a',
                    name: '组A',
                    sortOrder: 0,
                    createdAt: 0,
                    updatedAt: 0,
                    members: [
                        {projectPath: 'E:/a', groupOrder: 0},
                        {projectPath: 'E:/b', groupOrder: 1},
                    ],
                }],
            })
        })
        try {
            render(<WorkspaceSelector/>)
            expect(
                screen.getByRole('button', {name: '切换项目 / 项目组：组A（2 个项目）'}),
            ).toBeTruthy()
        } finally {
            mockState.viewScope = undefined
            act(() => {
                useProjectGroupStore.setState({groups: []})
            })
        }
    })

    // 组视图下触发按钮的**可见内容**：组名 + 项目数徽章；不再显示项目名/分支/路径。
    // （aria-label 已由上一条覆盖；这里守住"看见的是组，不是某个项目"。）
    const btnEl = () => document.querySelector('[data-name="conversation-sidebar-workspace-select-button"]') as HTMLElement

    it('组视图：可见内容 = 组名 + 项目数徽章，不显示项目名/路径', () => {
        mockState.viewScope = {type: 'group', groupId: 'pg-a'}
        act(() => {
            useProjectGroupStore.setState({
                groups: [{
                    id: 'pg-a', name: '组A', sortOrder: 0, createdAt: 0, updatedAt: 0,
                    members: [
                        {projectPath: 'E:/a', groupOrder: 0},
                        {projectPath: 'E:/b', groupOrder: 1},
                    ],
                }],
            })
        })
        try {
            render(<WorkspaceSelector/>)
            const btn = btnEl()
            // 组名可见
            expect(btn.textContent).toContain('组A')
            // 项目数徽章存在且显示成员数
            const badge = btn.querySelector('[data-name="workspace-group-count-badge"]') as HTMLElement
            expect(badge).toBeTruthy()
            expect(badge.textContent).toContain('2')
            // 不显示当前项目路径（组视图语义是"看整组"）
            expect(btn.textContent).not.toContain(mockState.currentWorkspacePath)
        } finally {
            mockState.viewScope = undefined
            act(() => {
                useProjectGroupStore.setState({groups: []})
            })
        }
    })

    it('项目视图：可见内容 = 项目名 + 路径，无组徽章（保持现状）', () => {
        mockState.viewScope = {type: 'project', path: mockState.currentWorkspacePath!}
        render(<WorkspaceSelector/>)
        const btn = btnEl()
        // 项目名（末段）可见
        expect(btn.textContent).toContain('hclaw')
        // 完整路径可见
        expect(btn.textContent).toContain(mockState.currentWorkspacePath)
        // 不出现组徽章
        expect(btn.querySelector('[data-name="workspace-group-count-badge"]')).toBeNull()
    })
})
