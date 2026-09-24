// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {render, screen, fireEvent, waitFor} from '@testing-library/react'
import {useState, useRef, useEffect} from 'react'

/** 常态成员行在二级面板里（§16.2）：右键成员行 = 先让面板浮出来 */
function memberRow(index: number): HTMLElement {
    return document.querySelector(`[data-name="drawer-group-member-${index}"]`) as HTMLElement
}

function renderDrawer() {
    return render(
        <ProjectGroupDrawer drawerRef={{current: null}} search="" setSearch={() => {}} onClose={() => {}}/>,
    )
}

/** 焦点路径开面板（组头 onFocus = 立即开，D4） */
function openPanel(groupId = 'pg-a') {
    fireEvent.focus(
        document.querySelector(`[data-name="group-block-header"][data-group-id="${groupId}"]`) as HTMLElement)
}

function panel(): HTMLElement | null {
    return document.querySelector('[data-name="drawer-group-panel"]') as HTMLElement | null
}

const groupState = vi.hoisted(() => ({
    groups: [{
        id: 'pg-a', name: '组A', sortOrder: 0, createdAt: 1, updatedAt: 1,
        members: [{projectPath: '/ws/a', groupOrder: 0}],
    }],
    load: vi.fn(), create: vi.fn(), rename: vi.fn(), dissolve: vi.fn(), remove: vi.fn(),
    assign: vi.fn(), reorderGroups: vi.fn(), reorderProjects: vi.fn(),
}))
const confirmMock = vi.hoisted(() => vi.fn(async () => true))
const removeWorkspaceMock = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('../../../src/renderer/stores/projectGroupStore', () => ({
    useProjectGroupStore: (sel?: (s: typeof groupState) => unknown) => (sel ? sel(groupState) : groupState),
    projectGroupOf: () => null,
}))
vi.mock('../../../src/renderer/components/ConfirmDialog', () => ({confirm: confirmMock}))

const convState = vi.hoisted(() => ({
    workspaces: {'/ws/a': {lastOpenedAt: 1, conversations: []}},
    currentWorkspacePath: '/ws/a',
    viewScope: {type: 'group', groupId: 'pg-a'},
    setWorkspace: vi.fn(),
    setProjectGroupView: vi.fn(),
    removeWorkspace: removeWorkspaceMock,
}))
vi.mock('../../../src/renderer/stores/conversationStore', () => ({
    useConversationStore: (sel?: (s: typeof convState) => unknown) => (sel ? sel(convState) : convState),
}))

import {ProjectGroupDrawer} from '../../../src/renderer/components/ProjectGroupDrawer'

beforeEach(() => {
    vi.clearAllMocks()
    groupState.groups = [{
        id: 'pg-a', name: '组A', sortOrder: 0, createdAt: 1, updatedAt: 1,
        members: [{projectPath: '/ws/a', groupOrder: 0}],
    }]
})

function openGroupMenu() {
    render(<ProjectGroupDrawer drawerRef={{current: null}} search="" setSearch={() => {}} onClose={() => {}}/>)
    fireEvent.contextMenu(screen.getByText('组A'))
}

describe('ProjectGroupDrawer — 组右键菜单', () => {
    it('三项：重命名 / 解散 / 删除组', () => {
        openGroupMenu()
        expect(screen.getByText('重命名')).toBeTruthy()
        expect(screen.getByText('解散')).toBeTruthy()
        expect(screen.getByText('删除组')).toBeTruthy()
    })

    it('解散 → dissolve(id)，不弹级联询问', async () => {
        openGroupMenu()
        fireEvent.click(screen.getByText('解散'))
        await waitFor(() => expect(groupState.dissolve).toHaveBeenCalledWith('pg-a'))
        expect(confirmMock).not.toHaveBeenCalled()
    })

    it('非空组「删除组」→ 弹询问；选"仅解散" → dissolve，不删项目', async () => {
        confirmMock.mockResolvedValueOnce(false) // confirm 返回 false = 用户选了"否"
        openGroupMenu()
        fireEvent.click(screen.getByText('删除组'))
        await waitFor(() => expect(confirmMock).toHaveBeenCalled())
        await waitFor(() => expect(groupState.dissolve).toHaveBeenCalledWith('pg-a'))
        expect(removeWorkspaceMock).not.toHaveBeenCalled()
    })

    it('非空组「删除组」+ 选级联 → 逐项目 removeWorkspace 后删组记录', async () => {
        confirmMock.mockResolvedValueOnce(true)
        openGroupMenu()
        fireEvent.click(screen.getByText('删除组'))
        await waitFor(() => expect(removeWorkspaceMock).toHaveBeenCalledWith('/ws/a'))
        await waitFor(() => expect(groupState.remove).toHaveBeenCalledWith('pg-a'))
    })

    it('空组「删除组」→ 直接 remove，不弹询问', async () => {
        groupState.groups = [{id: 'pg-empty', name: '空组', sortOrder: 0, createdAt: 1, updatedAt: 1, members: []}]
        render(<ProjectGroupDrawer drawerRef={{current: null}} search="" setSearch={() => {}} onClose={() => {}}/>)
        fireEvent.contextMenu(screen.getByText('空组'))
        fireEvent.click(screen.getByText('删除组'))
        await waitFor(() => expect(groupState.remove).toHaveBeenCalledWith('pg-empty'))
        expect(confirmMock).not.toHaveBeenCalled()
    })

    it('部分失败：3 个项目删 1 个失败 → 其余继续删，组仍删除', async () => {
        groupState.groups = [{
            id: 'pg-a', name: '组A', sortOrder: 0, createdAt: 1, updatedAt: 1,
            members: [
                {projectPath: '/ws/a', groupOrder: 0},
                {projectPath: '/ws/b', groupOrder: 1},
                {projectPath: '/ws/c', groupOrder: 2},
            ],
        }]
        removeWorkspaceMock.mockRejectedValueOnce(new Error('boom'))
        confirmMock.mockResolvedValueOnce(true)
        render(<ProjectGroupDrawer drawerRef={{current: null}} search="" setSearch={() => {}} onClose={() => {}}/>)
        fireEvent.contextMenu(screen.getByText('组A'))
        fireEvent.click(screen.getByText('删除组'))
        await waitFor(() => expect(removeWorkspaceMock).toHaveBeenCalledTimes(3))
        await waitFor(() => expect(groupState.remove).toHaveBeenCalledWith('pg-a'))
    })
})

describe('ProjectGroupDrawer — 组内项目右键（面板成员行）', () => {
    it('三项：移出组 / 在文件管理器中打开 / 移除项目', () => {
        renderDrawer()
        openPanel()
        fireEvent.contextMenu(memberRow(0))
        expect(screen.getByText('移出组')).toBeTruthy()
        expect(screen.getByText('在文件管理器中打开')).toBeTruthy()
        expect(screen.getByText('移除项目')).toBeTruthy()
    })

    it('移出组 → assign(path, null)', async () => {
        renderDrawer()
        openPanel()
        fireEvent.contextMenu(memberRow(0))
        fireEvent.click(screen.getByText('移出组'))
        await waitFor(() => expect(groupState.assign).toHaveBeenCalledWith('/ws/a', null))
    })

    it('菜单打开期间面板被钉住：鼠标离开面板越过宽限也不关；菜单关闭后回落再走宽限', async () => {
        renderDrawer()
        openPanel()
        fireEvent.contextMenu(memberRow(0))
        expect(panel()).toBeTruthy()
        // 菜单开着时鼠标离开面板 → 钉住，宽限期不生效
        fireEvent.mouseLeave(panel() as HTMLElement)
        await new Promise((resolve) => setTimeout(resolve, 260)) // 越过 200ms 宽限
        expect(panel()).toBeTruthy()
        // 关掉菜单 → 钉住回落 → 指针不在面板/组头上（jsdom 无 elementFromPoint）→ 宽限关闭
        fireEvent.keyDown(window, {key: 'Escape'})
        await waitFor(() => expect(panel()).toBeNull())
    })
})

/**
 * 复刻 ConversationSidebar.handleClickOutside（document mousedown 冒泡阶段，
 * target 不在 drawerRef 内 → 关抽屉）。
 *
 * 菜单 portal 到 body 不在 drawerRef 子树里 —— 如果菜单根没有 onMouseDown stopPropagation，
 * 点任意菜单项时 mousedown 先冒泡到 document → 抽屉关 → 菜单卸载 → 随后 click 打空 → 动作不触发。
 */
function DrawerWithOutsideClose() {
    const [closed, setClosed] = useState(false)
    const drawerRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            const target = e.target as Node
            if (drawerRef.current?.contains(target)) return
            setClosed(true)
        }
        document.addEventListener('mousedown', handleClickOutside)
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [])

    if (closed) return null
    return <ProjectGroupDrawer drawerRef={drawerRef} search="" setSearch={() => {}} onClose={() => setClosed(true)} />
}

describe('ProjectGroupDrawer — 右键菜单 onMouseDown 防护', () => {
    it('菜单 mousedown 不冒泡到 document：否则侧栏"点外部关抽屉"先关抽屉，随后 click 打空', async () => {
        render(<DrawerWithOutsideClose/>)
        fireEvent.contextMenu(screen.getByText('组A'))

        const dissolveBtn = screen.getByText('解散')
        // 浏览器先派发 mousedown 再派发 click：fireEvent 顺序与之同
        fireEvent.mouseDown(dissolveBtn)
        // 未经修复时 mousedown 冒泡到 document → handleClickOutside → 抽屉卸载 → 菜单消失
        expect(screen.queryByText('解散')).toBeTruthy() // 菜单还在 = 抽屉没被关

        // 随后 click 真的触发了动作（以「解散」为例）
        fireEvent.click(dissolveBtn)
        await waitFor(() => expect(groupState.dissolve).toHaveBeenCalledWith('pg-a'))
    })

    it('面板 mousedown 不冒泡到 document：否则面板行的 mousedown 会先关掉抽屉，click 打空', () => {
        render(<DrawerWithOutsideClose/>)
        openPanel()
        expect(panel()).toBeTruthy()
        fireEvent.mouseDown(memberRow(0))
        // 抽屉没被"点外部"关掉 → 面板与成员行都还在
        expect(panel()).toBeTruthy()
        expect(memberRow(0)).toBeTruthy()
    })
})
