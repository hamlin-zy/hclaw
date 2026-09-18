// @vitest-environment jsdom
/**
 * 抽屉拖拽（Task 11）：五个落点（spec §6.3 表）+ 点击判定 + Esc 取消 + 搜索态禁用
 * + 自动滚动下的落点时效性 + 组区空白不是落点。
 *
 * **jsdom 无布局引擎**：`getBoundingClientRect()` 默认全零，而"离中线更近"的插入判定
 * 完全依赖真实矩形（全零会让所有行退化成一个零面积落点，用例会因错误的原因通过/失败）。
 * 因此这里按 DOM 契约造一份确定性布局表 —— 行（`data-drag-row`）、组块
 * （`data-drag-group-block`）、容器（`data-drag-scroll`）：
 *  · 容器矩形非零、且高于行矩形总和 → 自动滚动可达（旧版给容器零矩形，把这条路径整个藏掉了）；
 *  · 行与行之间留出真实空隙 → 组区空白（空组占位、mb-1 间隙）可以被指到；
 *  · 行/组块坐标按容器 scrollTop 平移 → 滚动后的几何是真的，不然"随滚动重采"无从验证。
 *
 * §16 二级化之后这里多了一条几何事实：**成员行搬进了 portal 到 body 的二级面板** ——
 * 面板是 fixed 定位、自己独立滚动，所以它的行既不平移于抽屉内容区的 scrollTop，
 * x 也落在抽屉右侧（`PANEL_LEFT..PANEL_RIGHT`）。两片区域在坐标上互不重叠，
 * 才能验证"落点表 = 抽屉根 + 面板根 拼起来"这件事（否则 drawPath 会互相串台）。
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
/** 滚动容器矩形：高度 320 > 行矩形总和（5×40），且下方留白 —— 自动滚动与组区空白都必须可达 */
const CONTAINER = {top: 0, bottom: 320}
/** 组块里的组头高度；空组再多一段占位文字（与下方 GROUP_BLOCK_TOPS 一起还原真实块高） */
const HEADER_HEIGHT = 40
const EMPTY_HINT_HEIGHT = 36
/** 二级面板的水平范围：贴在抽屉（0..300）右侧，两块坐标不重叠 */
const PANEL_LEFT = 310
const PANEL_RIGHT = 570
/**
 * 二级面板**根**的垂直范围（面板内部坐标）：0..40 = 面板头行，之后是成员行，
 * 末尾是空组占位文字 / 「添加项目」行。
 *
 * 这块矩形是给 `collectDropZones(面板根)` 的"空态兜底顶层落点"分支用的：
 * 该分支要求 `container.width/height > 0`，而面板根此前在 `layoutRect` 里落到 ZERO_RECT
 * （key `'::'` 不在 LAYOUT 表里）→ 零矩形 → 分支在 jsdom 里**结构上不可能触发**，
 * 于是"面板根被整块注册成 top-level 落点、成员拖到面板头行静默移出组"这条缺陷
 * 23 条拖拽用例全都发现不了。给面板根一个真实矩形，这条集成级用例才真的能抓住它。
 */
const PANEL_TOP = 0
const PANEL_BOTTOM = 200

/**
 * 行布局表（内容坐标，自上而下）：key = `data-drag-row:data-group-id:data-index`。
 * 行与行之间的空隙 = 真实 DOM 里的组区（组块间 mb-1 间隙、空组占位文字区）。
 *
 * 层 1 现在只有组头（成员行与「添加项目」都在二级面板里，见 §16）：
 *  · 组A 块 = 0..40（只有组头，成员不在层 1）；
 *  · 组B 块 = 44..120（组头 44..84 + 空组占位 84..120）；
 *  · 未分组行 /ws/c = 124..164。
 * 面板那一半（member:*）是面板内部坐标，不受抽屉 content 滚动影响。
 */
const LAYOUT: Record<string, number> = {
    'group:pg-a:': 0,      // 组A 组头
    'group:pg-b:': 44,     // 组B 组头（40..44 = 组块间 mb-1 间隙）
    'top::0': 124,         // /ws/c（未分组区唯一项目）
    'member:pg-a:0': 40,   // /ws/a（面板头行占 0..40）
    'member:pg-a:1': 80,   // /ws/b
}

/** 组块顶边：底边 = 顶边 + 组头 40 +（空组时）占位 36 */
const GROUP_BLOCK_TOPS: Record<string, number> = {'pg-a': 0, 'pg-b': 44}

const ZERO_RECT = {
    top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}),
} as unknown as DOMRect

/** 当前渲染出来的滚动容器（行坐标按它的 scrollTop 平移） */
let scrollEl: HTMLElement | null = null

function rectOf(top: number, bottom: number, left = 0, right = 300): DOMRect {
    const box = {top, bottom, left, right, width: right - left, height: bottom - top, x: left, y: top}
    return {...box, toJSON: () => box} as unknown as DOMRect
}

function layoutRect(el: Element): DOMRect {
    if (scrollEl && el === scrollEl) return rectOf(CONTAINER.top, CONTAINER.bottom) // 容器不随自身滚动移动
    // 面板根自己有真实矩形（理由见 PANEL_TOP/PANEL_BOTTOM 的注释）：它不随任何滚动移动
    if (el.getAttribute('data-name') === 'drawer-group-panel') {
        return rectOf(PANEL_TOP, PANEL_BOTTOM, PANEL_LEFT, PANEL_RIGHT)
    }
    const shift = scrollEl?.scrollTop ?? 0
    const blockId = el.getAttribute('data-drag-group-block')
    if (blockId !== null) {
        const top = GROUP_BLOCK_TOPS[blockId]
        if (top === undefined) return ZERO_RECT
        // 空组的占位文字是组块的一部分（所以"组块之上的空白"要把整块排除掉）；成员行在面板里，不算块高
        const bottom = top + HEADER_HEIGHT
            + (document.querySelector(`[data-name="drawer-group-empty-${blockId}"]`) ? EMPTY_HINT_HEIGHT : 0)
        return rectOf(top - shift, bottom - shift)
    }
    // 二级面板：fixed + 独立滚动 → 只按**面板自己**的 scrollTop 平移（不跟抽屉内容区），且在抽屉右侧
    const panelRoot = el.closest('[data-name="drawer-group-panel"]')
    const key = [
        el.getAttribute('data-drag-row') ?? '',
        el.getAttribute('data-group-id') ?? '',
        el.getAttribute('data-index') ?? '',
    ].join(':')
    const top = LAYOUT[key]
    if (top === undefined) return ZERO_RECT
    const rowShift = panelRoot ? panelRoot.scrollTop : shift
    return panelRoot
        ? rectOf(top - rowShift, top + ROW_HEIGHT - rowShift, PANEL_LEFT, PANEL_RIGHT)
        : rectOf(top - rowShift, top + ROW_HEIGHT - rowShift)
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
    document.body.style.userSelect = ''
    Reflect.deleteProperty(document, 'elementFromPoint') // 按用例补的桩，别漏给下一条用例
})

/**
 * jsdom 没有 `elementFromPoint`（连方法都不存在），而钉住结束时正要用它判定"指针还在不在面板/组头上"。
 * 这里按用例补一个返回固定元素的桩：传 null 表示"指针处什么都没有"。
 */
function stubElementFromPoint(el: Element | null) {
    const fn = vi.fn(() => el)
    Object.defineProperty(document, 'elementFromPoint', {value: fn, writable: true, configurable: true})
    return fn
}

function renderDrawer(search = '') {
    // 真实 ref：二级面板的定位要读 drawerRef.current 的矩形（{current: null} 会让面板开不出来）
    const drawerRef = {current: null as HTMLDivElement | null}
    const utils = render(
        <ProjectGroupDrawer drawerRef={drawerRef} search={search} setSearch={() => {}} onClose={() => {}}/>,
    )
    scrollEl = document.querySelector('[data-drag-scroll]') as HTMLElement
    if (!scrollEl) throw new Error('缺少滚动容器 data-drag-scroll')
    return utils
}

/** 展开某组的二级面板（成员行在那里）：层 1 拖不动成员，所有成员相关的用例都必须先走这一步 */
async function openPanel(groupName = '组A') {
    fireEvent.mouseEnter(screen.getByText(groupName))
    await waitFor(() => expect(document.querySelector('[data-name="drawer-group-panel"]')).toBeTruthy())
}

function row(name: string): HTMLElement {
    const el = document.querySelector(`[data-name="${name}"]`)
    if (!el) throw new Error(`缺少行 ${name}`)
    return el as HTMLElement
}

/** 按下 + 拖到目标点（一次 pointermove 同时越过阈值并算出落点） */
function pressAndDrag(name: string, from: [number, number], to: [number, number]) {
    fireEvent.pointerDown(row(name), {clientX: from[0], clientY: from[1], button: 0})
    fireEvent.pointerMove(window, {clientX: to[0], clientY: to[1]})
}

function releaseAt(x: number, y: number) {
    fireEvent.pointerUp(window, {clientX: x, clientY: y})
}

/** 无任何写操作（五落点表之外的组合一律不落库） */
function expectNoWrites() {
    expect(groupState.assign).not.toHaveBeenCalled()
    expect(groupState.reorderGroups).not.toHaveBeenCalled()
    expect(groupState.reorderProjects).not.toHaveBeenCalled()
}

describe('ProjectGroupDrawer — 拖拽五落点', () => {
    it('1) 未分组项目拖到组头 → assign(path, groupId)', async () => {
        renderDrawer()
        pressAndDrag('drawer-top-project-0', [100, 140], [100, 20]) // 未分组 /ws/c → 组A 组头
        expect(document.querySelector('.drawer-drop-over')?.textContent).toContain('组A') // 落点高亮
        releaseAt(100, 20)
        expect(groupState.assign).toHaveBeenCalledWith('/ws/c', 'pg-a')
        expect(groupState.reorderGroups).not.toHaveBeenCalled()
        expect(groupState.reorderProjects).not.toHaveBeenCalled()
        await Promise.resolve()
    })

    it('2) 面板成员行拖到另一组 → assign(path, otherGroupId)', async () => {
        renderDrawer()
        await openPanel()
        pressAndDrag('drawer-group-member-0', [400, 50], [100, 60]) // /ws/a → 组B 组头
        releaseAt(100, 60)
        expect(groupState.assign).toHaveBeenCalledWith('/ws/a', 'pg-b')
        expect(groupState.reorderProjects).not.toHaveBeenCalled()
    })

    it('3) 面板成员行拖到未分组区 → assign(path, null)', async () => {
        renderDrawer()
        await openPanel()
        pressAndDrag('drawer-group-member-0', [400, 50], [100, 140]) // /ws/a → 未分组区 /ws/c
        releaseAt(100, 140)
        expect(groupState.assign).toHaveBeenCalledWith('/ws/a', null)
    })

    it('4) 面板成员行上下换位 → reorderProjects(groupId, newOrder)', async () => {
        renderDrawer()
        await openPanel()
        // 拖到 /ws/b 行的**下半**（中线 100 以下，y=110 更靠近"b 之后"的间隙）
        pressAndDrag('drawer-group-member-0', [400, 50], [400, 110])
        expect(document.querySelector('.drawer-insert-line')).toBeTruthy() // 插入线
        releaseAt(400, 110)
        expect(groupState.reorderProjects).toHaveBeenCalledWith('pg-a', ['/ws/b', '/ws/a'])
        expect(groupState.assign).not.toHaveBeenCalled()
    })

    it('4b) 面板内反向排序（成员 b 拖到 a 之前）→ reorderProjects 反向', async () => {
        renderDrawer()
        await openPanel()
        pressAndDrag('drawer-group-member-1', [400, 90], [400, 50]) // /ws/b → /ws/a 上半（插到 a 之前）
        releaseAt(400, 50)
        expect(groupState.reorderProjects).toHaveBeenCalledWith('pg-a', ['/ws/b', '/ws/a'])
        expect(groupState.assign).not.toHaveBeenCalled()
    })

    it('5) 组头上下换位 → reorderGroups(newOrder)', async () => {
        renderDrawer()
        pressAndDrag('drawer-group-header-pg-a', [100, 20], [100, 60]) // 组A 组头 → 组B 组头
        releaseAt(100, 60)
        expect(groupState.reorderGroups).toHaveBeenCalledWith(['pg-b', 'pg-a'])
        expect(groupState.assign).not.toHaveBeenCalled()
    })

    it('6) 位移 2px 后抬起 → 视为点击，不触发任何写操作', () => {
        renderDrawer()
        const target = row('drawer-top-project-0')
        fireEvent.pointerDown(target, {clientX: 100, clientY: 140, button: 0})
        fireEvent.pointerMove(window, {clientX: 102, clientY: 142}) // √8 ≈ 2.83 < 4
        fireEvent.pointerUp(window, {clientX: 102, clientY: 142})
        expectNoWrites()
        expect(document.querySelector('.drawer-insert-line')).toBeNull() // 没进拖拽态
        expect(document.body.style.userSelect).not.toBe('none')
        // 阈值内 = 点击：随后的 click 必须照常生效（拖拽抑制没被误触发）
        fireEvent.click(target)
        expect(convState.setWorkspace).toHaveBeenCalledWith('/ws/c')
    })

    it('7) 拖拽中按 Esc → 取消，不落库', async () => {
        renderDrawer()
        await openPanel()
        pressAndDrag('drawer-group-member-0', [400, 50], [100, 60])
        expect(document.querySelector('.drawer-insert-line') ?? document.querySelector('.drawer-drop-over')).toBeTruthy()
        fireEvent.keyDown(window, {key: 'Escape'})
        expectNoWrites()
        expect(document.body.style.userSelect).not.toBe('none') // 副作用已还原
        // 取消后再抬手也不会落库（监听已摘）
        releaseAt(100, 60)
        expectNoWrites()
    })

    it('8) 搜索态（search 非空）→ 按下拖动不进入拖拽', async () => {
        renderDrawer('ws')
        // 搜索态面板不开（§6.1 回归修复）：成员已内联在层 1（drawer-search-member-*）
        expect(row('drawer-search-member-pg-a-0')).toBeTruthy() // 命中行确实在（不是空列表导致的假通过）
        pressAndDrag('drawer-search-member-pg-a-0', [100, 50], [100, 20]) // 拖到组A 组头
        expect(document.querySelector('.drawer-insert-line')).toBeNull()
        expect(document.querySelector('.drawer-drop-over')).toBeNull()
        releaseAt(100, 20)
        expectNoWrites()
    })

    it('拖拽期间显示跟手预览，含被拖项目名', () => {
        renderDrawer()
        pressAndDrag('drawer-top-project-0', [100, 140], [100, 20])
        const ghost = document.querySelector('[data-name="drawer-drag-ghost"]')
        expect(ghost?.textContent).toBe('c')
        releaseAt(100, 20)
        expect(document.querySelector('[data-name="drawer-drag-ghost"]')).toBeNull() // 抬手即清理
    })
})

describe('ProjectGroupDrawer — 拖拽与既有交互不冲突', () => {
    it('拖拽结束后浏览器补发的 click 不切视图（组头）', () => {
        renderDrawer()
        pressAndDrag('drawer-group-header-pg-a', [100, 20], [100, 60])
        releaseAt(100, 60)
        fireEvent.click(row('drawer-group-header-pg-a')) // 拖拽后浏览器紧随补发的那次 click
        expect(convState.setProjectGroupView).not.toHaveBeenCalled()
    })

    it('组头落在自己身上 = 无变化，不写 reorderGroups', () => {
        renderDrawer()
        // 位移 10px（已进入拖拽态）但落点仍是自己 → 顺序没变，不写
        pressAndDrag('drawer-group-header-pg-a', [100, 20], [100, 30])
        releaseAt(100, 30)
        expectNoWrites()
    })

    it('未分组项目落回未分组区 = 无变化，不写 assign', () => {
        renderDrawer()
        pressAndDrag('drawer-top-project-0', [100, 140], [100, 150])
        releaseAt(100, 150)
        expectNoWrites()
    })

    it('拖到空白处（无落点）抬起 → 取消，不落库', async () => {
        renderDrawer()
        await openPanel()
        pressAndDrag('drawer-group-member-0', [400, 50], [100, 999])
        releaseAt(100, 999)
        expectNoWrites()
    })

    it('搜索框仍在、行仍可点击（拖拽接线不影响既有交互）', () => {
        renderDrawer()
        expect(screen.getByPlaceholderText('搜索项目…')).toBeTruthy()
        fireEvent.click(row('drawer-top-project-0'))
        expect(convState.setWorkspace).toHaveBeenCalledWith('/ws/c')
    })

    it('拖拽中 hover 别的组头不会打开二级面板（否则落点表会被浮层搅乱）', async () => {
        renderDrawer()
        pressAndDrag('drawer-top-project-0', [100, 140], [100, 20]) // 已进入拖拽态
        fireEvent.mouseEnter(row('drawer-group-header-pg-b'))
        // 等过 120ms 的打开延时。包在 act 里：拖拽期间 rAF 循环本身也在写 state，
        // 裸等真实计时器会让那些更新落在 act 之外（React 会告警）
        await act(async () => { await new Promise((r) => setTimeout(r, 160)) })
        expect(document.querySelector('[data-name="drawer-group-panel"]')).toBeNull()
        releaseAt(100, 20)
    })
})

describe('ProjectGroupDrawer — 组区空白不是落点（回归：容器整块兜底）', () => {
    it('空组占位文字区（组块内、行之外）不写库', async () => {
        renderDrawer()
        await openPanel()
        pressAndDrag('drawer-group-member-0', [400, 50], [100, 100]) // 84..120 = 组B 空组占位
        expect(document.querySelector('.drawer-insert-line')).toBeNull()
        expect(document.querySelector('.drawer-drop-over')).toBeNull()
        releaseAt(100, 100)
        expectNoWrites() // 组块内的空白若被当成"未分组区"，会把 /ws/a 静默移出组
    })

    it('组块之间的 mb-1 间隙（40..44）不写库', async () => {
        renderDrawer()
        await openPanel()
        pressAndDrag('drawer-group-member-0', [400, 50], [100, 42])
        releaseAt(100, 42)
        expectNoWrites()
    })

    it('未分组区非空时不再有容器兜底：最后一行之下的空白也不是落点', async () => {
        renderDrawer()
        await openPanel()
        pressAndDrag('drawer-group-member-0', [400, 50], [100, 300]) // 未分组行 124..164 之下、容器内
        releaseAt(100, 300)
        expectNoWrites()
    })

    it('全部归组（未分组区为空）时：最后一个组块之下仍是"移出组"的落点', async () => {
        groupState.groups[1].members.push({projectPath: '/ws/c', groupOrder: 0})
        try {
            renderDrawer()
            await openPanel()
            // 组B 块此时没有占位文字 → 块底 = 44 + 40 = 84；84 之下 = 空态未分组区渲染的位置 → §6.3 第 3 行仍有落点
            pressAndDrag('drawer-group-member-0', [400, 50], [100, 300])
            releaseAt(100, 300)
            expect(groupState.assign).toHaveBeenCalledWith('/ws/a', null)
        } finally {
            groupState.groups[1].members.pop()
        }
    })
})

/**
 * 面板根**整体**不是落点（集成级回归）。
 *
 * 上面那组用例盯的是"抽屉根里的空白"，这组盯的是"面板根里的空白 / 非行区域"：
 * 面板根没有 `data-drag-row="top"`，`collectDropZones(面板根)` 的 `topCount === 0` 成立，
 * 于是面板头行、空组占位文字、面板内空白一度被整块注册成 `top-level` 落点 ——
 * 成员拖到上面会走 `assign(path, null)` **静默移出组**。
 *
 * 这条缺陷在 jsdom 里曾经测不出来：面板根在 `layoutRect` 里落到零矩形（key `'::'`），
 * 而兜底分支要求 `container.width/height > 0` —— 分支压根不会被执行到，用例无从发现。
 * 现在面板根有了真实矩形（`PANEL_TOP..PANEL_BOTTOM × PANEL_LEFT..PANEL_RIGHT`），
 * 这几条用例才真的"有资格"发现它。
 */
describe('ProjectGroupDrawer — 面板根的非行区域不是落点（集成级：空态兜底只属于抽屉根）', () => {
    it('成员落在面板头行（面板内部 0..40）→ 不落库、也不画插入线', async () => {
        renderDrawer()
        await openPanel()
        pressAndDrag('drawer-group-member-0', [400, 50], [400, 20])
        expect(document.querySelector('.drawer-insert-line')).toBeNull()
        expect(document.querySelector('.drawer-drop-over')).toBeNull()
        releaseAt(400, 20)
        expectNoWrites() // 修前：assign('/ws/a', null) —— 静默移出组
    })

    it('成员落在「添加项目」行（面板内末段空白）→ 不落库', async () => {
        renderDrawer()
        await openPanel()
        // 成员行占 40..120；120 之下到面板根底边 200 = 「添加项目」行（它不是 data-drag-row）
        pressAndDrag('drawer-group-member-0', [400, 50], [400, 180])
        expect(document.querySelector('.drawer-insert-line')).toBeNull()
        releaseAt(400, 180)
        expectNoWrites()
    })

    it('落在空组面板的占位文字区 → 不落库、也不画插入线', async () => {
        renderDrawer()
        await openPanel('组B') // 组B 在本次夹具里是空组：面板里一个成员行都没有 → 整块面板都是"非行区域"
        // 空组面板里没有成员可拖 → 用组头做载荷（到不了写库那一步），断言点放在"落点表本身"：
        // 兜底一旦生效，hoverTarget 会变成 top-level，未分组区会画出一条假的插入线。
        pressAndDrag('drawer-group-header-pg-a', [100, 20], [400, 60])
        expect(document.querySelector('.drawer-insert-line')).toBeNull()
        expect(document.querySelector('.drawer-drop-over')).toBeNull()
        releaseAt(400, 60)
        expectNoWrites()
    })
})

describe('ProjectGroupDrawer — 面板滚动后的落点重采（extraScrollRefs 接线）', () => {
    /**
     * 让面板处于"已向下滚过"的状态。jsdom 的 scrollTop 赋值不生效（无布局引擎），
     * 与抽屉容器同一个处理：定义成可写属性。
     */
    function scrollPanelTo(value: number) {
        const panelEl = document.querySelector('[data-name="drawer-group-panel"]') as HTMLElement
        let current = value
        Object.defineProperty(panelEl, 'scrollTop', {
            configurable: true,
            get: () => current,
            set: (next: number) => {
                current = next
            },
        })
        return panelEl
    }

    it('滚轮滚面板（没有 pointermove）也要重采：落点判定基于滚动后的新位置', async () => {
        renderDrawer()
        await openPanel()
        pressAndDrag('drawer-group-member-0', [400, 50], [400, 35])
        // 未滚动时 y=35 谁都命中不到（面板头行 0..40 不是落点、成员 a 从 40 起、兜底已按守卫关闭）
        expect(document.querySelector('.drawer-insert-line')).toBeNull()

        const panelEl = scrollPanelTo(80) // 面板下滚 80：成员 a → -40..0、成员 b → 0..40（中线 20）
        fireEvent.scroll(panelEl) // 面板自身的滚动 = 落点表整体偏移 → 必须重采

        // y=35 落在"滚动后"的成员 b 下半 → 插到 b 之后（index 2）
        expect(document.querySelector('.drawer-insert-line')).toBeTruthy()
        releaseAt(400, 35)
        expect(groupState.reorderProjects).toHaveBeenCalledWith('pg-a', ['/ws/b', '/ws/a'])
        expect(groupState.assign).not.toHaveBeenCalled()
    })
})

describe('ProjectGroupDrawer — 钉住（拖拽 / 菜单）结束后自动收面板', () => {
    const PANEL = '[data-name="drawer-group-panel"]'

    it('拖拽在面板外结束 → 宽限期后自动关闭（不用等鼠标下次进出组头）', async () => {
        renderDrawer()
        await openPanel()
        const fromPoint = stubElementFromPoint(null) // 抬手处既不在面板里、也不在组头上
        pressAndDrag('drawer-group-member-0', [400, 50], [100, 140]) // 面板成员 → 未分组区
        releaseAt(100, 140)
        expect(fromPoint).toHaveBeenCalled() // 判定真的走了 elementFromPoint，不是"压根没判"
        expect(document.querySelector(PANEL)).toBeTruthy() // 宽限期内仍在（不是"抬手即关"）
        await waitFor(() => expect(document.querySelector(PANEL)).toBeNull())
    })

    it('拖拽在面板内结束（elementFromPoint 命中面板）→ 保持打开', async () => {
        renderDrawer()
        await openPanel()
        stubElementFromPoint(document.querySelector(PANEL))
        pressAndDrag('drawer-group-member-0', [400, 50], [400, 110]) // 面板内换位
        releaseAt(400, 110)
        await new Promise((r) => setTimeout(r, 260)) // 超过 200ms 宽限
        expect(document.querySelector(PANEL)).toBeTruthy()
    })
})

describe('ProjectGroupDrawer — 自动滚动下的落点时效性（回归：陈旧落点表）', () => {
    const rafCallbacks = new Map<number, FrameRequestCallback>()
    let rafSeq = 0

    beforeEach(() => {
        rafCallbacks.clear()
        rafSeq = 0
        // 用可控 rAF 驱动自动滚动：指针贴在容器顶边不动，让内容在它底下滚过去
        vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
            const id = ++rafSeq
            rafCallbacks.set(id, cb)
            return id
        })
        vi.stubGlobal('cancelAnimationFrame', (id: number) => {
            rafCallbacks.delete(id)
        })
    })

    afterEach(() => {
        vi.unstubAllGlobals()
        rafCallbacks.clear()
    })

    function flushFrames(n: number) {
        for (let i = 0; i < n; i++) {
            const due = [...rafCallbacks.values()]
            rafCallbacks.clear()
            for (const cb of due) cb(performance.now())
        }
    }

    /** 让容器先处于"已向下滚过"的状态（行坐标随 scrollTop 上移） */
    function setInitialScrollTop(value: number) {
        let current = value
        Object.defineProperty(scrollEl, 'scrollTop', {
            configurable: true,
            get: () => current,
            set: (next: number) => {
                current = next
            },
        })
    }

    it('指针不动也随滚动重采：高亮跟随内容，抬手落在滚动后指针下的那一行', async () => {
        renderDrawer()
        await openPanel()
        setInitialScrollTop(100)
        // 指针贴顶边（<24px）→ 触发自动向上滚动；此刻指针处没有任何行（组头 -100..-60、未分组行 24..64）
        pressAndDrag('drawer-group-member-0', [400, 50], [100, 10])
        expect(document.querySelector('.drawer-drop-over')).toBeNull()

        act(() => flushFrames(12)) // 12 帧 × 8px = 96px：组A 组头从 -100..-60 滚到 -4..36，正落在指针下

        expect(document.querySelector('.drawer-drop-over')?.textContent).toContain('组A') // 插入线/高亮跟随内容
        releaseAt(100, 10)
        expect(groupState.assign).toHaveBeenCalledWith('/ws/a', 'pg-a') // 陈旧表在 y=10 什么都命中不了 → 不写
        expect(groupState.reorderProjects).not.toHaveBeenCalled()
    })
})
