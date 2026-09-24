// @vitest-environment jsdom
/**
 * 抽屉搜索态 × 拖拽契约（spec §5.8.5 / C1 / F7）：
 *  · 搜索态成员行内联可见、可点击（切项目 + 关抽屉），但不携带拖拽契约
 *    （不带 data-drag-row / data-index，不绑定 beginDrag）；
 *  · 搜索态下任何拖拽手势都不落库（beginDrag 短路，列表是过滤视图不是稳定排序视图）；
 *  · 常态成员行的 data-index 是渲染序整数，不随搜索过滤漂移。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, fireEvent, cleanup} from '@testing-library/react'

const groupState = vi.hoisted(() => ({
    groups: [
        {id: 'pg-a', name: '前端组', sortOrder: 0, createdAt: 1, updatedAt: 1,
         members: [
             {projectPath: '/ws/fe-1', groupOrder: 0},
             {projectPath: '/ws/fe-2', groupOrder: 1},
             {projectPath: '/ws/fe-3', groupOrder: 2},
         ]},
    ],
    load: vi.fn(), create: vi.fn(), rename: vi.fn(), dissolve: vi.fn(), remove: vi.fn(),
    assign: vi.fn(), reorderGroups: vi.fn(), reorderProjects: vi.fn(),
}))

vi.mock('../../../src/renderer/stores/projectGroupStore', () => ({
    useProjectGroupStore: (sel?: (s: typeof groupState) => unknown) => (sel ? sel(groupState) : groupState),
    projectGroupOf: () => null,
}))

const convState = vi.hoisted(() => ({
    workspaces: {
        '/ws/fe-1': {lastOpenedAt: 3, conversations: []},
        '/ws/fe-2': {lastOpenedAt: 2, conversations: []},
        '/ws/fe-3': {lastOpenedAt: 1, conversations: []},
        '/ws/other': {lastOpenedAt: 0, conversations: []},
    },
    currentWorkspacePath: '/ws/fe-1',
    viewScope: null as unknown,
    setWorkspace: vi.fn(),
    setProjectGroupView: vi.fn(),
    ensureWorkspaceRegistered: vi.fn(async () => '/ws/new'),
    removeWorkspace: vi.fn(),
}))

vi.mock('../../../src/renderer/stores/conversationStore', () => ({
    useConversationStore: (sel?: (s: typeof convState) => unknown) => (sel ? sel(convState) : convState),
}))

import {ProjectGroupDrawer} from '../../../src/renderer/components/ProjectGroupDrawer'

beforeEach(() => {
    vi.clearAllMocks()
})

afterEach(() => {
    cleanup()
    document.body.style.userSelect = ''
})

function renderDrawer(search = '') {
    const drawerRef = {current: null as HTMLDivElement | null}
    return render(
        <ProjectGroupDrawer drawerRef={drawerRef} search={search} setSearch={() => {}} onClose={() => {}}/>,
    )
}

/** 无任何写操作（搜索态不是稳定排序视图，任何拖拽序列都不得落库） */
function expectNoWrites() {
    expect(groupState.assign).not.toHaveBeenCalled()
    expect(groupState.reorderGroups).not.toHaveBeenCalled()
    expect(groupState.reorderProjects).not.toHaveBeenCalled()
}

describe('ProjectGroupDrawer — 搜索态与拖拽契约', () => {
    it('搜索态成员行内联可见、可点击，但不带 data-drag-row / data-index', () => {
        renderDrawer('ws')
        const members = Array.from(document.querySelectorAll('[data-name="group-member-row"]'))
        expect(members.length).toBeGreaterThan(0)
        for (const m of members) {
            expect(m.getAttribute('data-drag-row')).toBeNull()
            expect(m.getAttribute('data-index')).toBeNull()
        }
        // 可点击：切到该项目 + 关抽屉（关抽屉由 onClose 表达，这里断 setWorkspace）
        fireEvent.click(members[0].querySelector('[data-name^="group-member-open"]') as HTMLElement)
        expect(convState.setWorkspace).toHaveBeenCalledWith('/ws/fe-1')
    })

    it('负向：搜索态下拖拽序列（按下→移动→抬起）不进入拖拽态、不落库', () => {
        renderDrawer('ws')
        const member = document.querySelector('[data-name="group-member-row"]') as HTMLElement
        const topRow = document.querySelector('[data-name="top-project-row"]') as HTMLElement
        expect(topRow).toBeTruthy()
        // 从顶层行起手（若未短路，pointerMove 越阈值后应出现插入线/高亮）
        fireEvent.pointerDown(topRow, {clientX: 0, clientY: 0, button: 0})
        fireEvent.pointerMove(window, {clientX: 40, clientY: 40})
        fireEvent.pointerUp(window, {clientX: 40, clientY: 40})
        expect(document.querySelector('.drawer-insert-line')).toBeNull()
        expect(document.querySelector('.drawer-drop-over')).toBeNull()
        expect(document.querySelector('[data-name="drawer-drag-ghost"]')).toBeNull()
        // 可观测后果：无落库、组结构未变、作用域未变
        expectNoWrites()
        expect(groupState.groups[0].members.map((m) => m.projectPath)).toEqual(['/ws/fe-1', '/ws/fe-2', '/ws/fe-3'])
        expect(convState.viewScope).toBeNull()
        // 从成员行起手同样被短路
        fireEvent.pointerDown(member, {clientX: 0, clientY: 0, button: 0})
        fireEvent.pointerMove(window, {clientX: 40, clientY: 40})
        fireEvent.pointerUp(window, {clientX: 40, clientY: 40})
        expectNoWrites()
    })

    it('常态成员行的 data-index 是渲染序整数（不随搜索过滤漂移）', () => {
        renderDrawer()
        // 常态成员行在二级面板里 → 用焦点路径开面板（同步，无 120ms 延时）
        fireEvent.focus(document.querySelector('[data-name="group-block-header"]') as HTMLElement)
        const rows = Array.from(document.querySelectorAll('[data-drag-row="member"]'))
        expect(rows.map((el) => Number(el.getAttribute('data-index')))).toEqual([0, 1, 2])
        expect(rows.map((el) => el.getAttribute('data-group-id'))).toEqual(['pg-a', 'pg-a', 'pg-a'])
        expect(rows.map((el) => el.getAttribute('data-name')))
            .toEqual(['drawer-group-member-0', 'drawer-group-member-1', 'drawer-group-member-2'])
    })

    it('搜索态：hover / 焦点进组头都不开面板（成员已在层 1 内联，面板只会遮住它们）', async () => {
        renderDrawer('ws')
        const header = document.querySelector('[data-name="group-block-header"]') as HTMLElement
        fireEvent.mouseEnter(header)
        fireEvent.focus(header)
        await new Promise((resolve) => setTimeout(resolve, 200)) // 越过 120ms 开面板延时
        expect(document.querySelector('[data-name="drawer-group-panel"]')).toBeNull()
    })

    it('判别力：删掉 beginDrag 的 query 短路会让搜索态拖拽进入拖拽态（红/绿实验已证）', () => {
        renderDrawer('ws')
        const topRow = document.querySelector('[data-name="top-project-row"]') as HTMLElement
        expect(topRow).toBeTruthy()
        // 变异：临时删除 ProjectGroupDrawer.tsx beginDrag 首行 `if (query) return`
        // 该用例应捕获搜索态行 pointerDown + 越过 4px 阈值的 pointerMove 后，拖拽态被激活
        // （可观测后果：拖拽跟手预览 portal 挂载 + document.body.userSelect 被锁定为 none）
        fireEvent.pointerDown(topRow, {clientX: 0, clientY: 0, button: 0})
        fireEvent.pointerMove(window, {clientX: 40, clientY: 40})
        // 判别力断言：短路在位时，搜索态下手势不会激活拖拽态
        expect(document.querySelector('[data-name="drawer-drag-ghost"]')).toBeNull()
        expect(document.body.style.userSelect).toBe('')
        // 补一次 pointerUp 走完流程 —— 组结构保持不变
        fireEvent.pointerUp(window, {clientX: 40, clientY: 40})
        expectNoWrites()
        expect(groupState.groups[0].members.map((m) => m.projectPath))
            .toEqual(['/ws/fe-1', '/ws/fe-2', '/ws/fe-3'])
    })
})
