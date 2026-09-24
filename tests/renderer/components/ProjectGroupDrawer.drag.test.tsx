// @vitest-environment jsdom
/**
 * 抽屉拖拽：五个落点（spec §6.3 表）+ 点击判定 + Esc 取消 + 搜索态禁用
 * + 滚动后的落点时效性（抽屉根与二级面板根各一条）+ "面板根的非行区域不是落点"。
 *
 * **jsdom 无布局引擎**：`getBoundingClientRect()` 默认全零，而"离中线更近"的插入判定
 * 完全依赖真实矩形（全零会让所有行退化成一个零面积落点，用例会因错误的原因通过/失败）。
 * 因此这里按 DOM 契约造一份确定性布局表 —— 挡位有两块根：
 *  · 抽屉内容区（`data-drag-scroll`）：组头（`data-drag-row="group"`）+ 未分组行（`"top"`）；
 *  · 二级面板（`data-name="drawer-group-panel"`，portal 到 body）：面板头行 + 成员行（`"member"`）。
 *  面板是 fixed 定位，横向与抽屉错开（左缘 320）→ "指针落在哪块根"由 x 区分。
 *  · 容器矩形非零、且高于行矩形总和 → 自动滚动可达；
 *  · 行与行之间留出真实空隙 → 组区空白（mb-1 间隙、面板头行）可以被指到；
 *  · 行/组块坐标按**各自根**的 scrollTop 平移 → 滚动后的几何是真的，不然"随滚动重采"无从验证。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, act, waitFor} from '@testing-library/react'

const groupState = vi.hoisted(() => ({
    groups: [
        {id: 'pg-a', name: '组A', sortOrder: 0, createdAt: 1, updatedAt: 1,
         members: [{projectPath: '/ws/a', groupOrder: 0}, {projectPath: '/ws/b', groupOrder: 1}]},
        {id: 'pg-b', name: '组B', sortOrder: 1, createdAt: 1, updatedAt: 1, members: []},
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
        '/ws/a': {lastOpenedAt: 3, conversations: []},
        '/ws/b': {lastOpenedAt: 2, conversations: []},
        '/ws/c': {lastOpenedAt: 1, conversations: []},
    },
    currentWorkspacePath: '/ws/a',
    viewScope: {type: 'group', groupId: 'pg-a'} as unknown,
    setWorkspace: vi.fn(),
    setProjectGroupView: vi.fn(),
    ensureWorkspaceRegistered: vi.fn(async () => '/ws/new'),
    removeWorkspace: vi.fn(),
}))

vi.mock('../../../src/renderer/stores/conversationStore', () => ({
    useConversationStore: (sel?: (s: typeof convState) => unknown) => (sel ? sel(convState) : convState),
}))

import {ProjectGroupDrawer} from '../../../src/renderer/components/ProjectGroupDrawer'

const ROW_HEIGHT = 40
/**
 * 抽屉内容区矩形：高度 320 > 行矩形总和，下方留白 —— 自动滚动可达。
 * `let` 而非 const：F7 的窄窗口用例要把两块根钳进同一段横向区间（面板盖到抽屉上），
 * 其余用例读到的仍是这里的默认值（用例内 try/finally 还原）。
 */
let CONTAINER = {top: 0, bottom: 320, left: 0, right: 300}
/** 抽屉内组头高度 */
const HEADER_HEIGHT = 40
/** 二级面板矩形（fixed；默认横向与抽屉错开，故"指针落在哪块根"看 x） */
let PANEL = {top: 0, bottom: 320, left: 320, right: 584}

/**
 * 抽屉内组块顶边表（内容坐标，自上而下）。常态下成员行在二级面板里 → 组块 = 组头：
 *  · 组A 块 = 0..40；
 *  · 组块间 mb-1 间隙 = 40..44；
 *  · 组B 块 = 44..84（空组，常态无内联占位）；
 *  · 未分组行 /ws/c = 88..128。
 */
const GROUP_BLOCK_TOPS: Record<string, number> = {'pg-a': 0, 'pg-b': 44}

const ZERO_RECT = {
    top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}),
} as unknown as DOMRect

/** 当前渲染出来的两块根（行坐标按各自 scrollTop 平移） */
let scrollEl: HTMLElement | null = null
let panelEl: HTMLElement | null = null
let drawerScrollTop = 0
let panelScrollTop = 0

function rectOf(top: number, bottom: number, left = 0, right = 300): DOMRect {
    const box = {top, bottom, left, right, width: right - left, height: bottom - top, x: left, y: top}
    return {...box, toJSON: () => box} as unknown as DOMRect
}

function layoutRect(el: Element): DOMRect {
    if (scrollEl && el === scrollEl) return rectOf(CONTAINER.top, CONTAINER.bottom, CONTAINER.left, CONTAINER.right)
    if (panelEl && el === panelEl) return rectOf(PANEL.top, PANEL.bottom, PANEL.left, PANEL.right)
    // 面板内的节点：面板头行（无 drag 契约）+ 成员行（data-index）
    if (panelEl && panelEl.contains(el)) {
        const shift = panelScrollTop
        const index = el.getAttribute('data-index')
        if (el.getAttribute('data-drag-row') === 'member' && index !== null) {
            const top = PANEL.top + HEADER_HEIGHT + Number(index) * ROW_HEIGHT
            return rectOf(top - shift, top + ROW_HEIGHT - shift, PANEL.left, PANEL.right)
        }
        return rectOf(PANEL.top - shift, PANEL.top + HEADER_HEIGHT - shift, PANEL.left, PANEL.right)
    }
    const shift = drawerScrollTop
    const blockId = el.getAttribute('data-drag-group-block')
    if (blockId !== null) {
        const top = GROUP_BLOCK_TOPS[blockId]
        if (top === undefined) return ZERO_RECT
        // 组块高度 = 组头 +（搜索态才有的）内联成员行数；常态成员行在面板里 → 只剩组头
        const memberCount = el.querySelectorAll('[data-drag-row="member"]').length
        return rectOf(top - shift, top + HEADER_HEIGHT + memberCount * ROW_HEIGHT - shift)
    }
    const key = [
        el.getAttribute('data-drag-row') ?? '',
        el.getAttribute('data-group-id') ?? '',
        el.getAttribute('data-index') ?? '',
    ].join(':')
    if (key.startsWith('group:pg-a:')) return rectOf(GROUP_BLOCK_TOPS['pg-a'] - shift, GROUP_BLOCK_TOPS['pg-a'] + HEADER_HEIGHT - shift)
    if (key.startsWith('group:pg-b:')) return rectOf(GROUP_BLOCK_TOPS['pg-b'] - shift, GROUP_BLOCK_TOPS['pg-b'] + HEADER_HEIGHT - shift)
    if (key === 'top::0') return rectOf(88 - shift, 128 - shift)
    return ZERO_RECT
}

let rectSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
    vi.clearAllMocks()
    rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        return layoutRect(this)
    })
})

afterEach(() => {
    rectSpy.mockRestore()
    scrollEl = null
    panelEl = null
    drawerScrollTop = 0
    panelScrollTop = 0
    document.body.style.userSelect = ''
})

function renderDrawer(search = '') {
    const drawerRef = {current: null as HTMLDivElement | null}
    const utils = render(
        <ProjectGroupDrawer drawerRef={drawerRef} search={search} setSearch={() => {}} onClose={() => {}}/>,
    )
    scrollEl = document.querySelector('[data-drag-scroll]') as HTMLElement
    if (!scrollEl) throw new Error('缺少滚动容器 data-drag-scroll')
    panelEl = null
    return utils
}

function groupHeader(groupId: string): HTMLElement {
    return document.querySelector(`[data-name="group-block-header"][data-group-id="${groupId}"]`) as HTMLElement
}

/** 焦点路径开面板（组头 onFocus 立即开，D4）—— 成员行在面板里，拖它之前必须先开面板 */
function openPanel(groupId = 'pg-a') {
    fireEvent.focus(groupHeader(groupId))
    panelEl = document.querySelector('[data-name="drawer-group-panel"]') as HTMLElement
    if (!panelEl) throw new Error('焦点进组头后未打开二级面板')
}

/** 按拖拽契约定位行：data-drag-row + data-group-id + data-index */
function dragRow(kind: string, groupId: string | null, index: number): HTMLElement {
    const sel = groupId === null
        ? `[data-drag-row="${kind}"][data-index="${index}"]`
        : `[data-drag-row="${kind}"][data-group-id="${groupId}"][data-index="${index}"]`
    const el = document.querySelector(sel)
    if (!el) throw new Error(`缺少行 ${sel}`)
    return el as HTMLElement
}

/** 按下 + 拖到目标点（一次 pointermove 同时越过阈值并算出落点） */
function pressAndDrag(el: HTMLElement, from: [number, number], to: [number, number]) {
    fireEvent.pointerDown(el, {clientX: from[0], clientY: from[1], button: 0})
    fireEvent.pointerMove(window, {clientX: to[0], clientY: to[1]})
}

function releaseAt(x: number, y: number) {
    fireEvent.pointerUp(window, {clientX: x, clientY: y})
}

/** 无任何写操作（五落点表之外的组合不落库） */
function expectNoWrites() {
    expect(groupState.assign).not.toHaveBeenCalled()
    expect(groupState.reorderGroups).not.toHaveBeenCalled()
    expect(groupState.reorderProjects).not.toHaveBeenCalled()
}

describe('ProjectGroupDrawer — 拖拽五落点', () => {
    it('1) 未分组项目拖到组头 → assign(path, groupId)', () => {
        renderDrawer()
        pressAndDrag(dragRow('top', null, 0), [100, 108], [100, 20]) // 未分组 /ws/c → 组A 组头
        expect(document.querySelector('.drawer-drop-over')?.textContent).toContain('组A') // 落点高亮
        releaseAt(100, 20)
        expect(groupState.assign).toHaveBeenCalledWith('/ws/c', 'pg-a')
        expect(groupState.reorderGroups).not.toHaveBeenCalled()
        expect(groupState.reorderProjects).not.toHaveBeenCalled()
    })

    it('2) 面板成员行拖到另一组 → assign(path, otherGroupId)', () => {
        renderDrawer()
        openPanel()
        pressAndDrag(dragRow('member', 'pg-a', 0), [400, 60], [100, 64]) // /ws/a → 组B 组头
        releaseAt(100, 64)
        expect(groupState.assign).toHaveBeenCalledWith('/ws/a', 'pg-b')
        expect(groupState.reorderProjects).not.toHaveBeenCalled()
    })

    it('2b) 成员拖到自己所在组组头 → 同组短路不写库（避免 assign 幂等闪回）', () => {
        renderDrawer()
        openPanel()
        pressAndDrag(dragRow('member', 'pg-a', 0), [400, 60], [100, 20]) // /ws/a → 组A 自己的组头
        releaseAt(100, 20)
        expectNoWrites()
    })

    it('3) 成员行拖到未分组区 → assign(path, null)', () => {
        renderDrawer()
        openPanel()
        pressAndDrag(dragRow('member', 'pg-a', 0), [400, 60], [100, 108]) // /ws/a → 未分组区 /ws/c
        releaseAt(100, 108)
        expect(groupState.assign).toHaveBeenCalledWith('/ws/a', null)
    })

    it('4) 面板成员行上下换位 → reorderProjects(groupId, newOrder)', () => {
        renderDrawer()
        openPanel()
        // 面板内：a 占 40..80、b 占 80..120；拖 a 到 b 的**下半**（中线 100；y=110 → 插到 b 之后）
        pressAndDrag(dragRow('member', 'pg-a', 0), [400, 60], [400, 110])
        expect(document.querySelector('.drawer-insert-line')).toBeTruthy() // 插入线
        releaseAt(400, 110)
        expect(groupState.reorderProjects).toHaveBeenCalledWith('pg-a', ['/ws/b', '/ws/a'])
        expect(groupState.assign).not.toHaveBeenCalled()
    })

    it('4b) 反向排序（成员 b 拖到 a 之前）→ reorderProjects 反向', () => {
        renderDrawer()
        openPanel()
        // /ws/b 占 80..120；拖到 a（40..80）的上半（中线 60；y=50 → 插到 a 之前）
        pressAndDrag(dragRow('member', 'pg-a', 1), [400, 100], [400, 50])
        releaseAt(400, 50)
        expect(groupState.reorderProjects).toHaveBeenCalledWith('pg-a', ['/ws/b', '/ws/a'])
        expect(groupState.assign).not.toHaveBeenCalled()
    })

    it('5) 组头上下换位 → reorderGroups(newOrder)', () => {
        renderDrawer()
        pressAndDrag(dragRow('group', 'pg-a', 0), [100, 20], [100, 64]) // 组A 组头 → 组B 组头
        releaseAt(100, 64)
        expect(groupState.reorderGroups).toHaveBeenCalledWith(['pg-b', 'pg-a'])
        expect(groupState.assign).not.toHaveBeenCalled()
    })

    it('6) 位移 2px 后抬起 → 视为点击，不触发任何写操作', () => {
        renderDrawer()
        const target = dragRow('top', null, 0)
        fireEvent.pointerDown(target, {clientX: 100, clientY: 108, button: 0})
        fireEvent.pointerMove(window, {clientX: 102, clientY: 110}) // √8 ≈ 2.83 < 4
        fireEvent.pointerUp(window, {clientX: 102, clientY: 110})
        expectNoWrites()
        expect(document.querySelector('.drawer-insert-line')).toBeNull() // 没进拖拽态
        expect(document.body.style.userSelect).not.toBe('none')
        // 阈值内 = 点击：随后的 click 必须照常生效（拖拽抑制没被误触发）
        fireEvent.click(target)
        expect(convState.setWorkspace).toHaveBeenCalledWith('/ws/c')
    })

    it('7) 拖拽中按 Esc → 取消，不落库', () => {
        renderDrawer()
        openPanel()
        pressAndDrag(dragRow('member', 'pg-a', 0), [400, 60], [100, 64])
        expect(document.querySelector('.drawer-insert-line') ?? document.querySelector('.drawer-drop-over')).toBeTruthy()
        fireEvent.keyDown(window, {key: 'Escape'})
        expectNoWrites()
        expect(document.body.style.userSelect).not.toBe('none') // 副作用已还原
        // 取消后再抬手也不会落库（监听已摘）
        releaseAt(100, 64)
        expectNoWrites()
    })

    it('8) 搜索态（search 非空）→ 按下拖动不进入拖拽', () => {
        renderDrawer('ws')
        // 两态分离（§5.8.5）：搜索态成员行内联在层 1、不带拖拽契约 → 用 data-name 定位
        const member = document.querySelector('[data-name="group-member-row"]') as HTMLElement
        expect(member).toBeTruthy()
        expect(member.getAttribute('data-drag-row')).toBeNull()
        pressAndDrag(member, [100, 60], [100, 20])
        expect(document.querySelector('.drawer-insert-line')).toBeNull()
        expect(document.querySelector('.drawer-drop-over')).toBeNull()
        releaseAt(100, 20)
        expectNoWrites()
    })

    it('拖拽期间显示跟手预览，含被拖项目名', () => {
        renderDrawer()
        pressAndDrag(dragRow('top', null, 0), [100, 108], [100, 20])
        const ghost = document.querySelector('[data-name="drawer-drag-ghost"]')
        expect(ghost?.textContent).toBe('c')
        releaseAt(100, 20)
        expect(document.querySelector('[data-name="drawer-drag-ghost"]')).toBeNull() // 抬手即清理
    })
})

describe('ProjectGroupDrawer — 拖拽与既有交互不冲突', () => {
    it('拖拽结束后浏览器补发的 click 不切视图（组头）', () => {
        renderDrawer()
        pressAndDrag(dragRow('group', 'pg-a', 0), [100, 20], [100, 64])
        releaseAt(100, 64)
        fireEvent.click(dragRow('group', 'pg-a', 0)) // 拖拽后浏览器紧随补发的那次 click
        expect(convState.setProjectGroupView).not.toHaveBeenCalled()
    })

    it('组头落在自己身上 = 无变化，不写 reorderGroups', () => {
        renderDrawer()
        // 位移 10px（已进入拖拽态）但落点仍是自己 → 顺序没变，不写
        pressAndDrag(dragRow('group', 'pg-a', 0), [100, 20], [100, 30])
        releaseAt(100, 30)
        expectNoWrites()
    })

    it('未分组项目落回未分组区 = 无变化，不写 assign', () => {
        renderDrawer()
        pressAndDrag(dragRow('top', null, 0), [100, 108], [100, 118])
        releaseAt(100, 118)
        expectNoWrites()
    })

    it('拖到空白处（无落点）抬起 → 取消，不落库', () => {
        renderDrawer()
        openPanel()
        pressAndDrag(dragRow('member', 'pg-a', 0), [400, 60], [100, 999])
        releaseAt(100, 999)
        expectNoWrites()
    })

    it('搜索框仍在、行仍可点击（拖拽接线不影响既有交互）', () => {
        renderDrawer()
        expect(screen.getByPlaceholderText('搜索项目…')).toBeTruthy()
        fireEvent.click(dragRow('top', null, 0))
        expect(convState.setWorkspace).toHaveBeenCalledWith('/ws/c')
    })
})

describe('ProjectGroupDrawer — 非行区域不是落点（回归：面板根不得吃空态兜底）', () => {
    it('面板头行区域（面板根内、成员行之外）不写库', () => {
        renderDrawer()
        openPanel()
        pressAndDrag(dragRow('member', 'pg-a', 0), [400, 60], [400, 20]) // 40..80 之上 = 面板头行
        expect(document.querySelector('.drawer-insert-line')).toBeNull()
        expect(document.querySelector('.drawer-drop-over')).toBeNull()
        releaseAt(400, 20)
        // 若面板根也吃「顶层区兜底」，这里会把 /ws/a 静默移出组（append 到顶层区）
        expectNoWrites()
    })

    it('面板成员行之下的空白（面板根内）不写库', () => {
        renderDrawer()
        openPanel()
        pressAndDrag(dragRow('member', 'pg-a', 0), [400, 60], [400, 220]) // 成员行（40..120）之下的空白
        expect(document.querySelector('.drawer-insert-line')).toBeNull()
        expect(document.querySelector('.drawer-drop-over')).toBeNull()
        releaseAt(400, 220)
        expectNoWrites()
    })

    it('组块之间的 mb-1 间隙（40..44）不写库', () => {
        renderDrawer()
        openPanel()
        pressAndDrag(dragRow('member', 'pg-a', 0), [400, 60], [100, 42])
        releaseAt(100, 42)
        expectNoWrites()
    })

    it('未分组区非空时不再有容器兜底：最后一行之下的空白也不是落点', () => {
        renderDrawer()
        openPanel()
        pressAndDrag(dragRow('member', 'pg-a', 0), [400, 60], [100, 300]) // 未分组行 88..128 之下、容器内
        releaseAt(100, 300)
        expectNoWrites()
    })

    it('全部归组（未分组区为空）时：最后一个组块之下仍是"移出组"的落点', () => {
        groupState.groups[1].members.push({projectPath: '/ws/c', groupOrder: 0})
        try {
            renderDrawer()
            openPanel()
            // 组B 块此时 = 组头 44..84（成员 c 在面板里）；84 之下 = 空态顶层区渲染的位置 → §6.3 第 3 行仍有落点
            pressAndDrag(dragRow('member', 'pg-a', 0), [400, 60], [100, 300])
            releaseAt(100, 300)
            expect(groupState.assign).toHaveBeenCalledWith('/ws/a', null)
        } finally {
            groupState.groups[1].members.pop()
        }
    })
})

describe('ProjectGroupDrawer — 滚动后的落点重采（指针不动）', () => {
    /**
     * jsdom 的 scrollTop 赋值不生效（无布局引擎）：定义成可写属性，让"已滚过"的状态可构造。
     */
    function setDrawerScrollTop(value: number) {
        Object.defineProperty(scrollEl!, 'scrollTop', {
            configurable: true,
            get: () => drawerScrollTop,
            set: (next: number) => {
                drawerScrollTop = next
            },
        })
        scrollEl!.scrollTop = value
    }

    function setPanelScrollTop(value: number) {
        Object.defineProperty(panelEl!, 'scrollTop', {
            configurable: true,
            get: () => panelScrollTop,
            set: (next: number) => {
                panelScrollTop = next
            },
        })
        panelEl!.scrollTop = value
    }

    it('抽屉滚动：没有 pointermove 也要重采，落点判定基于滚动后的新位置', () => {
        renderDrawer()
        openPanel()
        // 指针停在组块间隙（40..44）：此刻无落点、无插入线
        pressAndDrag(dragRow('member', 'pg-a', 0), [400, 60], [100, 42])
        expect(document.querySelector('.drawer-insert-line')).toBeNull()

        setDrawerScrollTop(40)
        fireEvent.scroll(scrollEl!) // 抽屉滚动 = 落点表整体偏移 → 必须重采

        // 滚动后（抽屉行整体上移 40）：y=42 落在组B 组头（4..44）→ 高亮出现
        expect(document.querySelector('.drawer-drop-over')?.textContent).toContain('组B')
        releaseAt(100, 42)
        expect(groupState.assign).toHaveBeenCalledWith('/ws/a', 'pg-b')
        expect(groupState.reorderProjects).not.toHaveBeenCalled()
    })

    it('面板自身滚动：成员行落点同步重采（extraScrollRefs 接线）', () => {
        renderDrawer()
        openPanel()
        // 指针停在面板内 y=30：此刻那是**面板头行**区域（成员 a 占 40..80）→ 无落点
        pressAndDrag(dragRow('member', 'pg-a', 1), [400, 100], [400, 30])
        expect(document.querySelector('.drawer-insert-line')).toBeNull()

        setPanelScrollTop(20)
        fireEvent.scroll(panelEl!) // 面板滚动 = 面板内行整体偏移 → 必须重采

        // 重采的直接证据（不靠抬手兜底）：滚动后面板内容上移 20 → a 行变 20..60（中线 40）
        // → y=30 落在 a 的上半 → 插入线出现。缺 extraScrollRefs 时这里仍是"无落点"。
        expect(document.querySelector('.drawer-insert-line')).toBeTruthy()
        releaseAt(400, 30)
        // 拖的是 /ws/b（原 index 1）→ 插到 index 0 = 顺序变化
        expect(groupState.reorderProjects).toHaveBeenCalledWith('pg-a', ['/ws/b', '/ws/a'])
    })
})

/** 钉住收尾判定（`pointerOverPanelOrGroupHeader`）用的命中测试桩：传 null = "指针处什么都没有" */
function stubElementFromPoint(el: Element | null) {
    const fn = vi.fn(() => el)
    Object.defineProperty(document, 'elementFromPoint', {value: fn, writable: true, configurable: true})
    return fn
}

describe('ProjectGroupDrawer — 钉住（拖拽）结束后面板的去留', () => {
    const PANEL_SEL = '[data-name="drawer-group-panel"]'

    afterEach(() => {
        // elementFromPoint 是本组用例现场打的桩（jsdom 本无此方法）→ 用完即删，避免串到后面的用例
        delete (document as unknown as {elementFromPoint?: unknown}).elementFromPoint
    })

    it('拖拽中 hover 别的组头不会打开二级面板（否则落点表会被浮层搅乱）', async () => {
        renderDrawer()
        pressAndDrag(dragRow('top', null, 0), [100, 108], [100, 20]) // 已进入拖拽态
        fireEvent.mouseEnter(groupHeader('pg-b'))
        // 等过 120ms 的打开延时。包在 act 里：拖拽期间 rAF 循环本身也在写 state，
        // 裸等真实计时器会让那些更新落在 act 之外（React 会告警）
        await act(async () => { await new Promise((r) => setTimeout(r, 160)) })
        expect(document.querySelector(PANEL_SEL)).toBeNull()
        releaseAt(100, 20)
    })

    it('拖拽在面板外收尾 → 宽限后自动关闭（不用等鼠标下次进出组头）', async () => {
        renderDrawer()
        openPanel()
        const fromPoint = stubElementFromPoint(null) // 抬手处既不在面板里、也不在组头上
        pressAndDrag(dragRow('member', 'pg-a', 0), [400, 60], [100, 108]) // 面板成员 → 未分组区
        releaseAt(100, 108)
        expect(fromPoint).toHaveBeenCalled() // 判定真的走了 elementFromPoint，不是"压根没判"
        expect(document.querySelector(PANEL_SEL)).toBeTruthy() // 宽限期内仍在（不是"抬手即关"）
        await waitFor(() => expect(document.querySelector(PANEL_SEL)).toBeNull())
    })

    it('拖拽在面板内收尾（elementFromPoint 命中面板）→ 保持打开', async () => {
        renderDrawer()
        openPanel()
        stubElementFromPoint(document.querySelector(PANEL_SEL))
        pressAndDrag(dragRow('member', 'pg-a', 0), [400, 60], [400, 110]) // 面板内换位
        releaseAt(400, 110)
        await act(async () => { await new Promise((r) => setTimeout(r, 260)) }) // 超过 200ms 宽限
        expect(document.querySelector(PANEL_SEL)).toBeTruthy()
    })
})

describe('ProjectGroupDrawer — 窄窗口：面板与抽屉几何重叠时的落点优先级（回归：抽屉兜底抢落点）', () => {
    /**
     * 复现条件（复核 I1）：
     *  · 窗口足够窄 → `panelGeometry` 的 left 钳制把面板拉到抽屉正上方（两块根横向重叠）；
     *  · 未分组区为空（项目全部归组）→ 抽屉根据此启用"空态兜底顶层落点"。
     * 此时抽屉根的兜底 zone（覆盖容器全宽、只按 y 判）会先于面板成员行 zone 命中，
     * 把"拖面板成员到面板内"判成"移到顶层区" → `assign(path, null)` 静默移出组（或排序失效）。
     * 面板在视觉上层（z-index 9999）→ 重叠区落点应归面板，故采集顺序必须面板根在前。
     */
    it('面板内换位仍走 reorderProjects（不得 assign(path, null)）', () => {
        const prev = [CONTAINER, PANEL]
        groupState.groups[1].members.push({projectPath: '/ws/c', groupOrder: 0}) // 未分组区为空 → 抽屉兜底生效
        CONTAINER = {top: 0, bottom: 300, left: 0, right: 320}
        PANEL = {top: 8, bottom: 272, left: 0, right: 320}
        try {
            renderDrawer()
            openPanel()
            // 面板内：头行 8..48、成员 a 占 48..88、成员 b 占 88..128；拖 a 到 b 的下半（中线 108）
            pressAndDrag(dragRow('member', 'pg-a', 0), [150, 60], [150, 118])
            releaseAt(150, 118)
            expect(groupState.reorderProjects).toHaveBeenCalledWith('pg-a', ['/ws/b', '/ws/a'])
            expect(groupState.assign).not.toHaveBeenCalled() // 修前：抽屉兜底先命中 → assign('/ws/a', null)
        } finally {
            groupState.groups[1].members.pop()
            CONTAINER = prev[0]
            PANEL = prev[1]
        }
    })

    /**
     * R1：面板矩形内、面板行落点之外的空白，现状没有任何 zone →
     * 穿透到抽屉根的“空态兜底顶层落点” → `assign(path, null)` 静默移出组。
     * 面板在视觉上层，这片空白对用户来说就是“面板内的空白”（= 取消），不落库。
     */
    it('拖到面板内空白（成员行之下、面板底缘之上）→ 零写操作（R1）', () => {
        const prev = [CONTAINER, PANEL]
        groupState.groups[1].members.push({projectPath: '/ws/c', groupOrder: 0}) // 未分组区为空 → 抽屉兜底生效
        CONTAINER = {top: 0, bottom: 300, left: 0, right: 320}
        PANEL = {top: 8, bottom: 272, left: 0, right: 320}
        try {
            renderDrawer()
            openPanel()
            // 面板内行：头行 8..48、成员 a 48..88、成员 b 88..128；y=200 在成员行之下、面板底缘 272 之上
            pressAndDrag(dragRow('member', 'pg-a', 0), [150, 60], [150, 200])
            releaseAt(150, 200)
            // 修前：这片空白无 zone → 命中抽屉兜底 zone（y∈[84,300] × x∈[0,320]）→ assign('/ws/a', null)
            expectNoWrites()
        } finally {
            groupState.groups[1].members.pop()
            CONTAINER = prev[0]
            PANEL = prev[1]
        }
    })

    /**
     * 防过度修复（同几何、面板部分重叠）：被面板压住的那部分抽屉空白不落库，
     * 但**面板右缘之外**的抽屉空白仍是“移出组”的合法落点 —— 校验修复是“挖掉面板矩形”，
     * 不是“有重叠就让下层根整体退出命中”（后者会让窄窗口下入组 / 移出组 / 组间排序全废）。
     */
    it('部分重叠：面板右缘之外的抽屉空白仍应移出组', () => {
        const prev = [CONTAINER, PANEL]
        groupState.groups[1].members.push({projectPath: '/ws/c', groupOrder: 0})
        CONTAINER = {top: 0, bottom: 300, left: 0, right: 320}
        PANEL = {top: 8, bottom: 272, left: 0, right: 272} // 面板收窄：右缘 272 < 抽屉右缘 320
        try {
            renderDrawer()
            openPanel()
            pressAndDrag(dragRow('member', 'pg-a', 0), [150, 60], [285, 250]) // 面板之外、抽屉兜底之内
            releaseAt(285, 250)
            expect(groupState.assign).toHaveBeenCalledWith('/ws/a', null)
        } finally {
            groupState.groups[1].members.pop()
            CONTAINER = prev[0]
            PANEL = prev[1]
        }
    })
})
