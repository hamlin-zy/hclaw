// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, waitFor} from '@testing-library/react'

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

import {ProjectGroupDrawer, MIN_PANEL_HEIGHT, PANEL_WIDTH} from '../../../src/renderer/components/ProjectGroupDrawer'

function renderDrawer(onClose: () => void = () => {}) {
    const drawerRef = {current: null as HTMLDivElement | null}
    return {drawerRef, ...render(
        <ProjectGroupDrawer
            drawerRef={drawerRef}
            search=""
            setSearch={() => {}}
            onClose={onClose}
        />,
    )}
}

/** 组头行（层 1）：data-name 契约 + data-group-id 定位 */
function groupHeader(id: string): HTMLElement {
    return document.querySelector(`[data-name="group-block-header"][data-group-id="${id}"]`) as HTMLElement
}

/** 二级面板根（portal 到 body）：data-name="drawer-group-panel" */
function panel(): HTMLElement | null {
    return document.querySelector('[data-name="drawer-group-panel"]') as HTMLElement | null
}

/**
 * 用**焦点路径**开面板：组头 onFocus = 立即开（D4），同步可得，避开 hover 的 120ms 延时。
 * 只关心"面板已开"的用例走这条路；hover 延时/宽限本身有专测。
 */
function openPanelByFocus(groupId: string) {
    fireEvent.focus(groupHeader(groupId))
    if (!panel()) throw new Error(`焦点进组头后未打开面板：${groupId}`)
}

/** 面板成员行容器 / 行主体（＝那个可聚焦的 `<button>`）；面板同时只有一个 → index 即可定位 */
function memberRow(index: number): HTMLElement | null {
    return document.querySelector(`[data-name="drawer-group-member-${index}"]`) as HTMLElement | null
}
function memberOpen(index: number): HTMLElement {
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

describe('ProjectGroupDrawer — 结构（层 1 组头 + 层 2 面板）', () => {
    it('aria-label 为「项目列表」，搜索占位为「搜索项目…」', () => {
        renderDrawer()
        expect(screen.getByRole('listbox', {name: '项目列表'})).toBeTruthy()
        expect(screen.getByPlaceholderText('搜索项目…')).toBeTruthy()
    })

    it('顶部「添加项目」「创建项目组」仍在；组头行不再有旧「添加项目」槽位（D1）', () => {
        renderDrawer()
        expect(screen.getByText('添加项目')).toBeTruthy()
        expect(screen.getByText('创建项目组')).toBeTruthy()
        expect(document.querySelector('[data-name^="drawer-group-add-"]')).toBeNull()
    })

    it('组区在未分组项目区之前（DOM 顺序）', () => {
        const {container} = renderDrawer()
        const html = container.innerHTML
        expect(html.indexOf('group-block-header')).toBeLessThan(html.indexOf('top-project-row'))
    })

    it('组区与未分组区之间有分隔线（D3）：role=separator，位置在两个区之间，且不参与拖拽', () => {
        const {container} = renderDrawer()
        const html = container.innerHTML
        const divider = document.querySelector('[data-name="drawer-section-divider"]')
        expect(divider).toBeTruthy()
        expect(divider?.getAttribute('role')).toBe('separator')
        expect(divider?.hasAttribute('data-drag-row')).toBe(false)
        expect(html.indexOf('data-group-id="pg-empty"')).toBeLessThan(html.indexOf('drawer-section-divider'))
        expect(html.indexOf('drawer-section-divider')).toBeLessThan(html.indexOf('top-project-row'))
    })

    it('分隔线三态：仅组 / 仅项目都不渲染，两侧都有才渲染', () => {
        // 两侧都有（默认夹具）
        const both = renderDrawer()
        expect(document.querySelector('[data-name="drawer-section-divider"]')).toBeTruthy()
        expect(document.querySelector('[data-name="top-project-row"]')).toBeTruthy()
        both.unmount()

        // 仅组：/ws/c 也归组 → 未分组区为空
        const savedWorkspaces = convState.workspaces
        convState.workspaces = {
            '/ws/a': {lastOpenedAt: 3, conversations: []},
            '/ws/b': {lastOpenedAt: 2, conversations: []},
        }
        const groupsOnly = renderDrawer()
        expect(document.querySelector('[data-name="top-project-row"]')).toBeNull()
        expect(document.querySelector('[data-name="drawer-section-divider"]')).toBeNull()
        groupsOnly.unmount()
        convState.workspaces = savedWorkspaces

        // 仅项目：没有组 → 没有"两个区"可言
        const savedGroups = groupState.groups
        groupState.groups = []
        const projectsOnly = renderDrawer()
        expect(document.querySelector('[data-name="group-block-header"]')).toBeNull()
        expect(document.querySelector('[data-name="top-project-row"]')).toBeTruthy()
        expect(document.querySelector('[data-name="drawer-section-divider"]')).toBeNull()
        projectsOnly.unmount()
        groupState.groups = savedGroups
    })

    it('组图标与项目图标不是同一形状（D2：组=Folders，项目=单文件夹轮廓）', () => {
        const shapeOf = (name: string) => {
            const el = document.querySelector(`[data-name="${name}"]`)
            if (!el) throw new Error(`缺少图标 ${name}`)
            return [...el.querySelectorAll('path')].map((p) => p.getAttribute('d')).join('|')
        }

        renderDrawer()
        const groupIcon = shapeOf('drawer-group-icon')       // 组头
        const projectIcon = shapeOf('drawer-project-icon')   // 未分组行
        expect(groupIcon.length).toBeGreaterThan(0)
        expect(groupIcon).not.toBe(projectIcon)
    })

    it('组头携带成员计数（「n 个项目」）；aria-expanded 随内联树一并退场', () => {
        renderDrawer()
        expect(groupHeader('pg-a').textContent).toContain('2 个项目')
        expect(groupHeader('pg-a').getAttribute('aria-expanded')).toBeNull()
        // 面板开着也不改变层 1 组头的语义（面板是独立 dialog，不是组头的展开内容）
        openPanelByFocus('pg-a')
        expect(groupHeader('pg-a').getAttribute('aria-expanded')).toBeNull()
    })

    it('常态：组头之下无内联成员区（成员只在二级面板里）', () => {
        renderDrawer()
        expect(document.querySelector('[data-name="group-member-list"]')).toBeNull()
        expect(document.querySelector('[data-name="group-member-row"]')).toBeNull()
        expect(document.querySelector('[data-name="group-toggle"]')).toBeNull() // chevron 同退场
    })

    it('hover 组头 120ms 后浮出二级面板（含成员行）；无 hover 时面板不存在', async () => {
        renderDrawer()
        expect(panel()).toBeNull()
        fireEvent.mouseEnter(groupHeader('pg-a'))
        // 延时窗口内不开：鼠标扫过组头不该弹面板
        await new Promise((resolve) => setTimeout(resolve, 40))
        expect(panel()).toBeNull()
        await waitFor(() => expect(panel()).toBeTruthy())
        expect(document.querySelector('[data-name="drawer-group-member-0"]')).toBeTruthy()
    })

    it('离开组头 → 200ms 宽限后关闭（宽限期内仍在：够用户从组头移到面板）', async () => {
        renderDrawer()
        openPanelByFocus('pg-a')
        fireEvent.mouseLeave(groupHeader('pg-a'))
        await new Promise((resolve) => setTimeout(resolve, 60))
        expect(panel()).toBeTruthy()
        await waitFor(() => expect(panel()).toBeNull())
    })

    it('焦点进组头立即开面板（D4：不等延时）；切到别的组头立即收掉旧面板', () => {
        renderDrawer()
        openPanelByFocus('pg-a')
        expect(panel()?.getAttribute('aria-label')).toBe('项目组 组A')
        // 切到另一个组头：宽限期内旧面板仍是有效落点根 → 必须立即收掉
        fireEvent.mouseEnter(groupHeader('pg-empty'))
        expect(panel()).toBeNull()
    })

    it('面板不跨抽屉开合保持：卸载重开后面板回归关闭（面板是组件内 state）', () => {
        const first = renderDrawer()
        openPanelByFocus('pg-a')
        expect(panel()).toBeTruthy()
        first.unmount()
        renderDrawer()
        expect(panel()).toBeNull()
    })

    it('面板几何双向钳制：组头贴底时 top 上移、maxHeight 不低于最小高度；窄窗口下左缘不越界', () => {
        const savedHeight = window.innerHeight
        const savedWidth = window.innerWidth
        Object.defineProperty(window, 'innerHeight', {configurable: true, value: 300})
        Object.defineProperty(window, 'innerWidth', {configurable: true, value: 200})
        const rect = (top: number, bottom: number, left: number, right: number) => ({
            top, bottom, left, right, width: right - left, height: bottom - top, x: left, y: top,
            toJSON: () => ({}),
        }) as DOMRect
        const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
            const el = this as HTMLElement
            if (el.getAttribute('data-name') === 'project-group-drawer') return rect(0, 300, 0, 100) // 抽屉右缘 100
            if (el.getAttribute('data-name') === 'group-block-header') return rect(290, 300, 0, 100) // 组头贴视口底部
            return rect(0, 0, 0, 0)
        })
        try {
            renderDrawer()
            openPanelByFocus('pg-a')
            const style = panel()!.style
            // top 先上钳：min(组头顶边 290, innerHeight - MIN_PANEL_HEIGHT - 12) = 168
            expect(style.top).toBe(`${300 - MIN_PANEL_HEIGHT - 12}px`)
            // maxHeight 按**钳后**的 top 算，且不低于最小值：max(120, 300 - 168 - 12) = 120
            expect(style.maxHeight).toBe(`${MIN_PANEL_HEIGHT}px`)
            // left 夹到 8：innerWidth - PANEL_WIDTH - 8 = -72 为负 → 左侧缘仍可见
            expect(style.left).toBe('8px')
            expect(PANEL_WIDTH).toBeGreaterThan(window.innerWidth) // 该窗口下右侧注定越界（无解），至少左侧可见
        } finally {
            spy.mockRestore()
            Object.defineProperty(window, 'innerHeight', {configurable: true, value: savedHeight})
            Object.defineProperty(window, 'innerWidth', {configurable: true, value: savedWidth})
        }
    })

    it('行内重命名中 hover / 焦点进组头都不弹面板（面板会盖在输入框旁边）', () => {
        renderDrawer()
        fireEvent.contextMenu(groupHeader('pg-a'))
        fireEvent.click(document.querySelector('[data-name="drawer-group-menu-rename-button"]') as HTMLElement)
        expect(document.querySelector('[data-name="drawer-group-rename-input"]')).toBeTruthy()
        fireEvent.mouseEnter(groupHeader('pg-a'))
        fireEvent.focus(groupHeader('pg-a'))
        expect(panel()).toBeNull()
    })
})

describe('ProjectGroupDrawer — 点击语义', () => {
    it('点组头 = setProjectGroupView（不改激活会话）', () => {
        renderDrawer()
        fireEvent.click(groupHeader('pg-a'))
        expect(convState.setProjectGroupView).toHaveBeenCalledWith('pg-a')
    })

    it('面板成员行可点击 = setWorkspace + onClose（面板里可点即可切项目）', () => {
        const onClose = vi.fn()
        renderDrawer(onClose)
        openPanelByFocus('pg-a')
        expect(memberRow(0)?.getAttribute('aria-disabled')).toBeNull()
        expect(memberOpen(0).tagName).toBe('BUTTON') // 行主体是真正的控件（可 Tab / 可回车）
        fireEvent.click(memberOpen(0))
        expect(convState.setWorkspace).toHaveBeenCalledWith('/ws/a')
        expect(onClose).toHaveBeenCalled()
    })

    it('面板成员行：当前作用域命中时 aria-current（中性灰底），未命中不高亮', () => {
        convState.viewScope = {type: 'project', path: '/ws/a'}
        const hit = renderDrawer()
        openPanelByFocus('pg-a')
        expect(memberOpen(0).getAttribute('aria-current')).toBe('true')
        expect(memberOpen(1).getAttribute('aria-current')).not.toBe('true')
        hit.unmount()

        convState.viewScope = {type: 'project', path: '/ws/c'} // /ws/c 不在组内 → 组内行全部不高亮
        renderDrawer()
        openPanelByFocus('pg-a')
        expect(memberOpen(0).getAttribute('aria-current')).not.toBe('true')
    })

    it('面板成员行 hover 按钮：在文件管理器中打开 → openPath；移除项目 → confirm 后 removeWorkspace', async () => {
        renderDrawer()
        openPanelByFocus('pg-a')
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
        const row = document.querySelector('[data-name="top-project-row"]') as HTMLElement
        fireEvent.click(row)
        expect(convState.setWorkspace).toHaveBeenCalledWith('/ws/c')
    })

    it('空组占位只在二级面板里（常态层 1 不渲染成员区，也就没有内联占位）', () => {
        renderDrawer()
        expect(screen.queryByText(/还没有项目/)).toBeNull()
        openPanelByFocus('pg-empty')
        expect(document.querySelector('[data-name="drawer-group-empty-pg-empty"]')?.textContent)
            .toBe('还没有项目，拖入或点组头 + 添加')
    })

    it('当前作用域高亮：组头中性灰（§6.2 不用品牌绿）；未分组区仅高亮「当前所在项目」', () => {
        const first = renderDrawer()
        // 第一轮回炉将 scoped 组头改为中性灰（与 neutral.test 同口径）——本断言对齐现行为
        // 判据带边界：类名里恰好出现该项（非选中分支的 `hover:bg-[var(--surface-muted)]` 不算）
        expect(groupHeader('pg-a').className).toMatch(/(^|\s)bg-\[var\(--surface-muted\)\]/)
        expect(groupHeader('pg-a').className).not.toContain('brand-muted')
        first.unmount()

        // 已归组的项目（/ws/a ∈ pg-a）不在未分组区 → 未分组区不得有任何行被选中
        convState.viewScope = {type: 'project', path: '/ws/a'}
        const second = renderDrawer()
        const groupedScopeRow = document.querySelector('[data-name="top-project-row"]')
        expect(groupedScopeRow).toBeTruthy()
        expect(groupedScopeRow?.getAttribute('aria-selected')).not.toBe('true')
        second.unmount()

        // /ws/c 是夹具里唯一的未分组项目 → 切到它时该行选中
        convState.viewScope = {type: 'project', path: '/ws/c'}
        renderDrawer()
        expect(
            document.querySelector('[data-name="top-project-row"]')?.getAttribute('aria-selected'),
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

    it('「+ 加入本组」→ ensureWorkspaceRegistered + assign(生效键, groupId)，停留组视图', async () => {
        ;(window as any).electronAPI = {
            openFolderDialog: vi.fn(async () => '/ws/new'),
            openPath: vi.fn(),
        }
        convState.ensureWorkspaceRegistered.mockResolvedValueOnce('/ws/canonical')
        renderDrawer()
        fireEvent.click(screen.getByLabelText('将项目加入「组A」'))
        // 入组用的是登记返回的「生效键」，不是对话框给的原始串（否则同一项目会在组内 + 未分组区各出现一次）
        await waitFor(() => expect(groupState.assign).toHaveBeenCalledWith('/ws/canonical', 'pg-a'))
        expect(convState.ensureWorkspaceRegistered).toHaveBeenCalledWith('/ws/new')
        expect(convState.setWorkspace).not.toHaveBeenCalled()
        expect(convState.setProjectGroupView).not.toHaveBeenCalled()
    })

    it('「+ 加入本组」成功后 → focusProjectSegment(生效键)（停留组视图 + 定位该项目段，I-4）', async () => {
        ;(window as any).electronAPI = {
            openFolderDialog: vi.fn(async () => '/ws/new'),
            openPath: vi.fn(),
        }
        convState.ensureWorkspaceRegistered.mockResolvedValueOnce('/ws/canonical')
        renderDrawer()
        fireEvent.click(screen.getByLabelText('将项目加入「组A」'))
        await waitFor(() => expect(convState.focusProjectSegment).toHaveBeenCalledWith('/ws/canonical'))
        // 定位而不跟随：不切项目视图、不切当前工作区
        expect(convState.setProjectGroupView).not.toHaveBeenCalled()
        expect(convState.setWorkspace).not.toHaveBeenCalled()
    })

    it('「+ 加入本组」登记未能确认（返回 null）→ 不入组', async () => {
        ;(window as any).electronAPI = {
            openFolderDialog: vi.fn(async () => '/ws/new'),
            openPath: vi.fn(),
        }
        convState.ensureWorkspaceRegistered.mockResolvedValueOnce(null)
        renderDrawer()
        fireEvent.click(screen.getByLabelText('将项目加入「组A」'))
        await waitFor(() => expect(convState.ensureWorkspaceRegistered).toHaveBeenCalledWith('/ws/new'))
        expect(groupState.assign).not.toHaveBeenCalled()
    })

    it('空组也有「+ 加入本组」入口（拖不动的时候还能点）', () => {
        renderDrawer()
        expect(screen.getByLabelText('将项目加入「空组」')).toBeTruthy()
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

describe('ProjectGroupDrawer — 键盘可达性', () => {
    it('组头可聚焦（tabIndex=0，role=button；D5：不回退 role=option）', () => {
        renderDrawer()
        const header = groupHeader('pg-a')
        expect(header.getAttribute('tabindex')).toBe('0')
        expect(header.getAttribute('role')).toBe('button')
    })

    it('面板成员行的交互元素全是原生按钮（可 Tab、可回车）：行主体 / 两个 hover 按钮', () => {
        renderDrawer()
        openPanelByFocus('pg-a')
        const names = [
            'drawer-group-member-open-0',
            'drawer-member-open-in-explorer-button',
            'drawer-member-remove-button',
        ]
        for (const name of names) {
            const el = document.querySelector(`[data-name="${name}"]`) as HTMLButtonElement | null
            expect(el?.tagName, name).toBe('BUTTON')
            expect(el?.disabled, name).toBe(false)
            // tabindex="-1" 才是"Tab 不到"：原生按钮的默认可聚焦性靠 tabindex 属性缺席来保证
            expect(el?.getAttribute('tabindex'), name).toBeNull()
        }
    })

    it('面板 hover 按钮键盘聚焦时可见（group-focus-within）——「可 Tab 但看不见」也算不可达', () => {
        renderDrawer()
        openPanelByFocus('pg-a')
        const openBtn = document.querySelector('[data-name="drawer-member-open-in-explorer-button"]') as HTMLElement
        const removeBtn = document.querySelector('[data-name="drawer-member-remove-button"]') as HTMLElement
        expect(openBtn.className).toContain('group-focus-within:opacity-100')
        expect(removeBtn.className).toContain('group-focus-within:opacity-100')
        // 行主体在同一个 .group 里 → 焦点落在按钮上时 :focus-within 成立（浏览器里两个按钮一起显形）
        expect(openBtn.closest('.group')).toBe(memberRow(0))
    })
})

describe('ProjectGroupDrawer — 搜索态（层 1 内联命中成员；面板不开）', () => {
    const inlineOpen = (groupId: string, index: number) =>
        document.querySelector(`[data-name="group-member-open-${groupId}-${index}"]`) as HTMLElement

    function renderSearch(search: string, onClose: () => void = () => {}) {
        return render(
            <ProjectGroupDrawer drawerRef={{current: null}} search={search} setSearch={() => {}} onClose={onClose}/>,
        )
    }

    it('search 命中组成员 → 该成员行内联保留且可点击切换', () => {
        const onClose = vi.fn()
        renderSearch('b', onClose)
        // /ws/b 的 basename = 'b'，命中 search='b'；/ws/a 被过滤 → 组内只剩 index 0 = /ws/b
        expect(inlineOpen('pg-a', 1)).toBeNull()
        const row = inlineOpen('pg-a', 0)
        expect(row.textContent).toContain('/ws/b')
        fireEvent.click(row)
        expect(convState.setWorkspace).toHaveBeenCalledWith('/ws/b')
        expect(onClose).toHaveBeenCalled()
    })

    it('搜索态 hover / focus 组头都不开二级面板（成员已在层 1 内联可见）', async () => {
        renderSearch('b')
        fireEvent.mouseEnter(groupHeader('pg-a'))
        fireEvent.focus(groupHeader('pg-a'))
        // 越过 120ms 开面板延时窗口：仍不应出现面板
        await new Promise((resolve) => setTimeout(resolve, 200))
        expect(panel()).toBeNull()
    })

    it('search 命中组名但成员未命中 → 内联区显「无匹配成员」占位', () => {
        renderSearch('组')
        // 组名「组A」「空组」均命中 search='组' → 组名匹配时保留全部成员
        // 空组无成员 → 应显示「无匹配成员」而非「还没有项目…」
        const emptyHint = document.querySelector('[data-name="drawer-group-empty-pg-empty"]')
        expect(emptyHint).toBeTruthy()
        expect(emptyHint?.textContent).toBe('无匹配成员')
        expect(emptyHint?.textContent).not.toContain('还没有项目')
    })
})
