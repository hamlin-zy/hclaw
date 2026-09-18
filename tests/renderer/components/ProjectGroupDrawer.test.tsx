// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {act, render, screen, fireEvent, waitFor} from '@testing-library/react'

const groupState = {
    groups: [
        {id: 'pg-a', name: '组A', sortOrder: 0, createdAt: 1, updatedAt: 1,
         members: [{projectPath: '/ws/a', groupOrder: 0}, {projectPath: '/ws/b', groupOrder: 1}]},
        {id: 'pg-empty', name: '空组', sortOrder: 1, createdAt: 1, updatedAt: 1, members: []},
    ],
    load: vi.fn(),
    create: vi.fn(),
    rename: vi.fn(),
    dissolve: vi.fn(),
    remove: vi.fn(),
    assign: vi.fn(),
    reorderGroups: vi.fn(),
    reorderProjects: vi.fn(),
}

vi.mock('../../../src/renderer/stores/projectGroupStore', () => ({
    useProjectGroupStore: (sel?: (s: typeof groupState) => unknown) => (sel ? sel(groupState) : groupState),
    projectGroupOf: () => null,
}))

const convState = {
    workspaces: {
        '/ws/a': {lastOpenedAt: 3, conversations: []},
        '/ws/b': {lastOpenedAt: 2, conversations: []},
        '/ws/c': {lastOpenedAt: 1, conversations: []},
    } as Record<string, {lastOpenedAt: number; conversations: unknown[]}>,
    currentWorkspacePath: '/ws/a',
    viewScope: {type: 'group', groupId: 'pg-a'} as any,
    setWorkspace: vi.fn(),
    setProjectGroupView: vi.fn(),
    focusProjectSegment: vi.fn(),
    removeWorkspace: vi.fn(),
    ensureWorkspaceRegistered: vi.fn(async (): Promise<string | null> => '/ws/new'),
}

vi.mock('../../../src/renderer/stores/conversationStore', () => ({
    useConversationStore: (sel?: (s: typeof convState) => unknown) => (sel ? sel(convState) : convState),
}))

/**
 * confirm 的 mock 会顺手把 `onConfirm` 跑掉：D5 的「移除项目」按钮走的是
 * `confirm({onConfirm})`（不是 `await confirm()` 的布尔返回），只 resolve 不执行 onConfirm
 * 的话断言不到 removeWorkspace。
 */
const confirmMock = vi.hoisted(() => vi.fn(async (options?: {onConfirm?: () => unknown}) => {
    await options?.onConfirm?.()
    return true
}))
vi.mock('../../../src/renderer/components/ConfirmDialog', () => ({confirm: confirmMock}))

import {MIN_PANEL_HEIGHT, PANEL_WIDTH, ProjectGroupDrawer} from '../../../src/renderer/components/ProjectGroupDrawer'

/**
 * 用真实 ref 渲染：二级面板的定位要读 `drawerRef.current` 的矩形，
 * `{current: null}` 会让面板永远打不开（而不是"开在原点"这种可容忍的偏差）。
 */
function renderDrawer(onClose: () => void = () => {}) {
    const drawerRef = {current: null as HTMLDivElement | null}
    const utils = render(
        <ProjectGroupDrawer
            drawerRef={drawerRef}
            search=""
            setSearch={() => {}}
            onClose={onClose}
        />,
    )
    return {drawerRef, ...utils}
}

/** 展开某组的二级面板，返回面板根节点（120ms 延时由 waitFor 吸收，不真等） */
async function openPanel(groupName = '组A'): Promise<HTMLElement> {
    fireEvent.mouseEnter(screen.getByText(groupName))
    await waitFor(() => expect(document.querySelector('[data-name="drawer-group-panel"]')).toBeTruthy())
    return document.querySelector('[data-name="drawer-group-panel"]') as HTMLElement
}

function panelMember(index: number): HTMLElement {
    return document.querySelector(`[data-name="drawer-group-member-${index}"]`) as HTMLElement
}

/** 成员行主体（＝那个可聚焦的 `<button>`）：行容器本身不再是交互元素（见面板根的 ARIA 口径） */
function panelMemberOpen(index: number): HTMLElement {
    return document.querySelector(`[data-name="drawer-group-member-open-${index}"]`) as HTMLElement
}

beforeEach(() => {
    vi.clearAllMocks()
    ;(window as any).electronAPI = {
        openFolderDialog: vi.fn(async () => null),
        openPath: vi.fn(),
    }
    convState.viewScope = {type: 'group', groupId: 'pg-a'}
    convState.currentWorkspacePath = '/ws/a'
})
afterEach(() => { delete (window as any).electronAPI })

describe('ProjectGroupDrawer — 结构（层 1）', () => {
    it('aria-label 为「项目列表」，搜索占位为「搜索项目…」', () => {
        renderDrawer()
        expect(screen.getByRole('listbox', {name: '项目列表'})).toBeTruthy()
        expect(screen.getByPlaceholderText('搜索项目…')).toBeTruthy()
    })

    it('顶部「添加项目」「创建项目组」仍在；层 1 组块内不再有「添加项目」（D1）', () => {
        renderDrawer()
        expect(screen.getByText('添加项目')).toBeTruthy()
        expect(screen.getByText('创建项目组')).toBeTruthy()
        expect(document.querySelector('[data-name^="drawer-group-add-"]')).toBeNull()
    })

    it('组区在未分组项目区之前（DOM 顺序）', () => {
        const {container} = renderDrawer()
        const html = container.innerHTML
        expect(html.indexOf('组A')).toBeLessThan(html.indexOf('drawer-top-project'))
    })

    it('组区与未分组区之间有分隔线（D3）：role=separator，位置在两个区之间，且不参与拖拽', () => {
        const {container} = renderDrawer()
        const html = container.innerHTML
        const divider = document.querySelector('[data-name="drawer-section-divider"]')
        expect(divider).toBeTruthy()
        expect(divider?.getAttribute('role')).toBe('separator')
        expect(divider?.hasAttribute('data-drag-row')).toBe(false)
        expect(html.indexOf('drawer-group-pg-empty')).toBeLessThan(html.indexOf('drawer-section-divider'))
        expect(html.indexOf('drawer-section-divider')).toBeLessThan(html.indexOf('drawer-top-project-0'))
    })

    it('分隔线三态：仅组 / 仅项目都不渲染，两侧都有才渲染', () => {
        // 两侧都有（默认夹具）
        const both = renderDrawer()
        expect(document.querySelector('[data-name="drawer-section-divider"]')).toBeTruthy()
        expect(document.querySelector('[data-name="drawer-top-project-0"]')).toBeTruthy()
        both.unmount()

        // 仅组：/ws/c 也归组 → 未分组区为空
        const savedWorkspaces = convState.workspaces
        convState.workspaces = {
            '/ws/a': {lastOpenedAt: 3, conversations: []},
            '/ws/b': {lastOpenedAt: 2, conversations: []},
        }
        const groupsOnly = renderDrawer()
        expect(document.querySelector('[data-name="drawer-top-project-0"]')).toBeNull()
        expect(document.querySelector('[data-name="drawer-section-divider"]')).toBeNull()
        groupsOnly.unmount()
        convState.workspaces = savedWorkspaces

        // 仅项目：没有组 → 没有"两个区"可言
        const savedGroups = groupState.groups
        groupState.groups = []
        const projectsOnly = renderDrawer()
        expect(document.querySelector('[data-name="drawer-group-pg-a"]')).toBeNull()
        expect(document.querySelector('[data-name="drawer-top-project-0"]')).toBeTruthy()
        expect(document.querySelector('[data-name="drawer-section-divider"]')).toBeNull()
        projectsOnly.unmount()
        groupState.groups = savedGroups
    })

    it('组图标与项目图标不是同一形状（D2：组=Folders，项目=单文件夹轮廓），且层 1 与面板同口径', async () => {
        // data-name 规范要求全局唯一 → 层 1 与面板是四个名字；"是不是同一个形状"用 path 的 d 比对
        const shapeOf = (name: string) => {
            const el = document.querySelector(`[data-name="${name}"]`)
            if (!el) throw new Error(`缺少图标 ${name}`)
            return [...el.querySelectorAll('path')].map((p) => p.getAttribute('d')).join('|')
        }

        renderDrawer()
        const groupIcon = shapeOf('drawer-group-icon')       // 层 1 组头
        const projectIcon = shapeOf('drawer-project-icon')   // 层 1 未分组行
        expect(groupIcon.length).toBeGreaterThan(0)
        expect(groupIcon).not.toBe(projectIcon)

        await openPanel()
        expect(shapeOf('drawer-panel-group-icon')).toBe(groupIcon)     // 面板头仍是"组"图标
        expect(shapeOf('drawer-panel-project-icon')).toBe(projectIcon) // 面板成员行仍是"项目"图标
    })
})

describe('ProjectGroupDrawer — 点击语义', () => {
    it('点组头 = setProjectGroupView（不改激活会话）', () => {
        renderDrawer()
        fireEvent.click(screen.getByText('组A'))
        expect(convState.setProjectGroupView).toHaveBeenCalledWith('pg-a')
    })

    it('面板头行（hover 展开后的组头）点击 = setProjectGroupView + onClose', async () => {
        const onClose = vi.fn()
        renderDrawer(onClose)
        await openPanel()
        fireEvent.click(document.querySelector('[data-name="drawer-group-panel-header-pg-a"]') as HTMLElement)
        expect(convState.setProjectGroupView).toHaveBeenCalledWith('pg-a')
        expect(onClose).toHaveBeenCalled()
    })

    it('面板成员行可点击 = setWorkspace + onClose（§16.2 推翻 D2「层 2 不可点」）', async () => {
        const onClose = vi.fn()
        renderDrawer(onClose)
        await openPanel()
        const row = panelMember(0)
        expect(row.getAttribute('aria-disabled')).toBeNull() // 不再是"禁用"的假行
        expect(panelMemberOpen(0).tagName).toBe('BUTTON') // 行主体是真正的控件（可 Tab / 可回车）
        fireEvent.click(panelMemberOpen(0))
        expect(convState.setWorkspace).toHaveBeenCalledWith('/ws/a')
        expect(onClose).toHaveBeenCalled()
    })

    it('面板成员行：当前作用域命中时高亮（与未分组行同款判定）', async () => {
        convState.viewScope = {type: 'project', path: '/ws/a'}
        const hit = renderDrawer()
        await openPanel()
        expect(panelMemberOpen(0).getAttribute('aria-current')).toBe('true')
        expect(panelMemberOpen(1).getAttribute('aria-current')).not.toBe('true')
        hit.unmount()

        convState.viewScope = {type: 'project', path: '/ws/c'} // /ws/c 不在组内 → 组内行全部不高亮
        renderDrawer()
        await openPanel()
        expect(panelMemberOpen(0).getAttribute('aria-current')).not.toBe('true')
    })

    it('面板成员行的 mousedown 不冒泡到 document（4）防回归：否则侧栏"点外部关抽屉"先关抽屉、随后 click 打空', async () => {
        const onClose = vi.fn()
        renderDrawer(onClose)
        await openPanel()
        const onDocMouseDown = vi.fn()
        document.addEventListener('mousedown', onDocMouseDown) // 复刻 ConversationSidebar 的 handleClickOutside
        fireEvent.mouseDown(panelMember(0))
        document.removeEventListener('mousedown', onDocMouseDown)
        expect(onDocMouseDown).not.toHaveBeenCalled()
        expect(onClose).not.toHaveBeenCalled()
    })

    it('面板成员行 hover 按钮：在文件管理器中打开 → openPath；移除项目 → confirm 后 removeWorkspace', async () => {
        renderDrawer()
        await openPanel()
        const openBtn = document.querySelector('[data-name="drawer-member-open-in-explorer-button"]') as HTMLElement
        const removeBtn = document.querySelector('[data-name="drawer-member-remove-button"]') as HTMLElement
        expect(openBtn.getAttribute('aria-label')).toBe('在文件管理器中打开')
        expect(removeBtn.getAttribute('aria-label')).toBe('移除项目')
        expect(openBtn.className).toContain('opacity-0') // 与未分组行同构：hover 才显形

        fireEvent.click(openBtn)
        expect((window as any).electronAPI.openPath).toHaveBeenCalledWith('/ws/a')
        expect(convState.setWorkspace).not.toHaveBeenCalled() // 点按钮不等于点行

        fireEvent.click(removeBtn)
        expect(confirmMock).toHaveBeenCalled()
        await waitFor(() => expect(convState.removeWorkspace).toHaveBeenCalledWith('/ws/a'))
        expect(convState.setWorkspace).not.toHaveBeenCalled()
    })

    it('顶层项目行可点击 = setWorkspace', () => {
        renderDrawer()
        const row = document.querySelector('[data-name="drawer-top-project-0"]') as HTMLElement
        fireEvent.click(row)
        expect(convState.setWorkspace).toHaveBeenCalledWith('/ws/c')
    })

    it('空组显示「还没有项目」提示（指向悬浮面板）', () => {
        renderDrawer()
        expect(screen.getByText(/还没有项目，鼠标移入可添加或拖入项目/)).toBeTruthy()
    })

    it('当前作用域高亮：组头 aria-selected=true；未分组区仅高亮「当前所在项目」', () => {
        const first = renderDrawer()
        expect(screen.getByText('组A').closest('[role="option"]')?.getAttribute('aria-selected')).toBe('true')
        first.unmount()

        // 已归组的项目（/ws/a ∈ pg-a）不在未分组区 → 未分组区不得有任何行被选中
        convState.viewScope = {type: 'project', path: '/ws/a'}
        const second = renderDrawer()
        const groupedScopeRow = document.querySelector('[data-name="drawer-top-project-0"]')
        expect(groupedScopeRow).toBeTruthy()
        expect(groupedScopeRow?.getAttribute('aria-selected')).not.toBe('true')
        second.unmount()

        // /ws/c 是夹具里唯一的未分组项目 → 切到它时该行选中
        convState.viewScope = {type: 'project', path: '/ws/c'}
        renderDrawer()
        expect(
            document.querySelector('[data-name="drawer-top-project-0"]')?.getAttribute('aria-selected'),
        ).toBe('true')
    })
})

describe('ProjectGroupDrawer — 添加项目 / 创建项目组', () => {
    it('顶部「添加项目」→ openFolderDialog → setWorkspace（落顶层）', async () => {
        ;(window as any).electronAPI.openFolderDialog = vi.fn(async () => '/ws/new')
        renderDrawer()
        fireEvent.click(screen.getByText('添加项目'))
        await waitFor(() => expect(convState.setWorkspace).toHaveBeenCalledWith('/ws/new'))
    })

    it('面板底部「添加项目」→ ensureWorkspaceRegistered + assign(生效键, groupId)，停留组视图', async () => {
        ;(window as any).electronAPI = {
            openFolderDialog: vi.fn(async () => '/ws/new'),
            openPath: vi.fn(),
        }
        convState.ensureWorkspaceRegistered.mockResolvedValueOnce('/ws/canonical')
        renderDrawer()
        await openPanel()
        fireEvent.click(document.querySelector('[data-name="drawer-group-panel-add-pg-a"]') as HTMLElement)
        // 入组用的是登记返回的「生效键」，不是对话框给的原始串（否则同一项目会在组内 + 未分组区各出现一次）
        await waitFor(() => expect(groupState.assign).toHaveBeenCalledWith('/ws/canonical', 'pg-a'))
        expect(convState.ensureWorkspaceRegistered).toHaveBeenCalledWith('/ws/new')
        expect(convState.setWorkspace).not.toHaveBeenCalled()
        expect(convState.setProjectGroupView).not.toHaveBeenCalled()
    })

    it('面板底部「添加项目」成功后 → focusProjectSegment(生效键)（停留组视图 + 定位该项目段，I-4）', async () => {
        ;(window as any).electronAPI = {
            openFolderDialog: vi.fn(async () => '/ws/new'),
            openPath: vi.fn(),
        }
        convState.ensureWorkspaceRegistered.mockResolvedValueOnce('/ws/canonical')
        renderDrawer()
        await openPanel()
        fireEvent.click(document.querySelector('[data-name="drawer-group-panel-add-pg-a"]') as HTMLElement)
        await waitFor(() => expect(convState.focusProjectSegment).toHaveBeenCalledWith('/ws/canonical'))
        // 定位而不跟随：不切项目视图、不切当前工作区
        expect(convState.setProjectGroupView).not.toHaveBeenCalled()
        expect(convState.setWorkspace).not.toHaveBeenCalled()
    })

    it('面板底部「添加项目」登记未能确认（返回 null）→ 不入组', async () => {
        ;(window as any).electronAPI = {
            openFolderDialog: vi.fn(async () => '/ws/new'),
            openPath: vi.fn(),
        }
        convState.ensureWorkspaceRegistered.mockResolvedValueOnce(null)
        renderDrawer()
        await openPanel()
        fireEvent.click(document.querySelector('[data-name="drawer-group-panel-add-pg-a"]') as HTMLElement)
        await waitFor(() => expect(convState.ensureWorkspaceRegistered).toHaveBeenCalledWith('/ws/new'))
        expect(groupState.assign).not.toHaveBeenCalled()
    })

    it('空组的面板也有「添加项目」入口（拖不动的时候还能点）', async () => {
        renderDrawer()
        await openPanel('空组')
        expect(document.querySelector('[data-name="drawer-group-panel-add-pg-empty"]')).toBeTruthy()
    })

    it('「创建项目组」内联输入 → create(name)', async () => {
        renderDrawer()
        fireEvent.click(screen.getByText('创建项目组'))
        fireEvent.change(screen.getByPlaceholderText('项目组名称'), {target: {value: '  新组  '}})
        fireEvent.keyDown(screen.getByPlaceholderText('项目组名称'), {key: 'Enter'})
        await waitFor(() => expect(groupState.create).toHaveBeenCalledWith('新组'))
    })

    it('创建输入中按 Esc → 取消输入（不 create，抽屉不关、不调 onClose）', () => {
        const onClose = vi.fn()
        renderDrawer(onClose)
        fireEvent.click(screen.getByText('创建项目组'))
        fireEvent.change(screen.getByPlaceholderText('项目组名称'), {target: {value: '新组'}})
        fireEvent.keyDown(screen.getByPlaceholderText('项目组名称'), {key: 'Escape'})
        expect(groupState.create).not.toHaveBeenCalled()
        // (a) 取消真的发生了：内联输入框消失
        expect(screen.queryByPlaceholderText('项目组名称')).toBeNull()
        // (b) 抽屉仍在，且没有通知调用方关闭
        expect(screen.getByRole('listbox', {name: '项目列表'})).toBeTruthy()
        expect(onClose).not.toHaveBeenCalled()
    })
})

describe('ProjectGroupDrawer — 二级面板的开关（§16.2）', () => {
    it('hover 组头 → 面板出现并列出该组成员（组名 + 成员数）', async () => {
        renderDrawer()
        const panel = await openPanel()
        // 面板根是 dialog（不是 listbox）：里面既有成员行又有面板头/添加项目等独立控件，
        // 而 listbox 只允许 option 作直接子节点。详见组件内面板根的 ARIA 口径说明。
        expect(panel.getAttribute('role')).toBe('dialog')
        expect(panel.getAttribute('aria-label')).toBe('项目组 组A')
        expect(panel.textContent).toContain('组A')
        expect(panel.textContent).toContain('2 个项目')
        expect(panelMember(0).textContent).toContain('/ws/a')
        expect(panelMember(1).textContent).toContain('/ws/b')
    })

    it('同一时刻最多一个面板：hover 另一个组头后只留后者的面板', async () => {
        renderDrawer()
        await openPanel('组A')
        fireEvent.mouseEnter(screen.getByText('空组'))
        await waitFor(() => expect(
            document.querySelector('[data-name="drawer-group-panel"]')?.getAttribute('aria-label'),
        ).toBe('项目组 空组')) // 等的是"换成了新面板"，不是"面板还在"（旧面板会让 waitFor 立刻通过）
        expect(document.querySelectorAll('[data-name="drawer-group-panel"]')).toHaveLength(1)
    })

    it('面板定位：贴抽屉右缘 8px / 顶端对齐组头 / 高度吃满视口；越界时改为贴视口右侧', async () => {
        const rect = (box: {left: number; right: number; top: number}) => ({
            ...box, bottom: box.top + 40, width: box.right - box.left, height: 40,
            x: box.left, y: box.top, toJSON: () => ({}),
        }) as unknown as DOMRect
        const PANEL_W = PANEL_WIDTH
        expect(PANEL_W).toBeGreaterThanOrEqual(260) // 常量在 260~280 区间（定位公式依赖它）
        expect(PANEL_W).toBeLessThanOrEqual(280)

        let drawerRight = 300
        const rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
            if (this.getAttribute('data-name') === 'project-group-drawer') {
                return rect({left: drawerRight - 300, right: drawerRight, top: 0})
            }
            if (this.getAttribute('data-name') === 'drawer-group-header-pg-a') {
                return rect({left: 0, right: 300, top: 50})
            }
            return rect({left: 0, right: 0, top: 0})
        })
        try {
            const first = renderDrawer()
            const panel = await openPanel()
            expect(panel.style.left).toBe('308px') // 抽屉右缘 300 + 8
            expect(panel.style.top).toBe('50px') // 组头顶边
            expect(panel.style.maxHeight).toBe(`${window.innerHeight - 50 - 12}px`)
            first.unmount()

            // 抽屉贴到视口右边缘时，面板改为贴视口右侧（否则会被挤出屏幕）
            drawerRight = window.innerWidth + 500
            renderDrawer()
            const clamped = await openPanel()
            expect(clamped.style.left).toBe(`${window.innerWidth - PANEL_W - 8}px`)
        } finally {
            rectSpy.mockRestore()
        }
    })

    it('面板不在抽屉根节点内（portal 到 body），且阻止了 mousedown 冒泡', async () => {
        const {drawerRef} = renderDrawer()
        const panel = await openPanel()
        expect(drawerRef.current?.contains(panel)).toBe(false)
        expect(panel.parentElement).toBe(document.body)
    })
})

/** 组头（层 1）：面板的唯一入口 */
function groupHeader(id: string): HTMLElement {
    return document.querySelector(`[data-name="drawer-group-header-${id}"]`) as HTMLElement
}

const PANEL_SEL = '[data-name="drawer-group-panel"]'
const panelEl = () => document.querySelector(PANEL_SEL) as HTMLElement | null
const panelLabel = () => panelEl()?.getAttribute('aria-label') ?? null

describe('ProjectGroupDrawer — 面板几何钳制（矩形必须落在视口内）', () => {
    const rect = (box: {left: number; right: number; top: number}) => ({
        ...box, bottom: box.top + 40, width: box.right - box.left, height: 40,
        x: box.left, y: box.top, toJSON: () => ({}),
    }) as unknown as DOMRect

    /** 只替抽屉根与组头两个矩形：面板几何的全部输入就是这两个 */
    function stubRects(drawer: {left: number; right: number; top: number}, headerTop: number) {
        return vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
            if (this.getAttribute('data-name') === 'project-group-drawer') return rect(drawer)
            if (this.getAttribute('data-name') === 'drawer-group-header-pg-a') return rect({left: 0, right: 300, top: headerTop})
            return rect({left: 0, right: 0, top: 0})
        })
    }

    it('组头贴近视口底部 → top 上移，面板矩形完整落在视口内（末尾行可达）', async () => {
        const headerTop = window.innerHeight - 20 // 贴底：不钳的话 maxHeight ≈ 8px，底部行全都够不着
        const rectSpy = stubRects({left: 0, right: 300, top: 0}, headerTop)
        try {
            renderDrawer()
            const panel = await openPanel()
            const top = Number.parseFloat(panel.style.top)
            const maxHeight = Number.parseFloat(panel.style.maxHeight)
            expect(top).toBe(window.innerHeight - MIN_PANEL_HEIGHT - 12)
            expect(top).toBeLessThan(headerTop) // 顶边确实上移了（面板"长"上去了）
            expect(maxHeight).toBeGreaterThanOrEqual(MIN_PANEL_HEIGHT)
            expect(top + maxHeight).toBeLessThanOrEqual(window.innerHeight) // 底边不越出视口
            expect(top).toBeGreaterThanOrEqual(0)
        } finally {
            rectSpy.mockRestore()
        }
    })

    it('窄窗口（innerWidth < 面板宽 + 两侧留白）→ left 不为负，钳到 8', async () => {
        const prevWidth = window.innerWidth
        Object.defineProperty(window, 'innerWidth', {value: PANEL_WIDTH + 8, configurable: true}) // 越界项算出来是 0
        const rectSpy = stubRects({left: 0, right: 300, top: 0}, 50)
        try {
            renderDrawer()
            const panel = await openPanel()
            const left = Number.parseFloat(panel.style.left)
            expect(left).toBeGreaterThanOrEqual(8) // 不钳的话会是负值：面板有一半在屏幕左侧外
            expect(left + PANEL_WIDTH).toBeLessThanOrEqual(window.innerWidth)
        } finally {
            rectSpy.mockRestore()
            Object.defineProperty(window, 'innerWidth', {value: prevWidth, configurable: true})
        }
    })
})

describe('ProjectGroupDrawer — 键盘 / AT 可达性（面板入口只有一个，必须能 Tab 到）', () => {
    it('组头可聚焦（tabIndex=0）；焦点进入立即开面板（键盘用户没有 hover，不吃 120ms 延时）', () => {
        renderDrawer()
        const header = groupHeader('pg-a')
        expect(header.getAttribute('tabindex')).toBe('0')
        fireEvent.focus(header)
        // 不用 waitFor：延时打开的话这一刻面板还不存在（fireEvent 已在 act 内提交完状态）
        expect(panelLabel()).toBe('项目组 组A')
    })

    it('焦点移出组头且不在面板内 → 走宽限期（不是立刻关，也不是不关）', async () => {
        renderDrawer()
        fireEvent.focus(groupHeader('pg-a'))
        fireEvent.blur(groupHeader('pg-a'), {relatedTarget: null})
        expect(panelEl()).toBeTruthy() // 宽限期内仍在：给"焦点落进面板"留出时间
        await waitFor(() => expect(panelEl()).toBeNull())
    })

    it('焦点从组头移进面板 → 不关（onBlur 的"不在面板内"分支）', async () => {
        renderDrawer()
        fireEvent.focus(groupHeader('pg-a'))
        fireEvent.blur(groupHeader('pg-a'), {relatedTarget: panelEl()})
        await new Promise((r) => setTimeout(r, 260)) // 超过 200ms 宽限
        expect(panelEl()).toBeTruthy()
    })

    it('面板内交互元素全是原生按钮（可 Tab、可回车）：面板头 / 成员行 / 两个 hover 按钮 / 添加项目', async () => {
        renderDrawer()
        fireEvent.focus(groupHeader('pg-a'))
        const names = [
            'drawer-group-panel-header-pg-a', 'drawer-group-member-open-0',
            'drawer-member-open-in-explorer-button', 'drawer-member-remove-button',
            'drawer-group-panel-add-pg-a',
        ]
        for (const name of names) {
            const el = document.querySelector(`[data-name="${name}"]`) as HTMLButtonElement | null
            expect(el?.tagName, name).toBe('BUTTON')
            expect(el?.disabled, name).toBe(false)
            // tabindex="-1" 才是"Tab 不到"：原生按钮的默认可聚焦性靠 tabindex 属性缺席来保证
            expect(el?.getAttribute('tabindex'), name).toBeNull()
        }
    })

    it('hover 按钮键盘聚焦时可见（group-focus-within）——「可 Tab 但看不见」也算不可达', async () => {
        renderDrawer()
        fireEvent.focus(groupHeader('pg-a'))
        const openBtn = document.querySelector('[data-name="drawer-member-open-in-explorer-button"]') as HTMLElement
        const removeBtn = document.querySelector('[data-name="drawer-member-remove-button"]') as HTMLElement
        expect(openBtn.className).toContain('group-focus-within:opacity-100')
        expect(removeBtn.className).toContain('group-focus-within:opacity-100')
        // 行主体在同一个 .group 里 → 焦点落在按钮上时 :focus-within 成立（浏览器里两个按钮一起显形）
        expect(openBtn.closest('.group')).toBe(document.querySelector('[data-name="drawer-group-member-0"]'))
    })

    it('面板内按 Esc → 只关面板、焦点回组头，且不冒泡到 document（侧栏的「Esc 关抽屉」）', async () => {
        const onClose = vi.fn()
        renderDrawer(onClose)
        fireEvent.focus(groupHeader('pg-a'))
        const add = document.querySelector('[data-name="drawer-group-panel-add-pg-a"]') as HTMLElement
        add.focus()
        expect(document.activeElement).toBe(add)

        const onDocKeyDown = vi.fn()
        document.addEventListener('keydown', onDocKeyDown) // 复刻 ConversationSidebar 的全局 Esc（冒泡阶段）
        fireEvent.keyDown(add, {key: 'Escape'})
        document.removeEventListener('keydown', onDocKeyDown)

        expect(panelEl()).toBeNull()
        expect(document.activeElement).toBe(groupHeader('pg-a')) // 焦点不能掉到 body（否则键盘用户丢了位置）
        expect(onDocKeyDown).not.toHaveBeenCalled()
        expect(onClose).not.toHaveBeenCalled() // 抽屉不跟着关
        // 焦点回还本身不能再把面板弹回来（Esc 的意图就是关掉它）
        await new Promise((r) => setTimeout(r, 0))
        expect(panelEl()).toBeNull()
    })

    it('原地重命名时不弹面板（鼠标停在组头上 / 焦点在重命名输入框里）', async () => {
        renderDrawer()
        fireEvent.contextMenu(groupHeader('pg-a'))
        fireEvent.click(document.querySelector('[data-name="drawer-group-menu-rename-button"]') as HTMLElement)
        const input = document.querySelector('[data-name="drawer-group-rename-input"]') as HTMLElement
        expect(input).toBeTruthy()

        fireEvent.focus(input) // 焦点进入组头（输入框在组头里）
        fireEvent.mouseEnter(groupHeader('pg-a'))
        await act(async () => { await new Promise((r) => setTimeout(r, 160)) }) // 超过 120ms 打开延时
        expect(panelEl()).toBeNull()
    })

    it('从组头 A 移到组头 B → A 的面板立即收掉（不等宽限期：宽限期内它还是有效落点根）', async () => {
        renderDrawer()
        await openPanel('组A')
        expect(panelLabel()).toBe('项目组 组A')

        fireEvent.mouseEnter(screen.getByText('空组')) // 目标组不同 → 旧面板立刻收，进入 120ms 开新面板
        expect(panelEl()).toBeNull()
        await waitFor(() => expect(panelLabel()).toBe('项目组 空组'))
        expect(document.querySelectorAll(PANEL_SEL)).toHaveLength(1)
        expect(document.querySelector('[data-name="drawer-group-member-0"]')).toBeNull() // A 的成员行（落点行）已不在 DOM
    })
})

describe('ProjectGroupDrawer — 搜索态命中成员内联渲染（§6.1 回归修复）', () => {
    it('search 命中组成员 → 层 1 组头下方内联出现该成员行且可点击切换', () => {
        const onClose = vi.fn()
        const drawerRef = {current: null as HTMLDivElement | null}
        render(
            <ProjectGroupDrawer drawerRef={drawerRef} search="b" setSearch={() => {}} onClose={onClose}/>,
        )
        // /ws/b 的 basename = 'b'，命中 search='b'
        const memberRow = document.querySelector('[data-name="drawer-search-member-pg-a-0"]')
        expect(memberRow).toBeTruthy()
        expect(memberRow?.textContent).toContain('/ws/b')

        // 可点击 = setWorkspace + onClose（搜索是查找+切换场景，不可点等于无用）
        const openBtn = document.querySelector('[data-name="drawer-search-member-open-pg-a-0"]') as HTMLElement
        expect(openBtn.tagName).toBe('BUTTON')
        fireEvent.click(openBtn)
        expect(convState.setWorkspace).toHaveBeenCalledWith('/ws/b')
        expect(onClose).toHaveBeenCalled()
    })

    it('search 命中组名但成员未命中 → 不渲染空组占位「还没有项目」，改显「无匹配成员」', () => {
        const drawerRef = {current: null as HTMLDivElement | null}
        render(
            <ProjectGroupDrawer drawerRef={drawerRef} search="组" setSearch={() => {}} onClose={() => {}}/>,
        )
        // 组名「组A」「空组」均命中 search='组' → 组名匹配时保留全部成员
        // 空组无成员 → 应显示「无匹配成员」而非「还没有项目，鼠标移入可添加或拖入项目」
        const emptyHint = document.querySelector('[data-name="drawer-group-empty-pg-empty"]')
        expect(emptyHint).toBeTruthy()
        expect(emptyHint?.textContent).toBe('无匹配成员')
        expect(emptyHint?.textContent).not.toContain('还没有项目')
    })

    it('搜索态不打开 hover 面板（成员已内联在层 1）', async () => {
        const drawerRef = {current: null as HTMLDivElement | null}
        render(
            <ProjectGroupDrawer drawerRef={drawerRef} search="b" setSearch={() => {}} onClose={() => {}}/>,
        )
        fireEvent.mouseEnter(screen.getByText('组A'))
        await act(async () => { await new Promise((r) => setTimeout(r, 160)) }) // 超过 120ms 打开延时
        expect(document.querySelector('[data-name="drawer-group-panel"]')).toBeNull()
    })

    it('非搜索态层 1 仍无成员行（防回归）', () => {
        const drawerRef = {current: null as HTMLDivElement | null}
        render(
            <ProjectGroupDrawer drawerRef={drawerRef} search="" setSearch={() => {}} onClose={() => {}}/>,
        )
        // 非搜索态成员只在 hover 面板里，层 1 不渲染成员行
        expect(document.querySelector('[data-name^="drawer-search-member-"]')).toBeNull()
    })
})
