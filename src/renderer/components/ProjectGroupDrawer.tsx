/**
 * 项目抽屉内容（spec §6 / §16）：两层结构 —— 层 1 = 组头列表 + 顶层项目，
 * 层 2 = 组头 hover 展开的二级面板（成员项目 + 「添加项目」，Chrome 标签组式 flyout）。
 *
 * 为什么层 2 要 portal 到 body：抽屉根节点是 `position: fixed` + transform + overflow-hidden，
 * 就地渲染的浮层既会被裁掉、fixed 又会以抽屉为 containing block 而错位（与拖拽跟手预览、右键菜单同理）。
 * 代价是面板不在 `drawerRef` 子树里 —— 侧栏"点外部关抽屉"的 document mousedown 会命中它，
 * 所以面板必须自己 `stopPropagation`（见面板 JSX 注释）。
 *
 * 职责边界：
 *  · 本组件**只渲染内容**（根节点 = 自带动画参数的 motion.div，`left/top/maxHeight` 由侧栏按
 *    `left-sidebar-card` 实测坐标写入根节点 style）；portal 由调用方负责 —— 侧栏的 `WorkspaceDrawerPortal`
 *    把内容挂到 body，避免 `.bg-enabled` 下 `.app-surface-card` 的 backdrop-filter 成为
 *    后代 `position: fixed` 的 containing block（会连带 overflow-hidden 裁掉抽屉）。
 *  · Esc / 点击外部关闭、搜索状态同样由侧栏 `WorkspaceSelector` 持有 —— 与"抽屉只是个受控内容组件"
 *    保持一致（drawerRef 透传到本组件根节点，定位与点击外部判定都依赖它）。
 *  · 状态一律从 store 以 selector 读取（不接收 ctx prop）：组数据来自 projectGroupStore（唯一持有者），
 *    项目/作用域数据来自 conversationStore。
 *  · 拖拽（spec §6.3）：手势与落点判定在 `lib/pointerDrag`，本组件只负责"落点 → store 调用"
 *    （五种落点表见 handleDrop）、行的 `data-drag-row` 契约、插入线/高亮渲染。
 *    成员行在二级面板里（另一个根），所以落点表要把抽屉内容区与面板两块拼起来（§16.3）。
 *  · 面板开关（§16.1）：组头 hover 延时开、离开组头/面板宽限关；拖拽 / 右键菜单期间**钉住**
 *    （开与关都挂起）。钉住从"生效"回落到"结束"的那一刻要补一次判定：指针已不在面板 / 组头上
 *    就照常宽限关闭，命中则保持打开 —— 否则拖拽在远离面板处收尾后面板会一直悬着
 *    （见 `pointerOverPanelOrGroupHeader` 与钉住回落 effect）。
 */
import {
    Fragment,
    type MouseEvent as ReactMouseEvent,
    type PointerEvent as ReactPointerEvent,
    type RefObject,
    useEffect,
    useRef,
    useState,
} from 'react'
import {createPortal} from 'react-dom'
import {Folders} from 'lucide-react'
import {motion, type Transition} from 'framer-motion'
import {useConversationStore} from '../stores/conversationStore'
import {useProjectGroupStore} from '../stores/projectGroupStore'
import {fuzzyFilter, fuzzyMatch} from '../lib/search'
import {workspaceBadgeLabel, workspacePathSubtitle} from '../lib/workspacePath'
import {INPUT_FOCUS} from '../lib/inputFocus'
import {collectDropZones, usePointerDrag, type DragPayload, type DropTarget} from '../lib/pointerDrag'
import {confirm} from './ConfirmDialog'

/** 抽屉宽度（px）：全仓库唯一定义（侧栏定位计算与抽屉宽度共用；反向定义会造成循环导入） */
export const DRAWER_WIDTH = 300

/** 二级面板宽度（px）：定位时要预留宽度（越界判定），导出供测试断言 */
export const PANEL_WIDTH = 264

/**
 * 二级面板的最小高度（px）。
 *
 * 组头贴到视口底部时，"面板顶边对齐组头"这个基准会把面板挤出视口下沿（末尾几行永远点不到）。
 * 修法是让 top 上移，但"上移到哪里"必须有下限 —— 否则组头越靠下、面板被压得越扁，
 * 压到 0 高度时这个浮层等于不存在。MIN_PANEL_HEIGHT 同时兜住两件事：
 *  · top 的上移上限：`top <= innerHeight - MIN_PANEL_HEIGHT - 12`；
 *  · maxHeight 的下限：`maxHeight >= MIN_PANEL_HEIGHT`。
 * 两者必须引用同一个常量（分别写死会把"面板矩形落在视口内"这条不变量劈成两份）。
 * 导出供测试引用：几何钳制的断言要按同一个常量算，而不是抄一个数字。
 */
export const MIN_PANEL_HEIGHT = 120

/** 组头 hover 到二级面板出现的延时（ms）：太短会让"鼠标扫过组头"误开 */
const PANEL_OPEN_DELAY_MS = 120

/** 离开组头/面板到面板关闭的宽限（ms）：要够用户从组头移到面板（以及反向移回） */
const PANEL_CLOSE_GRACE_MS = 200

interface ProjectGroupDrawerProps {
    drawerRef: RefObject<HTMLDivElement | null>
    search: string
    setSearch: (v: string) => void
    onClose: () => void
}

/** 抽屉行展示模型（名称 = 路径末段；路径完整展示不截断） */
interface ProjectRow {
    path: string
    name: string
}

/** 顶层项目行：带「最近使用」排序键（只用于排序，不参与拖拽排序） */
type TopProjectRow = ProjectRow & {lastOpenedAt: number}

/** 组展示模型：成员已按 groupOrder（搜索态只剩命中成员） */
interface GroupView {
    id: string
    name: string
    members: ProjectRow[]
}

const FOLDER_ICON = 'M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z'

/** 右键菜单项统一样式（与 ConversationSidebar 的 GlobalContextMenu 同口径） */
const MENU_ITEM_CLASS = 'w-full flex items-center gap-2.5 px-3.5 py-2 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)] transition-colors'

/** 落位动画（spec §6.3「落位动画用 framer-motion」）：与 memo 面板 Reorder 的 FLIP 观感对齐 */
const LAYOUT_TRANSITION: Transition = {duration: 0.15, ease: 'easeOut'}

/** 行内加号图标（添加项目 / 创建项目组共用；className 由调用方决定是否带 shrink-0） */
function PlusIcon({className}: {className: string}) {
    return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <line x1="12" y1="5" x2="12" y2="19"/>
            <line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
    )
}

/** 行主体（文件夹图标 + 项目名 + 路径）：层 1 项目行 / 搜索成员行 / 面板成员行三处共用。
    iconName 仅为个别槽位的 data-name（不传则不渲染该属性）。 */
function ProjectRowBody({name, path, iconName}: {name: string; path: string; iconName?: string}) {
    const pathLabel = workspacePathSubtitle(path)
    return (
        <>
            <svg className="w-3.5 h-3.5 shrink-0 opacity-50" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" strokeWidth="2" aria-hidden="true" data-name={iconName}>
                <path d={FOLDER_ICON}/>
            </svg>
            <div className="flex-1 min-w-0">
                <div className="text-2xs font-medium truncate">{name}</div>
                <div className="text-2xs text-[var(--text-muted)] [overflow-wrap:anywhere]">{pathLabel}</div>
            </div>
        </>
    )
}

/** 行 hover 操作按钮对（文件管理器打开 / 移除）：未分组行与面板成员行共用。
    focusWithin：面板成员行可 Tab，需 group-focus-within 补键盘可见性；未分组行保持原样。
    removeLabel：两处文案不同（「从历史中移除」vs「移除项目」），aria 与 title 同源。 */
function ProjectRowActions({path, onRemove, focusWithin, openDataName, removeDataName, removeLabel}: {
    path: string
    onRemove: () => void
    focusWithin: boolean
    openDataName: string
    removeDataName: string
    removeLabel: string
}) {
    const hoverVisibility = focusWithin ? ' group-focus-within:opacity-100' : ''
    return (
        <>
            <button
                onClick={(e) => { e.stopPropagation(); window.electronAPI?.openPath?.(path) }}
                aria-label="在文件管理器中打开"
                title="在文件管理器中打开"
                className={`p-1 rounded text-[var(--text-muted)] hover:[color:var(--brand-primary)] opacity-0 group-hover:opacity-100${hoverVisibility} transition-all shrink-0`}
                data-name={openDataName}>
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d={FOLDER_ICON}/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/>
                </svg>
            </button>
            <button
                onClick={(e) => { e.stopPropagation(); onRemove() }}
                aria-label={removeLabel}
                title={removeLabel}
                className={`p-1 rounded text-[var(--text-muted)] hover:text-[var(--error)] opacity-0 group-hover:opacity-100${hoverVisibility} transition-all shrink-0`}
                data-name={removeDataName}>
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d="M18 6L6 18M6 6l12 12"/>
                </svg>
            </button>
        </>
    )
}

/** 落点相等判定（插入线 / 高亮的渲染条件） */
function sameTarget(a: DropTarget, b: DropTarget): boolean {
    if (a.kind === 'group' && b.kind === 'group') return a.groupId === b.groupId
    if (a.kind === 'group-member' && b.kind === 'group-member') return a.groupId === b.groupId && a.index === b.index
    if (a.kind === 'top-level' && b.kind === 'top-level') return a.index === b.index
    return false
}

/**
 * 二级面板的视口几何。
 *
 * 贴抽屉右缘 8px（越界则改为贴视口右侧，保证窄窗口下面板仍完整可见）；
 * 顶端对齐"该组组头"，高度吃满视口剩余空间（内容再多也只是面板内部滚动）。
 * 纯函数 + 只读 DOM 矩形，方便在滚动/尺寸变化时重算。
 *
 * 两条钳制都是为了"面板矩形完整落在视口内"：
 *  · top：组头贴视口底部时 `innerHeight - top - 12` 会小于面板内容高度甚至为负 ——
 *    面板下沿越出视口，末尾几行（含「添加项目」）够不着也滚不到。所以 top 先上钳到
 *    `innerHeight - MIN_PANEL_HEIGHT - 12`，maxHeight 再按**钳后**的 top 取
 *    `max(MIN_PANEL_HEIGHT, ...)`。两步必须共用钳后的 top：先按钳前的 top 算 maxHeight，
 *    面板照样越出底边（只是整体往上挪了一截、底部仍然漏在视口外）。
 *  · left：`innerWidth - PANEL_WIDTH - 8` 在极窄窗口下会算成负数，面板会有一半跑到屏幕左侧外。
 *    夹到 >= 8 —— 面板比视口还宽时右侧注定越界（无解），但至少左侧缘始终可见。
 */
function panelGeometry(drawerEl: HTMLElement, headerEl: HTMLElement) {
    const drawerRect = drawerEl.getBoundingClientRect()
    const top = Math.min(
        headerEl.getBoundingClientRect().top,
        window.innerHeight - MIN_PANEL_HEIGHT - 12,
    )
    return {
        left: Math.max(8, Math.min(drawerRect.right + 8, window.innerWidth - PANEL_WIDTH - 8)),
        top,
        maxHeight: Math.max(MIN_PANEL_HEIGHT, window.innerHeight - top - 12),
    }
}

/** 菜单归属（坐标另存）：组头右键 = group；组内项目行右键 = member */
type MenuTarget = {kind: 'group'; groupId: string} | {kind: 'member'; path: string}
type DrawerMenu = MenuTarget & {x: number; y: number}

/**
 * 指针是否还悬在二级面板内、或某个组头上（钉住结束时的"该不该收面板"判定）。
 *
 * 判定口径与 hover 的开关同源：面板根 `data-name="drawer-group-panel"`、组头 `data-drag-row="group"`
 * （后者本就是拖拽契约的一部分）。用命中测试而不是自己算矩形：面板在 portal 里、位置又是"抬手处"，
 * 交给浏览器最省事也最准。
 *
 * `point` 为 null（本次会话没拖过 / 指针从未进过 drag 态）与"环境没有 elementFromPoint"
 * （jsdom 连方法都没有，真实浏览器都有）一律按"不在"处理 —— 那就是"没有证据说明指针还在面板上"，
 * 按既有语义该关就关。
 */
function pointerOverPanelOrGroupHeader(point: {x: number; y: number} | null): boolean {
    if (!point) return false
    if (typeof document.elementFromPoint !== 'function') return false
    const el = document.elementFromPoint(point.x, point.y)
    return el !== null && el.closest('[data-name="drawer-group-panel"], [data-drag-row="group"]') !== null
}

export function ProjectGroupDrawer({drawerRef, search, setSearch, onClose}: ProjectGroupDrawerProps) {
    const currentWorkspacePath = useConversationStore((s) => s.currentWorkspacePath)
    const workspaces = useConversationStore((s) => s.workspaces)
    const viewScope = useConversationStore((s) => s.viewScope)
    const setWorkspace = useConversationStore((s) => s.setWorkspace)
    const ensureWorkspaceRegistered = useConversationStore((s) => s.ensureWorkspaceRegistered)
    const setProjectGroupView = useConversationStore((s) => s.setProjectGroupView)
    const focusProjectSegment = useConversationStore((s) => s.focusProjectSegment)
    const removeWorkspace = useConversationStore((s) => s.removeWorkspace)
    const groups = useProjectGroupStore((s) => s.groups)
    const createGroup = useProjectGroupStore((s) => s.create)
    const renameGroup = useProjectGroupStore((s) => s.rename)
    const dissolveGroup = useProjectGroupStore((s) => s.dissolve)
    const removeGroup = useProjectGroupStore((s) => s.remove)
    const assign = useProjectGroupStore((s) => s.assign)
    const reorderGroups = useProjectGroupStore((s) => s.reorderGroups)
    const reorderProjects = useProjectGroupStore((s) => s.reorderProjects)

    /** 拖拽滚动容器（内容区）：既是自动滚动的目标，也是落点采集的根 */
    const scrollRef = useRef<HTMLDivElement | null>(null)

    /**
     * 二级面板（组头 hover flyout，§16）：同一时刻最多一个，groupId + 视口几何。
     * 几何存在 state 里而不是每次渲染现算 —— 面板的定位基准是"组头当时的矩形"，
     * 而滚动会让这个基准变化，所以要在滚动/resize 时主动重算并写回（见下方 effect）。
     */
    const [panel, setPanel] = useState<{groupId: string; left: number; top: number; maxHeight: number} | null>(null)
    const panelRef = useRef<HTMLDivElement | null>(null)
    /** 面板的开关都走"延时"：一个用来等用户真的停在组头上，一个用来等用户从组头移到面板 */
    const panelOpenTimerRef = useRef<number | null>(null)
    const panelCloseTimerRef = useRef<number | null>(null)
    /**
     * "正在把焦点还给组头"的瞬时标记。
     * 面板里按 Esc 关闭后焦点要回到组头（否则焦点停在已卸载的节点上会掉到 body，
     * 键盘用户从此丢了位置），但组头的 onFocus 语义就是"打开面板" —— 不跳过一次的话
     * Esc 会立刻把面板又弹回来，形成"关不掉"的观感。focus() 同步派发事件，所以设完即复位。
     */
    const restoringFocusRef = useRef(false)

    /** 「创建项目组」内联输入态（Esc 取消输入但不关抽屉） */
    const [naming, setNaming] = useState(false)
    const [nameInput, setNameInput] = useState('')

    /** 右键菜单：组头菜单与组内项目菜单共用一份坐标状态 */
    const [menu, setMenu] = useState<DrawerMenu | null>(null)
    /** 组名行内重命名态（Enter 提交、Esc 取消） */
    const [renamingId, setRenamingId] = useState<string | null>(null)
    const [renameInput, setRenameInput] = useState('')
    /** 级联删除的部分失败提示（抽屉内联反馈，不引入全局 toast） */
    const [tip, setTip] = useState<string | null>(null)

    // 菜单关闭时机：点击外部 / 再次右键 / Esc。
    // Esc 必须用捕获阶段：侧栏的「Esc 关抽屉」挂在 document 的冒泡阶段，若这里也走冒泡，
    // 一次 Esc 会既关菜单又关抽屉（菜单还没来得及关，抽屉先没了）。
    useEffect(() => {
        if (!menu) return
        const close = () => setMenu(null)
        const onEsc = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return
            e.stopPropagation()
            close()
        }
        window.addEventListener('click', close)
        window.addEventListener('contextmenu', close)
        window.addEventListener('keydown', onEsc, true)
        return () => {
            window.removeEventListener('click', close)
            window.removeEventListener('contextmenu', close)
            window.removeEventListener('keydown', onEsc, true)
        }
    }, [menu])

    const scopedGroupId = viewScope?.type === 'group' ? viewScope.groupId : null
    const projectScopePath = viewScope?.type === 'project' ? viewScope.path : null

    // 顶层项目区 = 不属于任何组的项目，按最近使用（lastOpenedAt desc）；不参与拖拽排序
    const groupedPaths = new Set(groups.flatMap((g) => g.members.map((m) => m.projectPath)))
    const topRows: TopProjectRow[] = Object.entries(workspaces)
        .filter(([path]) => !groupedPaths.has(path))
        .map(([path, info]) => ({path, name: workspaceBadgeLabel(path), lastOpenedAt: info.lastOpenedAt}))
        .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)

    // 搜索：按层级显示 —— 组名命中 → 该组全部成员；否则只留命中成员；顶层项目命中直接列出
    const query = search.trim()
    const groupViews: GroupView[] = groups
        .map((g) => ({id: g.id, name: g.name, members: g.members.map((m) => ({path: m.projectPath, name: workspaceBadgeLabel(m.projectPath)}))}))
        .map((g) => (query && !fuzzyMatch(query, g.name)
            ? {...g, members: fuzzyFilter(g.members, query, ['name', 'path'])}
            : g))
        .filter((g) => !query || fuzzyMatch(query, g.name) || g.members.length > 0)
    const visibleTopRows = query ? fuzzyFilter(topRows, query, ['name', 'path']) : topRows

    // 顶层项目行的选中态 = 用户当前正在查看的项目。若该项目已归组（不在顶层区），
    // 则顶层区无任何行被选中（选中态落在组区）；无作用域时回退到当前工作区，维持原有高亮。
    const activePath = projectScopePath ?? currentWorkspacePath
    const isTopRowSelected = (path: string) => activePath !== null && path === activePath

    /**
     * 落点 → store 调用（spec §6.3 五落点表）。
     *  · 项目 → 组（组头或成员列表）= assign(path, groupId)；跨组迁入与顶层入组同一条路；
     *  · 项目 → 顶层区 = assign(path, null)；
     *  · 项目 ↕ 自己所在组的成员列表 = reorderProjects(groupId, newOrder)；
     *  · 组头 ↕ 组间 = reorderGroups(newOrder)。
     * 表外的组合（例如组头落到项目区）不落库；"原位落回"也不算变化，不写（免得白跑一次 IPC）。
     */
    const handleDrop = (payload: DragPayload, target: DropTarget) => {
        if (payload.kind === 'project') {
            const path = payload.projectPath
            if (target.kind === 'top-level') {
                if (!groupedPaths.has(path)) return // 本来就在顶层区 → 无变化
                void assign(path, null)
                return
            }
            if (target.kind === 'group') {
                void assign(path, target.groupId)
                return
            }
            const group = groups.find((g) => g.id === target.groupId)
            if (!group) return
            const order = group.members.map((m) => m.projectPath)
            const fromIndex = order.indexOf(path)
            if (fromIndex === -1) {
                void assign(path, target.groupId) // 跨组：迁入目标组
                return
            }
            // 拖动项先摘出，插入位置要按"摘出后"的下标换算（index 是行间隙，含列表末尾）
            const next = order.filter((p) => p !== path)
            next.splice(target.index > fromIndex ? target.index - 1 : target.index, 0, path)
            if (next.join('\n') === order.join('\n')) return // 原位落回 → 无变化
            void reorderProjects(target.groupId, next)
            return
        }
        // 组头只能落在组头上（组间排序）；落到自己身上或项目区 = 无变化
        if (target.kind !== 'group' || target.groupId === payload.groupId) return
        const ids = groups.map((g) => g.id)
        const from = ids.indexOf(payload.groupId)
        const to = ids.indexOf(target.groupId)
        if (from === -1 || to === -1) return
        const next = ids.filter((id) => id !== payload.groupId)
        next.splice(to, 0, payload.groupId)
        void reorderGroups(next)
    }

    const {drag, pointer, hoverTarget, onPointerDown: startDrag, suppressClickRef} = usePointerDrag({
        onDrop: handleDrop,
        // 成员行在二级面板里（portal 到 body，不在 scrollRef 子树内）→ 两个根都要采。
        // rect 是视口坐标，天然可以跨根拼成一张落点表。
        collectZones: () => [...collectDropZones(scrollRef.current), ...collectDropZones(panelRef.current)],
        scrollContainerRef: scrollRef,
        // 面板自身可滚动：它一滚落点表整体偏移，也要重采（自动滚动仍只作用于抽屉内容区）
        extraScrollRefs: [panelRef],
    })

    const clearPanelTimers = () => {
        if (panelOpenTimerRef.current !== null) {
            window.clearTimeout(panelOpenTimerRef.current)
            panelOpenTimerRef.current = null
        }
        if (panelCloseTimerRef.current !== null) {
            window.clearTimeout(panelCloseTimerRef.current)
            panelCloseTimerRef.current = null
        }
    }

    // 卸载时清定时器：回调里会 setPanel，卸载后再触发就是对着已卸载组件写状态
    useEffect(() => clearPanelTimers, [])

    /** 立即展开某组的面板（几何按"此刻"的组头矩形算） */
    const openPanelNow = (groupId: string) => {
        const drawerEl = drawerRef.current
        // 组头的 DOM 契约由 data-name 提供（与测试同源），避免为此再存一份行节点引用
        const headerEl = drawerEl?.querySelector<HTMLElement>(`[data-name="drawer-group-header-${groupId}"]`)
        if (!drawerEl || !headerEl) return
        setPanel({groupId, ...panelGeometry(drawerEl, headerEl)})
    }

    /**
     * 展开二级面板（同一时刻只有一个：后进入的组直接顶掉前一个）。
     *
     * 默认走 `PANEL_OPEN_DELAY_MS` 延时（鼠标扫过组头不该开面板）；
     * `immediate` 用于键盘 —— 焦点进组头 = 用户按 Tab 主动走到这里，没有"扫过"这回事，
     * 再等 120ms 只会让面板迟到（而且这期间按 Tab 已经走了）。
     *
     * 拖拽中不开：拖组头经过别的组会一路乱开面板，把落点判定搅乱。
     * 右键菜单打开时也不开：那时鼠标停在菜单上，hover 只是路过。
     * 原地改名中不开：鼠标就停在组头上（重命名输入框在组头里），面板会盖在输入框旁边。
     */
    const schedulePanelOpen = (groupId: string, immediate = false) => {
        // 搜索态不开面板：成员已在层 1 内联渲染（见下方搜索态成员渲染），hover 面板多余且会遮住内联行
        if (query) return
        if (drag !== null || menu !== null) return
        if (renamingId === groupId) return
        // 已有一个组头在等待打开 → 换成新的那个（其余动作都一样）
        clearPanelTimers()
        // 切到别的组头：旧面板对"当前这一组"已经没有意义，不能等宽限期 ——
        // 宽限期内的面板**仍然是有效的拖拽落点根**（collectZones 照采），用户在新组头上松手
        // 会把项目落进旧组的成员行里；观感上也是"移过去了旧面板还挂在那儿"。
        if (panel !== null && panel.groupId !== groupId) setPanel(null)
        if (immediate) {
            openPanelNow(groupId)
            return
        }
        panelOpenTimerRef.current = window.setTimeout(() => {
            panelOpenTimerRef.current = null
            openPanelNow(groupId)
        }, PANEL_OPEN_DELAY_MS)
    }

    /**
     * 离开组头 / 面板 → 宽限后关闭。
     *
     * 宽限是必须的：组头与面板之间有 8px 空隙，鼠标移过去的一瞬间就已经离开了组头，
     * 立即关会让面板在用户到达之前消失。
     * 拖拽 / 右键菜单期间钉住不关：那时鼠标一定会离开面板（去拖行、去点菜单项）。
     */
    const schedulePanelClose = () => {
        if (drag !== null || menu !== null) return
        if (panelOpenTimerRef.current !== null) {
            window.clearTimeout(panelOpenTimerRef.current)
            panelOpenTimerRef.current = null
        }
        if (panelCloseTimerRef.current !== null) return // 已在倒计时
        panelCloseTimerRef.current = window.setTimeout(() => {
            panelCloseTimerRef.current = null
            setPanel(null)
        }, PANEL_CLOSE_GRACE_MS)
    }

    /** 重新进入面板 = 取消待关闭 */
    const cancelPanelClose = () => {
        if (panelCloseTimerRef.current !== null) {
            window.clearTimeout(panelCloseTimerRef.current)
            panelCloseTimerRef.current = null
        }
    }

    // 钉住：拖拽 / 右键菜单一旦开始，把"待关闭"和"待打开"都清掉，之后也不再有 hover 来续命
    useEffect(() => {
        if (drag === null && menu === null) return
        clearPanelTimers()
    })

    /**
     * 钉住结束时判定"指针还在不在面板 / 某个组头上"要用的最后已知位置。
     *
     * 不能当帧直接读 `pointer`：拖拽收尾的 `teardown()` 里 `setDrag(null)` 与 `setPointer(null)`
     * 是**同一批**提交的 —— 钉住回落的那一帧 `pointer` 必然已是 null，当帧读它等于永远判"不在"，
     * 于是把成员拖回面板里也会被顺手关掉。所以把每个非空的指针位置镜像下来，判定时用抬手处。
     */
    const lastPointerRef = useRef<{x: number; y: number} | null>(null)
    useEffect(() => {
        if (pointer !== null) lastPointerRef.current = pointer
    })

    /**
     * 钉住（拖拽 / 右键菜单）从 true 回落到 false 的那一刻：指针若已不在面板内、也不在某个组头上，
     * 就照常走宽限关闭。
     *
     * 补这一步的理由：钉住期间没有任何 hover 事件来"续命"，收尾也不会补一发"离开组头/面板"，
     * 于是拖拽在远离面板处结束（或菜单关掉）后，面板会一直悬着，直到鼠标下次进出组头/面板才被顺手关掉。
     * 命中面板 / 组头时保持打开（不新开、只保留）：那是"把项目拖到面板里 / 拖到组头上"的正常收尾，
     * 此刻把面板收掉反而把用户刚操作的东西藏了。
     */
    const pinned = drag !== null || menu !== null
    const wasPinnedRef = useRef(false)
    useEffect(() => {
        const wasPinned = wasPinnedRef.current
        wasPinnedRef.current = pinned
        if (!wasPinned || pinned) return
        if (pointerOverPanelOrGroupHeader(lastPointerRef.current)) return
        schedulePanelClose()
    })

    const panelGroupId = panel?.groupId ?? null

    /** 面板要渲染的组：组被删掉 / 被搜索过滤掉时面板自动消失，不需要手动清状态 */
    const panelGroup = panelGroupId === null ? null : groupViews.find((g) => g.id === panelGroupId) ?? null

    /**
     * 面板内的 `Esc`：只关面板（不落库、不关抽屉），关闭后焦点回到该组头。
     * 调用处负责 `e.stopPropagation()` —— 侧栏的「Esc 关抽屉」挂在 document 的冒泡阶段
     * （ConversationSidebar.tsx），不拦就会一次 Esc 关两样（既有先例：组名重命名输入框的 Esc）。
     * 焦点回还见 `restoringFocusRef`（不跳过就会立刻重开）。
     */
    const closePanelAndRestoreFocus = () => {
        const groupId = panelGroupId
        clearPanelTimers()
        setPanel(null)
        if (groupId === null) return
        const headerEl = drawerRef.current?.querySelector<HTMLElement>(`[data-name="drawer-group-header-${groupId}"]`)
        if (!headerEl) return
        restoringFocusRef.current = true
        headerEl.focus()
        restoringFocusRef.current = false
    }

    // 面板是 fixed + 视口坐标：抽屉内容区一滚（或窗口尺寸变化），"组头在哪"就失效了 → 重算
    useEffect(() => {
        if (!panelGroupId) return
        const reposition = () => {
            const drawerEl = drawerRef.current
            const headerEl = drawerEl?.querySelector<HTMLElement>(`[data-name="drawer-group-header-${panelGroupId}"]`)
            if (!drawerEl || !headerEl) return
            const geometry = panelGeometry(drawerEl, headerEl)
            setPanel((prev) => (prev && prev.groupId === panelGroupId ? {...prev, ...geometry} : prev))
        }
        const scrollEl = scrollRef.current
        scrollEl?.addEventListener('scroll', reposition)
        window.addEventListener('resize', reposition)
        return () => {
            scrollEl?.removeEventListener('scroll', reposition)
            window.removeEventListener('resize', reposition)
        }
    }, [panelGroupId, drawerRef])

    /** 行按下 = 起手（是否进入拖拽由 4px/300ms 阈值决定）；搜索态禁用拖拽（过滤后的列表不是稳定排序视图） */
    const beginDrag = (e: ReactPointerEvent, payload: DragPayload) => {
        if (query) return
        startDrag(e, payload)
    }

    /** 拖拽结束后浏览器补发的 click 要吞掉（否则"拖回原位"会顺手切视图）；窗口过后自动失效 */
    const isClickSuppressed = () => performance.now() < suppressClickRef.current

    /** 插入线：拖拽中在落点间隙画一条品牌色横线（spec §6.3） */
    const insertLine = (at: DropTarget) => hoverTarget !== null && sameTarget(hoverTarget, at)
        ? <div className="drawer-insert-line h-0.5 mx-[var(--space-snug)] rounded-full bg-[var(--brand-primary)]"
               data-name="drawer-insert-line"/>
        : null

    const draggedLabel = drag === null
        ? ''
        : drag.kind === 'project'
            ? workspaceBadgeLabel(drag.projectPath)
            : groups.find((g) => g.id === drag.groupId)?.name ?? ''

    const handleTopAdd = async () => {
        const path = await window.electronAPI?.openFolderDialog?.()
        if (!path) return
        setWorkspace(path) // 落顶层 + 切到该项目视图（spec §6.2）
        onClose()
    }

    /** 组内「添加项目」：登记（store 的唯一口径）后按「生效键」入组，**停留组视图**（spec §6.2 / §15.1①） */
    const handleGroupAdd = async (groupId: string) => {
        const path = await window.electronAPI?.openFolderDialog?.()
        if (!path) return
        // 登记 + 生效键解析统一由 store 提供（同一目录的另一种写法不得再 create 出第二条记录，
        // 也不得把原始串当键写进成员里 —— 那样同一项目会同时出现在组内与顶层区）。
        const key = await ensureWorkspaceRegistered(path)
        if (!key) return // 登记未能确认 → 不 proceed
        await assign(key, groupId)
        // ★ I-4：停留组视图 + 定位该项目段（spec §6.2 层 2 / §15.1①）。
        //   登记已让该键进 workspaces（段可渲染），这里再请求把段滚入视野。
        focusProjectSegment(key)
    }

    const handleCreateGroup = async () => {
        const name = nameInput.trim()
        setNaming(false)
        setNameInput('')
        if (!name) return // 名称必填
        await createGroup(name)
    }

    /** 打开右键菜单（坐标取 clientX/clientY；阻止浏览器默认菜单与冒泡） */
    const openMenu = (e: ReactMouseEvent, target: MenuTarget) => {
        e.preventDefault()
        e.stopPropagation()
        setMenu({...target, x: e.clientX, y: e.clientY})
    }

    const startRename = (groupId: string, currentName: string) => {
        setMenu(null)
        setRenamingId(groupId)
        setRenameInput(currentName)
    }

    /** 行内重命名提交：空名视为放弃（与「创建项目组」的名称必填口径一致） */
    const commitRename = async () => {
        const id = renamingId
        const name = renameInput.trim()
        setRenamingId(null)
        setRenameInput('')
        if (!id || !name) return
        await renameGroup(id, name)
    }

    const cancelRename = () => {
        setRenamingId(null)
        setRenameInput('')
    }

    /**
     * 删除组（§4.2 级联语义）：
     *  · 空组 → 直接删组记录，不弹询问（D8）；
     *  · 非空组 → 询问。仅解散 = dissolve(id)；级联 = 顺序逐个 removeWorkspace，
     *    **失败继续不整体中止**（逐个独立事务，中止只会留下"半个组"，用户无从判断剩了什么），
     *    逐个 try/catch 收集失败路径，最后无论是否有失败都删组记录，并按失败数内联提示。
     */
    const handleDeleteGroup = async (groupId: string) => {
        setMenu(null)
        const group = groups.find((g) => g.id === groupId)
        if (!group) return
        setTip(null)
        if (group.members.length === 0) {
            await removeGroup(group.id) // 空组直删，不弹询问（D8）
            return
        }
        const cascade = await confirm({
            title: '删除项目组',
            message: `「${group.name}」中有 ${group.members.length} 个项目。\n是否同时删除这些项目及其全部对话数据？`,
            confirmText: '删除项目并移除数据',
            cancelText: '仅解散（保留项目）',
            confirmVariant: 'danger',
        })
        if (!cascade) {
            await dissolveGroup(group.id)
            return
        }
        const failed: string[] = []
        for (const member of group.members) {
            try {
                await removeWorkspace(member.projectPath)
            } catch {
                failed.push(member.projectPath) // 失败继续删其余项目
            }
        }
        await removeGroup(group.id)
        if (failed.length > 0) {
            setTip(`${group.members.length} 个项目中有 ${failed.length} 个删除失败：${failed.join('、')}`)
        }
    }

    const handleRemove = (path: string) => {
        // 仅确认框标题按 §3.2 映射（删除工作目录 → 移除项目）；正文/按钮文案不在本轮映射表内，保持原样
        confirm({
            title: '移除项目',
            message: `确定要删除"${path}"吗？该目录下的所有会话记录也会一并删除，此操作不可撤销。`,
            confirmText: '删除',
            confirmVariant: 'danger',
            onConfirm: () => removeWorkspace(path),
        })
    }

    const rowClass = 'group flex items-center gap-[var(--space-snug)] px-[var(--space-relaxed)] py-[var(--space-normal)] rounded-md transition-colors'

    // 菜单项（组头菜单 / 组内项目菜单两套）。开销点：每个菜单项都先关菜单再执行动作，
    // 避免动作引发的重渲染把菜单留在原地（例如"解散"后组头已不存在）。
    const m = menu
    const menuItems: {label: string; name: string; run: () => void}[] = m === null
        ? []
        : m.kind === 'group'
            ? [
                {
                    label: '重命名', name: 'drawer-group-menu-rename-button',
                    run: () => {
                        const group = groups.find((g) => g.id === m.groupId)
                        if (group) startRename(group.id, group.name)
                        else setMenu(null)
                    },
                },
                {
                    label: '解散', name: 'drawer-group-menu-dissolve-button',
                    run: () => {
                        setMenu(null)
                        void dissolveGroup(m.groupId)
                    },
                },
                {label: '删除组', name: 'drawer-group-menu-delete-button', run: () => void handleDeleteGroup(m.groupId)},
            ]
            : [
                {
                    label: '移出组', name: 'drawer-member-menu-ungroup-button',
                    run: () => {
                        setMenu(null)
                        void assign(m.path, null)
                    },
                },
                {
                    label: '在文件管理器中打开', name: 'drawer-member-menu-open-button',
                    run: () => {
                        setMenu(null)
                        window.electronAPI?.openPath?.(m.path)
                    },
                },
                {
                    label: '移除项目', name: 'drawer-member-menu-remove-button',
                    run: () => {
                        setMenu(null)
                        handleRemove(m.path)
                    },
                },
            ]

    return (
        <motion.div
            ref={drawerRef}
            initial={{opacity: 0, x: -12}}
            animate={{opacity: 1, x: 0}}
            transition={{duration: 0.15}}
            className={`fixed bg-[var(--surface)] border border-[var(--border-emphasis)] rounded-xl shadow-elevated overflow-hidden flex flex-col ${
                drag ? 'cursor-grab select-none' : ''
            }`}
            style={{zIndex: 9999, width: DRAWER_WIDTH}}
            role="listbox"
            aria-label="项目列表"
            data-name="project-group-drawer"
        >
            {/* 顶部按钮区 */}
            <div className="flex items-center gap-[var(--space-snug)] p-[var(--space-snug)] pb-0">
                <button
                    onClick={handleTopAdd}
                    className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-md text-2xs font-medium text-[var(--text-brand)] bg-[var(--brand-muted)] hover:bg-[var(--surface-overlay)] transition-colors"
                    data-name="drawer-add-project">
                    <PlusIcon className="w-3 h-3"/>
                    <span>添加项目</span>
                </button>
                <button
                    onClick={() => {
                        setNaming(true)
                        setNameInput('')
                    }}
                    className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-md text-2xs font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] transition-colors"
                    data-name="drawer-create-group">
                    <PlusIcon className="w-3 h-3"/>
                    <span>创建项目组</span>
                </button>
            </div>

            {/* 级联删除的部分失败提示（抽屉内联反馈，不引入全局 toast 体系） */}
            {tip && (
                <div
                    role="status"
                    className="mx-[var(--space-snug)] mt-[var(--space-snug)] px-2 py-1.5 rounded-md text-2xs text-[var(--error)] bg-[var(--error-muted)] [overflow-wrap:anywhere]"
                    data-name="drawer-group-tip">
                    {tip}
                </div>
            )}

            {/* 组名内联输入（「创建项目组」）：Enter 提交、Esc 取消输入但不关抽屉 */}
            {naming && (
                <div className="px-[var(--space-snug)] pt-[var(--space-snug)]">
                    <input
                        autoFocus
                        value={nameInput}
                        onChange={(e) => setNameInput(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') void handleCreateGroup()
                            if (e.key === 'Escape') {
                                e.stopPropagation() // 只取消输入，不让侧栏的全局 Esc 关掉抽屉
                                setNaming(false)
                                setNameInput('')
                            }
                        }}
                        placeholder="项目组名称"
                        aria-label="项目组名称"
                        className={`w-full px-2 py-1.5 text-2xs bg-[var(--surface-muted)] border border-[var(--border)] rounded-md text-[var(--text-primary)] placeholder-[var(--text-muted)] ${INPUT_FOCUS}`}
                        data-name="drawer-group-name-input"/>
                </div>
            )}

            {/* 搜索 */}
            <div className="p-[var(--space-snug)] pt-[var(--space-loose)] border-b border-[var(--border-muted)]">
                <div className="relative">
                    <svg className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-[var(--text-muted)]"
                         viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <circle cx="11" cy="11" r="8"/>
                        <line x1="21" y1="21" x2="16.65" y2="16.65"/>
                    </svg>
                    <input
                        autoFocus
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="搜索项目…"
                        aria-label="搜索项目…"
                        className={`w-full pl-6 pr-2 py-1.5 text-2xs bg-[var(--surface-muted)] border border-[var(--border)] rounded-md text-[var(--text-primary)] placeholder-[var(--text-muted)] ${INPUT_FOCUS}`}
                        data-name="conversation-sidebar-input"/>
                </div>
            </div>

            {/* 组区（层 1 = 组头；层 2 = 成员项目 + 「添加项目」）+ 顶层项目区 */}
            {/* data-drag-scroll = 落点采集的根 + 自动滚动的目标（collectDropZones 的 DOM 契约之一） */}
            <div ref={scrollRef} data-drag-scroll className="overflow-y-auto p-[var(--space-tight)] flex-1">
                {groupViews.map((group) => (
                    <motion.div layout transition={LAYOUT_TRANSITION} key={group.id} className="mb-1"
                                data-name={`drawer-group-${group.id}`} data-drag-group-block={group.id}>
                        <div
                            role="option"
                            aria-selected={scopedGroupId === group.id}
                            data-name={`drawer-group-header-${group.id}`}
                            data-drag-row="group"
                            data-group-id={group.id}
                            onPointerDown={(e) => beginDrag(e, {kind: 'group', groupId: group.id})}
                            // hover 展开二级面板（成员行都在那里）；延时/宽限的取舍见 schedulePanelOpen/Close
                            onMouseEnter={() => schedulePanelOpen(group.id)}
                            onMouseLeave={schedulePanelClose}
                            // 键盘 / AT：组头是面板（成员行 + 「添加项目」）的唯一入口，必须能被 Tab 到。
                            // D1 之前这条路径是组块里那个可 Tab 的「添加项目」按钮，按钮下沉后才丢的。
                            tabIndex={0}
                            // 焦点进入组头 = "移入"：键盘用户没有 hover 概念，而他本来就是按 Tab 主动走到这里的，
                            // 所以不要 120ms 延时（见 schedulePanelOpen 的 immediate）。
                            onFocus={() => {
                                if (restoringFocusRef.current) return // Esc 关面板后的焦点回还，不重开
                                schedulePanelOpen(group.id, true)
                            }}
                            // 焦点移出组头：若新焦点既不在组头内部（重命名输入框）也不在面板里 → 按宽限期关。
                            // 宽限期给的是"焦点落到面板里去"这条路（面板是 portal，与组头在 DOM 上并不相邻）。
                            onBlur={(e) => {
                                const next = e.relatedTarget as Node | null
                                if (next !== null && e.currentTarget.contains(next)) return
                                if (next !== null && panelRef.current?.contains(next)) return
                                schedulePanelClose()
                            }}
                            onClick={() => {
                                if (isClickSuppressed()) return // 刚拖完的那次 click 不切视图
                                setProjectGroupView(group.id)
                                onClose()
                            }}
                            onContextMenu={(e) => openMenu(e, {kind: 'group', groupId: group.id})}
                            className={`drawer-group-header cursor-pointer ${rowClass} ${
                                hoverTarget !== null && sameTarget(hoverTarget, {kind: 'group', groupId: group.id})
                                    ? 'drawer-drop-over bg-[var(--brand-muted)] text-[var(--text-brand)]'
                                    : scopedGroupId === group.id
                                        ? 'bg-[var(--brand-muted)] text-[var(--text-brand)]'
                                        : 'text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]'
                            }`}>
                            {/* 组 = 多文件夹（Folders），项目 = 单文件夹轮廓：两者形状必须一眼可分，
                                否则"组头"与"项目行"在同一列表里只靠缩进区分 */}
                            <Folders className="w-3.5 h-3.5 shrink-0 opacity-70" data-name="drawer-group-icon"
                                     aria-hidden="true"/>
                            {renamingId === group.id ? (
                                <input
                                    autoFocus
                                    value={renameInput}
                                    onChange={(e) => setRenameInput(e.target.value)}
                                    onClick={(e) => e.stopPropagation()} // 重命名中点击输入框不等于点击组头（不切组、不关抽屉）
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') void commitRename()
                                        if (e.key === 'Escape') {
                                            e.stopPropagation() // 只取消重命名，不让侧栏的全局 Esc 关掉抽屉
                                            cancelRename()
                                        }
                                    }}
                                    aria-label="项目组名称"
                                    className={`flex-1 min-w-0 px-1 py-0.5 text-2xs bg-[var(--surface-muted)] border border-[var(--border-emphasis)] rounded text-[var(--text-primary)] ${INPUT_FOCUS}`}
                                    data-name="drawer-group-rename-input"/>
                            ) : (
                                <span className="flex-1 min-w-0 truncate text-2xs font-semibold">{group.name}</span>
                            )}
                            {scopedGroupId === group.id && (
                                <svg className="w-3 h-3 [color:var(--brand-primary)] shrink-0" viewBox="0 0 24 24" fill="none"
                                     stroke="currentColor" strokeWidth="3" aria-hidden="true">
                                    <polyline points="20 6 9 17 4 12"/>
                                </svg>
                            )}
                        </div>

                        {/* 搜索态：命中成员内联渲染在层 1 组头下方（恢复旧路径，但仅搜索态启用）。
                            非搜索态成员只在 hover 面板里（§16.1），层 1 不渲染成员 —— 防回归。
                            为什么搜索态例外（对 D2「层 2 不可点」的搜索态例外）：
                            搜索是查找+切换场景，命中成员不可点等于搜索无用 —— 用户搜索就是为了切换到该项目。 */}
                        {query && group.members.map((member, i) => (
                            <div
                                key={member.path}
                                data-name={`drawer-search-member-${group.id}-${i}`}
                                className={`${rowClass} pl-[var(--space-loose)] ${
                                    isTopRowSelected(member.path)
                                        ? 'bg-[var(--brand-muted)] text-[var(--text-brand)]'
                                        : 'text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]'
                                }`}>
                                <button
                                    onClick={() => {
                                        setWorkspace(member.path)
                                        onClose()
                                    }}
                                    aria-current={isTopRowSelected(member.path) ? 'true' : undefined}
                                    className="flex-1 min-w-0 flex items-center gap-[var(--space-snug)] text-left cursor-pointer rounded"
                                    data-name={`drawer-search-member-open-${group.id}-${i}`}>
                                    <ProjectRowBody name={member.name} path={member.path}/>
                                </button>
                            </div>
                        ))}

                        {/* 空组占位：非搜索态引导用户 hover 添加；搜索态组名命中但无成员可列时，
                            "还没有项目"文案语义错误（用户在搜索，不是在管理空组）→ 改为"无匹配成员" */}
                        {group.members.length === 0 && (
                            <div
                                className="px-[var(--space-relaxed)] py-[var(--space-snug)] text-2xs text-[var(--text-muted)]"
                                data-name={`drawer-group-empty-${group.id}`}>
                                {query ? '无匹配成员' : '还没有项目，鼠标移入可添加或拖入项目'}
                            </div>
                        )}
                    </motion.div>
                ))}

                {/* 组区 / 未分组区之间的分隔线（§16.1）：只在两侧都有内容时才画 ——
                    否则是条悬空的分隔线（只有组时它下面没有"另一个区"可分隔）。
                    刻意不带 data-drag-row：它不是落点，也不能进落点表（顶层区兜底的上界
                    由 [data-drag-group-block] 决定，与这条线无关）。 */}
                {groupViews.length > 0 && visibleTopRows.length > 0 && (
                    <div
                        role="separator"
                        className="mx-[var(--space-snug)] my-[var(--space-snug)] border-t border-[var(--border-muted)]"
                        data-name="drawer-section-divider"/>
                )}

                {/* 未分组项目区（层 1 项目：可点 = 切该项目视图）；hover 操作沿用现状 */}
                {visibleTopRows.map((entry, i) => (
                    <Fragment key={entry.path}>
                        {insertLine({kind: 'top-level', index: i})}
                        <motion.div
                            layout
                            transition={LAYOUT_TRANSITION}
                            role="option"
                            aria-selected={isTopRowSelected(entry.path)}
                            data-drag-row="top"
                            data-index={i}
                            onPointerDown={(e) => beginDrag(e, {kind: 'project', projectPath: entry.path})}
                            onClick={() => {
                                if (isClickSuppressed()) return // 刚拖完的那次 click 不切项目
                                setWorkspace(entry.path)
                                onClose()
                            }}
                            className={`${rowClass} cursor-pointer ${
                                isTopRowSelected(entry.path)
                                    ? 'bg-[var(--brand-muted)] text-[var(--text-brand)]'
                                    : 'text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]'
                            }`}
                            data-name={`drawer-top-project-${i}`}>
                            <ProjectRowBody name={entry.name} path={entry.path} iconName="drawer-project-icon"/>
                            {isTopRowSelected(entry.path) && (
                                <svg className="w-3 h-3 [color:var(--brand-primary)] shrink-0" viewBox="0 0 24 24" fill="none"
                                     stroke="currentColor" strokeWidth="3" aria-hidden="true">
                                    <polyline points="20 6 9 17 4 12"/>
                                </svg>
                            )}
                            <ProjectRowActions
                                path={entry.path}
                                onRemove={() => handleRemove(entry.path)}
                                focusWithin={false}
                                openDataName="conversation-sidebar-open-in-explorer-button"
                                removeDataName="conversation-sidebar-remove-button"
                                removeLabel="从历史中移除"/>
                            </motion.div>
                    </Fragment>
                ))}
                {insertLine({kind: 'top-level', index: visibleTopRows.length})}

                {query && visibleTopRows.length === 0 && groupViews.length === 0 && (
                    <div className="px-[var(--space-relaxed)] py-[var(--space-loose)] text-center text-2xs text-[var(--text-muted)]">
                        无匹配项目
                    </div>
                )}
                {!query && Object.keys(workspaces).length === 0 && groups.length === 0 && (
                    <div className="px-[var(--space-relaxed)] py-[var(--space-loose)] text-center text-2xs text-[var(--text-muted)]">
                        还没有项目，点上方「添加项目」添加
                    </div>
                )}
            </div>

            {/* 拖拽跟手预览（Chrome 式：被拖的是哪一项要看得见）。
                portal 到 body —— 抽屉根节点带 transform，就地 fixed 会以抽屉为 containing block 而错位 */}
            {drag && pointer && createPortal(
                <div
                    className="pointer-events-none fixed z-[10001] max-w-[240px] truncate px-2 py-1 rounded-md text-2xs bg-[var(--surface)] border border-[var(--border-emphasis)] shadow-elevated text-[var(--text-primary)]"
                    style={{left: pointer.x + 12, top: pointer.y + 12}}
                    data-name="drawer-drag-ghost">
                    {draggedLabel}
                </div>,
                document.body,
            )}

            {/* 二级面板（§16）：组头 hover 打开的 Chrome 标签组式 flyout。
                portal 到 body 的理由同右键菜单（transform + overflow-hidden）。
                定位是 fixed + 视口坐标，几何在打开时算一次、滚动/resize 时重算。

                onMouseDown 必须 stopPropagation：侧栏在 document 的 mousedown 上做"点外部关抽屉"
                （ConversationSidebar.tsx 的 handleClickOutside，判定依据是 drawerRef.contains），
                面板不在 drawerRef 子树里 —— 不拦的话面板行的 mousedown 会先把抽屉关掉，
                随后补发的 click 落在已卸载的节点上，行就永远点不动。
                同理 onMouseEnter/onMouseLeave 用来接住"从组头移到面板"这段路程（见 schedulePanelClose）。

                ARIA 口径：面板根是 `role="dialog"` + aria-label，不再是 `listbox`。
                为什么：面板里既有成员行、又有面板头行 / 两个 hover 按钮 / 底部「添加项目」——
                一堆彼此独立的控件。ARIA 1.2 里 `listbox` 的直接子节点只能是 `option`（`option` 的子树
                还会被当成 presentational），把 `<button>` 放进去是违规嵌套，那些按钮在 AT 树里会直接消失。
                dialog 是"可以容纳任意内容与控件"的容器角色，与"这是一块浮层 flyout"的事实也对得上。
                随之成员行不再是 `option`：行主体改成真正的 `<button>`（当前项用 `aria-current` 表达），
                行内两个操作按钮是它的兄弟节点 —— 三者各自是独立可聚焦的控件，嵌套关系自洽。
                层 1 抽屉的 `role="listbox"` + 内置按钮是二级化之前的既有先例，本次**不动**（避免扩大 diff）；
                两处口径的差异是遗留问题，后续统一方向：层 1 要么把"可点的行"也换成 `<button>` 行
                （`aria-selected` → `aria-current`），要么让 listbox 回到"纯选择"语义、把行内操作收进右键菜单。 */}
            {panel && panelGroup && createPortal(
                <div
                    ref={panelRef}
                    role="dialog"
                    aria-label={`项目组 ${panelGroup.name}`}
                    style={{position: 'fixed', left: panel.left, top: panel.top, maxHeight: panel.maxHeight, zIndex: 9999}}
                    className="bg-[var(--surface)] border border-[var(--border-emphasis)] rounded-xl shadow-elevated overflow-y-auto"
                    onMouseEnter={cancelPanelClose}
                    onMouseLeave={schedulePanelClose}
                    onMouseDown={(e) => e.stopPropagation()}
                    // 面板内 Esc = 只关面板：stopPropagation 拦住侧栏 document 上的「Esc 关抽屉」
                    // （既有先例：组名重命名输入框的 Esc）
                    onKeyDown={(e) => {
                        if (e.key !== 'Escape') return
                        e.stopPropagation()
                        closePanelAndRestoreFocus()
                    }}
                    // 键盘版的 onMouseLeave：焦点整个离开面板（且没回到组头）→ 走宽限关闭。
                    // relatedTarget 为 null 时不关：那种"被聚焦的元素刚从 DOM 里摘掉"的情况
                    // （例如「移除项目」删掉了成员行）不代表用户离开了面板，鼠标可能还好端端停在上面。
                    onBlur={(e) => {
                        const next = e.relatedTarget as Node | null
                        if (next === null || e.currentTarget.contains(next)) return
                        const headerEl = drawerRef.current?.querySelector<HTMLElement>(
                            `[data-name="drawer-group-header-${panelGroup.id}"]`)
                        if (headerEl && headerEl.contains(next)) return
                        schedulePanelClose()
                    }}
                    data-name="drawer-group-panel">
                    {/* 面板头行 = 进组视图的入口（§6.2 不变：点组 = 切组视图并关抽屉） */}
                    <button
                        onClick={() => {
                            setProjectGroupView(panelGroup.id)
                            onClose()
                        }}
                        className={`${rowClass} w-full cursor-pointer ${
                            scopedGroupId === panelGroup.id
                                ? 'bg-[var(--brand-muted)] text-[var(--text-brand)]'
                                : 'text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]'
                        }`}
                        data-name={`drawer-group-panel-header-${panelGroup.id}`}>
                        {/* 独立 data-name（规范要求全局唯一）：面板头与层 1 组头是两处不同的图标槽位，
                            形状必须一致这一点由测试按形状比对来守，而不是靠"同名"。 */}
                        <Folders className="w-3.5 h-3.5 shrink-0 opacity-70" data-name="drawer-panel-group-icon"
                                 aria-hidden="true"/>
                        <span className="flex-1 min-w-0 truncate text-2xs font-semibold">{panelGroup.name}</span>
                        <span className="shrink-0 text-2xs text-[var(--text-muted)]">{panelGroup.members.length} 个项目</span>
                    </button>

                    {/* 成员项目行：可点击（§16.2 —— 原 D2"层 2 不可点"作废：面板里不可点等于面板没用），
                        拖拽契约与层 1 项目行同源（data-drag-row="member" + group-id/index），
                        所以落点表把面板也算作一个根。 */}
                    {panelGroup.members.map((member, i) => (
                        <Fragment key={member.path}>
                            {insertLine({kind: 'group-member', groupId: panelGroup.id, index: i})}
                            <motion.div
                                layout
                                transition={LAYOUT_TRANSITION}
                                data-name={`drawer-group-member-${i}`}
                                data-drag-row="member"
                                data-group-id={panelGroup.id}
                                data-index={i}
                                onPointerDown={(e) => beginDrag(e, {kind: 'project', projectPath: member.path})}
                                onContextMenu={(e) => openMenu(e, {kind: 'member', path: member.path})}
                                className={`${rowClass} pl-[var(--space-loose)] ${
                                    isTopRowSelected(member.path)
                                        ? 'bg-[var(--brand-muted)] text-[var(--text-brand)]'
                                        : 'text-[var(--text-secondary)] hover:bg-[var(--surface-muted)]'
                                }`}>
                                {/* 行主体 = 一个真正的 <button>：「切到该项目」是用户可以聚焦、可以回车触发的控件，
                                    不是"带 onClick 的普通行"（那对键盘/AT 等于不存在）。行本身不再是 option，
                                    理由见面板根的 ARIA 口径说明。drag 仍挂在行上（pointerdown 从按钮冒泡上来），
                                    行的矩形契约（data-drag-row / data-index）也一并未变。 */}
                                <button
                                    onClick={() => {
                                        if (isClickSuppressed()) return // 刚拖完的那次 click 不切视图
                                        setWorkspace(member.path)
                                        onClose()
                                    }}
                                    // 当前所在项目用 aria-current 表达：aria-selected 只对 option / row / tab
                                    // 这类角色有效，放在 button 上是无效属性
                                    aria-current={isTopRowSelected(member.path) ? 'true' : undefined}
                                    className="flex-1 min-w-0 flex items-center gap-[var(--space-snug)] text-left cursor-pointer rounded"
                                    data-name={`drawer-group-member-open-${i}`}>
                                    <ProjectRowBody name={member.name} path={member.path} iconName="drawer-panel-project-icon"/>
                                </button>
                                {/* hover 操作与未分组行同构（不占常驻宽度）。
                                    多一个 group-focus-within:opacity-100：本行现在是可 Tab 的，
                                    只留 group-hover 会让键盘用户"能 Tab 到、但看不见自己在哪"。 */}
                                <ProjectRowActions
                                    path={member.path}
                                    onRemove={() => handleRemove(member.path)}
                                    focusWithin={true}
                                    openDataName="drawer-member-open-in-explorer-button"
                                    removeDataName="drawer-member-remove-button"
                                    removeLabel="移除项目"/>
                            </motion.div>
                        </Fragment>
                    ))}
                    {insertLine({kind: 'group-member', groupId: panelGroup.id, index: panelGroup.members.length})}

                    {panelGroup.members.length === 0 && (
                        <div className="px-[var(--space-relaxed)] py-[var(--space-snug)] text-2xs text-[var(--text-muted)]">
                            还没有项目，拖入或点下方「添加项目」
                        </div>
                    )}

                    {/* 「添加项目」从层 1 组块迁到这里（§16.1）：行为一字未改 —— 选文件夹 → 登记 → 入组 →
                        定位该项目段，停留组视图（handleGroupAdd）。 */}
                    <button
                        onClick={() => void handleGroupAdd(panelGroup.id)}
                        aria-label="添加项目"
                        title="添加项目"
                        className={`${rowClass} w-full cursor-pointer text-[var(--text-brand)] hover:bg-[var(--brand-muted)]`}
                        data-name={`drawer-group-panel-add-${panelGroup.id}`}>
                        <PlusIcon className="w-3 h-3 shrink-0"/>
                        <span className="text-2xs font-medium">添加项目</span>
                    </button>
                </div>,
                document.body,
            )}

            {/* 右键菜单：portal 到 body —— 抽屉根节点带 transform 与 overflow-hidden，
                就地渲染会被裁切、且 fixed 会以抽屉为 containing block 而错位 */}
            {m && createPortal(
                <div
                    role="menu"
                    style={{position: 'fixed', left: m.x, top: m.y, zIndex: 10000}}
                    className="bg-[var(--surface)] border border-[var(--border-emphasis)] rounded-xl shadow-elevated py-1.5 min-w-[160px]"
                    onContextMenu={(e) => e.preventDefault()}
                    // 菜单 portal 到 body 不在 drawerRef 子树里 —— onMouseDown 不拦的话，
                    // 侧栏在 document mousedown 上的"点外部关抽屉"（ConversationSidebar.handleClickOutside）
                    // 会先于 click 把抽屉关掉，菜单随之卸载，随后 click 打空、动作不触发。
                    // 与面板根 :962 的 onMouseDown 同款自保（既有先例）。
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                    data-name="drawer-context-menu">
                    {menuItems.map((item) => (
                        <button
                            key={item.name}
                            onClick={item.run}
                            className={MENU_ITEM_CLASS}
                            data-name={item.name}>
                            {item.label}
                        </button>
                    ))}
                </div>,
                document.body,
            )}
        </motion.div>
    )
}
