// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, waitFor, within} from '@testing-library/react'
import {WorkspaceSelector} from '../../../src/renderer/components/ConversationSidebar'

// ── 依赖 mock ──
const {mockState, setWorkspaceMock, removeWorkspaceMock, openFolderDialogMock, openPathMock} =
    vi.hoisted(() => ({
        mockState: {
            currentWorkspacePath: 'E:/workspace/media/hclaw',
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
    fireEvent.click(screen.getByRole('button', {name: '选择工作目录'}))
}

/** 当前打开的面板（listbox），用于把查询限定在抽屉内（避免按钮上重复路径的干扰） */
function listbox(): HTMLElement {
    return screen.getByRole('listbox', {name: '工作目录列表'})
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
        fireEvent.change(screen.getByPlaceholderText('搜索目录...'), {
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

    it('触发按钮箭头状态感知：收起时向右，展开时向左旋转 180°', async () => {
        render(<WorkspaceSelector/>)
        const btn = screen.getByRole('button', {name: '选择工作目录'})
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

    it('点击"打开新目录"调用 openFolderDialog 并切换工作区', async () => {
        openFolderDialogMock.mockResolvedValue('E:/workspace/new')
        render(<WorkspaceSelector/>)
        openDrawer()
        fireEvent.click(within(listbox()).getByText('打开新目录'))
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
})
