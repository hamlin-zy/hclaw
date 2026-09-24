// @vitest-environment jsdom
/**
 * 抽屉键盘可达性（§16.1 / D4）：
 *  · 组头 ArrowRight = 开面板 + 焦点送进面板头行；ArrowLeft = 关面板 + 焦点回组头；Enter/Space = 进组视图；
 *  · 焦点进组头 = 立即开面板（键盘用户没有 hover，等延时只会让面板迟到）；
 *  · 面板内 Esc = 只关面板（抽屉不关）+ 焦点回组头（restoringFocusRef 跳过一次 onFocus，否则立刻重开）；
 *  · A2 面板成员行 button 化 / A3 未分组行 group-focus-within / A5 重命名 Esc 分层。
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {render, screen, fireEvent} from '@testing-library/react'

const groupState = vi.hoisted(() => ({
    groups: [{
        id: 'pg-a', name: '组A', sortOrder: 0, createdAt: 1, updatedAt: 1,
        members: [{projectPath: '/ws/a', groupOrder: 0}],
    }],
    load: vi.fn(), create: vi.fn(), rename: vi.fn(), dissolve: vi.fn(), remove: vi.fn(),
    assign: vi.fn(), reorderGroups: vi.fn(), reorderProjects: vi.fn(),
}))
const convState = vi.hoisted(() => ({
    workspaces: {'/ws/a': {lastOpenedAt: 1, conversations: []}, '/ws/b': {lastOpenedAt: 2, conversations: []}},
    currentWorkspacePath: '/ws/a',
    viewScope: {type: 'group', groupId: 'pg-a'},
    setWorkspace: vi.fn(),
    setProjectGroupView: vi.fn(),
    removeWorkspace: vi.fn(async () => {}),
}))
vi.mock('../../../src/renderer/stores/projectGroupStore', () => ({
    useProjectGroupStore: (sel?: (s: typeof groupState) => unknown) => (sel ? sel(groupState) : groupState),
    projectGroupOf: () => null,
}))
vi.mock('../../../src/renderer/stores/conversationStore', () => ({
    useConversationStore: (sel?: (s: typeof convState) => unknown) => (sel ? sel(convState) : convState),
}))

import {ProjectGroupDrawer} from '../../../src/renderer/components/ProjectGroupDrawer'

function renderDrawer(onClose: () => void = () => {}, search = '') {
    return render(<ProjectGroupDrawer drawerRef={{current: null}} search={search} setSearch={() => {}} onClose={onClose}/>)
}

function header(): HTMLElement {
    return document.querySelector('[data-name="group-block-header"]') as HTMLElement
}

function panel(): HTMLElement | null {
    return document.querySelector('[data-name="drawer-group-panel"]') as HTMLElement | null
}

function panelHeader(): HTMLElement {
    return document.querySelector('[data-name="drawer-group-panel-header-pg-a"]') as HTMLElement
}

beforeEach(() => {
    vi.clearAllMocks()
    groupState.groups = [{
        id: 'pg-a', name: '组A', sortOrder: 0, createdAt: 1, updatedAt: 1,
        members: [{projectPath: '/ws/a', groupOrder: 0}],
    }]
})

describe('ProjectGroupDrawer — 组头键盘与面板焦点桥（D4）', () => {
    it('A1: 焦点进组头 → 立即开面板（不等 120ms 延时）', () => {
        renderDrawer()
        expect(panel()).toBeNull()
        fireEvent.focus(header())
        expect(panel()).not.toBeNull()
    })

    it('A1: 焦点落在组头内的「+ 加入本组」时不当作"焦点进组头"（不弹面板）', () => {
        renderDrawer()
        const addBtn = document.querySelector('[data-name="group-add-project"]') as HTMLElement
        expect(addBtn).not.toBeNull()
        // onFocus 走 focusin 委托、会从子控件冒泡到组头：鼠标点一下「+」不该把面板顶出来
        // （恢复二级面板后组头里才有的常驻按钮）
        fireEvent.focus(addBtn)
        expect(panel()).toBeNull()
    })

    it('A1: ArrowRight → 开面板并把焦点送进面板头行', () => {
        renderDrawer()
        fireEvent.keyDown(header(), {key: 'ArrowRight'})
        expect(panel()).not.toBeNull()
        expect(panelHeader()).not.toBeNull()
        expect(document.activeElement).toBe(panelHeader())
    })

    it('A1: 面板内 ArrowLeft → 只关面板 + 焦点回组头（不重开）', () => {
        renderDrawer()
        fireEvent.keyDown(header(), {key: 'ArrowRight'})
        fireEvent.keyDown(panelHeader(), {key: 'ArrowLeft'})
        expect(panel()).toBeNull()
        // 焦点回还真的落到组头，且 restoringFocusRef 跳过了一次 onFocus —— 否则面板会立刻弹回来
        expect(document.activeElement).toBe(header())
        expect(panel()).toBeNull()
    })

    it('A1: 面板内 Esc → 只关面板（抽屉不关）+ 焦点回组头（不重开）', () => {
        const onClose = vi.fn()
        renderDrawer(onClose)
        fireEvent.focus(header())
        fireEvent.keyDown(panelHeader(), {key: 'Escape'})
        expect(panel()).toBeNull()
        expect(document.activeElement).toBe(header())
        expect(panel()).toBeNull()
        expect(onClose).not.toHaveBeenCalled() // 面板的 Esc 不冒泡到侧栏（否则会一次 Esc 关两样）
    })

    it('A1: 面板未开时组头 ArrowLeft 无操作（不关抽屉、不进组视图）', () => {
        const onClose = vi.fn()
        renderDrawer(onClose)
        const h = header()
        fireEvent.keyDown(h, {key: 'ArrowLeft'})
        expect(panel()).toBeNull()
        expect(onClose).not.toHaveBeenCalled()
        expect(convState.setProjectGroupView).not.toHaveBeenCalled()
    })

    it('A1: 组头 Enter → 进组视图并关抽屉（方向键不抢这个语义）', () => {
        const onClose = vi.fn()
        renderDrawer(onClose)
        fireEvent.keyDown(header(), {key: 'Enter'})
        expect(convState.setProjectGroupView).toHaveBeenCalledWith('pg-a')
        expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('A2: 面板成员行主体为原生 button（可 Tab、Enter 激活），当前项 aria-current="true"', () => {
        renderDrawer()
        fireEvent.keyDown(header(), {key: 'ArrowRight'})
        const member = document.querySelector('[data-name="drawer-group-member-open-0"]') as HTMLElement
        expect(member).not.toBeNull()
        expect(member.tagName).toBe('BUTTON')
        expect(member.getAttribute('tabindex')).not.toBe('-1')
        expect(member.getAttribute('aria-current')).toBe('true')
    })

    it('A3: 未分组行操作按钮容器带 group-focus-within（键盘聚焦时可见）', () => {
        renderDrawer()
        const row = document.querySelector('[data-name="top-project-row"]') as HTMLElement
        const openBtn = row.querySelector('[data-name="conversation-sidebar-open-in-explorer-button"]') as HTMLElement
        expect(openBtn.className).toContain('group-focus-within:opacity-100')
    })

    it('A5: 重命名输入框内 Escape 只取消重命名，抽屉不关', () => {
        const onClose = vi.fn()
        renderDrawer(onClose)
        fireEvent.contextMenu(screen.getByText('组A'))
        // 菜单项真实 data-name = drawer-group-menu-rename-button（取证：源码 menuItems）
        fireEvent.click(document.querySelector('[data-name="drawer-group-menu-rename-button"]') as HTMLElement)
        const input = document.querySelector('[data-name="drawer-group-rename-input"]') as HTMLInputElement
        expect(input).not.toBeNull()
        fireEvent.keyDown(input, {key: 'Escape'})
        expect(onClose).not.toHaveBeenCalled()
        // 输入框消失 = 重命名已取消
        expect(document.querySelector('[data-name="drawer-group-rename-input"]')).toBeNull()
    })

    it('D2: 搜索态下组头 ArrowRight 不开面板（搜索态成员已在层 1 内联渲染）', () => {
        renderDrawer(() => {}, '组A')
        // 前置：搜索态的内联命中成员确实渲染了（面板若开出来就是悬在它上面）
        expect(document.querySelector('[data-name="group-member-list"]')).not.toBeNull()
        fireEvent.keyDown(header(), {key: 'ArrowRight'})
        expect(panel()).toBeNull()
    })

    it('D2: 面板开着时进入搜索态 → 面板被收起（不悬在内联命中成员之上）', () => {
        const {rerender} = renderDrawer()
        fireEvent.focus(header())
        expect(panel()).not.toBeNull()
        rerender(<ProjectGroupDrawer drawerRef={{current: null}} search="组A" setSearch={() => {}} onClose={() => {}}/>)
        expect(panel()).toBeNull()
    })

    it('D4: 焦点在组头内的「+ 加入本组」上按 ArrowRight 不开面板（子控件不触发方向键语义）', () => {
        renderDrawer()
        const addBtn = document.querySelector('[data-name="group-add-project"]') as HTMLElement
        expect(addBtn).not.toBeNull()
        fireEvent.keyDown(addBtn, {key: 'ArrowRight'})
        expect(panel()).toBeNull()
    })
})
