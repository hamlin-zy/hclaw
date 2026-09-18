// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {render, screen, fireEvent, waitFor} from '@testing-library/react'
import {useState, useRef, useEffect} from 'react'

/**
 * 成员行现在只在二级面板里（§16.1）——右键它们之前必须先 hover 组头把面板打开。
 * 面板的定位要读 drawerRef.current 的矩形，所以这里用真实 ref（`{current: null}` 面板开不出来）。
 */
async function openPanel(groupName = '组A') {
    fireEvent.mouseEnter(screen.getByText(groupName))
    await waitFor(() => expect(document.querySelector('[data-name="drawer-group-panel"]')).toBeTruthy())
}

function panelMember(index: number): HTMLElement {
    return document.querySelector(`[data-name="drawer-group-member-${index}"]`) as HTMLElement
}

/** 真实 ref：面板开关依赖 drawerRef.current 的矩形 */
function renderDrawer() {
    const drawerRef = {current: null as HTMLDivElement | null}
    return render(
        <ProjectGroupDrawer drawerRef={drawerRef} search="" setSearch={() => {}} onClose={() => {}}/>,
    )
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

describe('ProjectGroupDrawer — 组内项目右键', () => {
    it('三项：移出组 / 在文件管理器中打开 / 移除项目', async () => {
        renderDrawer()
        await openPanel()
        fireEvent.contextMenu(panelMember(0))
        expect(screen.getByText('移出组')).toBeTruthy()
        expect(screen.getByText('在文件管理器中打开')).toBeTruthy()
        expect(screen.getByText('移除项目')).toBeTruthy()
    })

    it('移出组 → assign(path, null)', async () => {
        renderDrawer()
        await openPanel()
        fireEvent.contextMenu(panelMember(0))
        fireEvent.click(screen.getByText('移出组'))
        await waitFor(() => expect(groupState.assign).toHaveBeenCalledWith('/ws/a', null))
    })

    it('右键菜单从面板行打开时面板钉住不关（menu 期间鼠标会离开面板）', async () => {
        renderDrawer()
        await openPanel()
        fireEvent.contextMenu(panelMember(0))
        expect(screen.getByText('移出组')).toBeTruthy()
        // 面板自身的 mouseleave 不该把面板关掉：菜单还锚在它上面
        fireEvent.mouseLeave(document.querySelector('[data-name="drawer-group-panel"]') as HTMLElement)
        await new Promise((r) => setTimeout(r, 260)) // 超过 200ms 宽限
        expect(document.querySelector('[data-name="drawer-group-panel"]')).toBeTruthy()
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
})
