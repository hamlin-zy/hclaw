/**
 * 自研指针拖拽原语（spec §6.3：不新增依赖）。
 *
 * 为什么不用 HTML5 drag：默认幽灵图与抽屉的 portal/滚动容器交互很差，
 * 且无法自定义插入线与"离中线更近"的插入判定。
 *
 * 分层（便于单测与复用）：
 *  · 纯逻辑 `isClickGesture` / `resolveDropTarget` —— 阈值与落点判定，不碰 DOM；
 *  · DOM 采集 `collectDropZones` —— 把行矩形翻成落点表（拖拽开始时采一次）；
 *  · React 原语 `usePointerDrag` —— 手势接线（window 监听）+ 副作用清理。
 *
 * 落点表的时效性：rect 是**相对视口**测的，容器一滚整张表就整体偏移（自动滚动 ≈480px/s，
 * 100ms 就能偏出几百像素）。所以 `usePointerDrag` 在滚动时重采（自动滚动的每一帧 + `scroll` 事件），
 * 并在落库前再采一次 —— 落点判定永远基于"当前这一刻"的布局。
 *
 * DOM 契约（`collectDropZones` 依赖）：可拖/可落的行自带
 *  `data-drag-row="group|member|top"`，并配上 `data-group-id` / `data-index`；
 *  组的块容器（组头 + 空组占位；组内成员行已下沉到二级面板）自带 `data-drag-group-block`。
 *
 * 落点行可以分散在多个根里（抽屉内容区 + portal 到 body 的二级面板）：rect 是视口坐标，
 * 多个根的落点表可以按顺序拼成一张；但**每个承载落点行的可滚动容器都要参与"滚动即重采"**，
 * 否则它一滚整张表就偏（见 `usePointerDrag` 的 `extraScrollRefs`）。
 *
 * 由此派生的一条不变量：**"空态兜底顶层落点"是抽屉根专有的**（根内要有 `data-drag-group-block`
 * 才启用）。面板根没有组块 → 采不到兜底，成员拖到面板头行/空白上就是"无落点"（取消），
 * 而不是被当成顶层区静默移出组。详见 `collectDropZones` 内的兜底注释。
 */
import {useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject} from 'react'

/** 位移 < 4px（欧氏距离）且时长 < 300ms → 点击；两个边界都是开区间（边界值算拖拽，spec §6.3） */
export function isClickGesture(dx: number, dy: number, dtMs: number): boolean {
    return Math.hypot(dx, dy) < 4 && dtMs < 300
}

export type DragPayload = {kind: 'project'; projectPath: string} | {kind: 'group'; groupId: string}

export type DropTarget =
    | {kind: 'group'; groupId: string}
    | {kind: 'group-member'; groupId: string; index: number}
    | {kind: 'top-level'; index: number}

export interface DropZone {
    rect: {top: number; bottom: number; left: number; right: number}
    target: DropTarget
}

/** 落点解析：返回第一个包含该点的落点；都不含 → null（视为拖到空白处 = 取消，不落库） */
export function resolveDropTarget(
    point: {x: number; y: number},
    zones: DropZone[],
): DropTarget | null {
    for (const {rect, target} of zones) {
        if (point.y >= rect.top && point.y <= rect.bottom && point.x >= rect.left && point.x <= rect.right) {
            return target
        }
    }
    return null
}

/** 自动滚动：拖到滚动容器上下边缘 24px 内时按 8px/帧滚动 */
const AUTO_SCROLL_EDGE_PX = 24
const AUTO_SCROLL_STEP_PX = 8

/**
 * 采集落点表（拖拽开始时调用一次）。
 *
 * 列表行（组内项目 / 顶层项目）按行的**中线**切成上下两半：
 * 上半 → 插到该行之前（index），下半 → 插到该行之后（index + 1）。
 * 这就是 spec §6.3 的"离中线更近"判定——落点在哪个半区，就插到离它更近的那个间隙。
 * 组头整行为一个落点（组间排序只需要"落在哪个组头上"）。
 *
 * 无布局的元素（未挂载 / jsdom 零矩形）直接跳过，否则所有行会退化成一个零面积落点。
 */
export function collectDropZones(root: HTMLElement | null): DropZone[] {
    if (!root) return []
    const zones: DropZone[] = []
    const rows = root.querySelectorAll<HTMLElement>(
        '[data-drag-row="group"], [data-drag-row="member"], [data-drag-row="top"]',
    )
    for (const row of rows) {
        const rect = row.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) continue
        const groupId = row.dataset.groupId
        const index = Number(row.dataset.index)
        if (row.dataset.dragRow === 'group') {
            if (!groupId) continue
            zones.push({rect: {top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right},
                target: {kind: 'group', groupId}})
            continue
        }
        const mid = (rect.top + rect.bottom) / 2
        const half = {left: rect.left, right: rect.right}
        const target = (i: number): DropTarget => row.dataset.dragRow === 'member' && groupId
            ? {kind: 'group-member', groupId, index: i}
            : {kind: 'top-level', index: i}
        zones.push({rect: {...half, top: rect.top, bottom: mid}, target: target(index)})
        zones.push({rect: {...half, top: mid, bottom: rect.bottom}, target: target(index + 1)})
    }
    // 兜底：顶层项目区为空（项目全部归组）时，**组区之下**那片空白才等于"顶层区"，
    // 否则"组内项目 → 顶层区"（§6.3 第 3 行）在空态下没有落点。行落点优先（先入先命中）。
    //
    // 三个限制缺一不可，否则空白会被静默当成"顶层区"→ 组内项目落到那里会被
    // `assign(path, null)` 移出组（§6.3 只把"组内项目 → 顶层项目区"定义为该落点）：
    //  · `topCount === 0`：顶层区非空时顶层行自己就是落点，兜底没有存在理由；
    //  · **根内确实有组块（`data-drag-group-block`）**：兜底的存在理由是"项目全部归组、顶层区为空时
    //    给『组内项目 → 顶层区』留一个落点"，而"有成员可拖"蕴含着"有组"—— 真需要兜底的根里组块必然存在。
    //    反过来，一个组块都没有的根（= portal 到 body 的二级面板根：面板头行 + 成员行 + 添加入口）
    //    压根没有"组区"可言，兜底只会把面板头行与空白整块注册成 `top-level` 落点 ——
    //    用户把成员拖到面板头行上就会静默移出组。同时这条守卫也保住了
    //    "分母根采集时兜底只属于抽屉根"这一不变量（面板根的采集结果里不再有 top-level 兜底）；
    //  · top 裁到最后一个组块的底边：顶层区渲染在组区**之下**，
    //    组块上方的空白（空组占位文字、组间 mb-1 间隙）必须排除在外。
    //    无组块时退化为容器顶边 —— 但那种根已被上一条守卫排除。
    const container = root.getBoundingClientRect()
    const topCount = root.querySelectorAll('[data-drag-row="top"]').length
    const blocks = root.querySelectorAll<HTMLElement>('[data-drag-group-block]')
    if (topCount === 0 && blocks.length > 0 && container.width > 0 && container.height > 0) {
        const lastBlockRect = blocks[blocks.length - 1]?.getBoundingClientRect()
        const top = lastBlockRect && lastBlockRect.height > 0
            ? Math.max(container.top, lastBlockRect.bottom)
            : container.top
        if (top < container.bottom) {
            zones.push({
                rect: {top, bottom: container.bottom, left: container.left, right: container.right},
                target: {kind: 'top-level', index: 0},
            })
        }
    }
    return zones
}

/** 拖拽结束后浏览器补发的 click 的抑制窗口（ms）：只吞掉紧随其后的那一次 */
const CLICK_SUPPRESS_MS = 250

export interface PointerDragApi {
    /** 正在拖拽的载荷；null = 无拖拽 */
    drag: DragPayload | null
    /** 指针当前位置（供跟手预览使用） */
    pointer: {x: number; y: number} | null
    /** 当前落点（用于插入线与高亮）；null = 空白处 */
    hoverTarget: DropTarget | null
    onPointerDown: (e: ReactPointerEvent, payload: DragPayload) => void
    /** 抑制窗口的截止时间戳：`performance.now() < suppressClickRef.current` 时应忽略紧随拖拽的 click */
    suppressClickRef: {current: number}
}

/**
 * 指针拖拽 hook。
 *
 * · `pointermove` / `pointerup` / `pointercancel` 挂在 **window**（不是面板）：拖出抽屉边界不丢事件；
 * · 首次超过阈值才进入拖拽态（此时才加 `userSelect: none`、采落点表、开始自动滚动）；
 * · 落点表在容器滚动时重采（自动滚动的每帧 + `scroll` 事件），落库前再采一次 —— rect 是
 *   视口坐标，滚动会让整张表偏移（自动滚动 ≈480px/s，几百毫秒就能偏出好几行）；
 *   落点行分散在多个根时（抽屉 + 二级面板），每个会滚的根都要挂上这个重采（`extraScrollRefs`）；
 * · 每个出口（抬起 / Esc 取消 / 指针取消 / 卸载）都还原 `userSelect` 并摘掉监听；
 * · Esc 取消：只清拖拽态，**不调 onDrop**（不落库）。
 */
export function usePointerDrag(opts: {
    onDrop: (payload: DragPayload, target: DropTarget) => void
    collectZones: () => DropZone[]
    scrollContainerRef?: RefObject<HTMLElement | null>
    /**
     * 额外的"滚动即重采"根（例如 portal 到 body 的二级面板）。
     *
     * 与 `scrollContainerRef` 的区别：那里是**自动滚动**的作用目标（拖到边缘时替用户滚），
     * 这里只补"滚动会让落点表整体偏移"这一件事 —— 用户自己在这些容器里滚轮，
     * 落点表同样必须重采。所以两者刻意不合并：自动滚动只应该有唯一的宿主。
     */
    extraScrollRefs?: RefObject<HTMLElement | null>[]
}): PointerDragApi {
    const [drag, setDrag] = useState<DragPayload | null>(null)
    const [pointer, setPointer] = useState<{x: number; y: number} | null>(null)
    const [hoverTarget, setHoverTarget] = useState<DropTarget | null>(null)
    const suppressClickRef = useRef(0)
    /** 卸载时用的清理钩子（拖拽途中组件被卸载也不能留下 userSelect / 监听） */
    const teardownRef = useRef<(() => void) | null>(null)
    /** 自动滚动循环用的最新指针位置（避免把 pointer state 读成陈旧闭包） */
    const pointerPosRef = useRef<{x: number; y: number} | null>(null)
    const rafRef = useRef<number | null>(null)
    /** 让监听器始终调到最新一次渲染的 props（看板数据在拖拽中可能更新） */
    const latestRef = useRef(opts)
    useEffect(() => {
        latestRef.current = opts
    })

    useEffect(() => () => {
        teardownRef.current?.()
        document.body.style.userSelect = ''
    }, [])

    const onPointerDown = (e: ReactPointerEvent, payload: DragPayload) => {
        if (e.button !== 0) return // 只认主键；右键留给右键菜单
        const startX = e.clientX
        const startY = e.clientY
        const startTs = performance.now()
        const pointerId = (e as unknown as {pointerId?: number}).pointerId
        let zones: DropZone[] = []
        let dragging = false
        let lastPoint: {x: number; y: number} | null = null

        const scrollContainer = () => latestRef.current.scrollContainerRef?.current ?? null

        /**
         * 容器滚动后行位置全变，旧落点表作废 → 重采，并按当前指针重算落点。
         * 拖拽中指针可能一动不动（自动滚动正是这种场景），只靠 `pointermove` 更新会让
         * 插入线/高亮停在滚动前的位置，落库也会落到用户没指着的行上。
         */
        const refreshZones = () => {
            if (!dragging) return // 收尾之后浏览器仍可能补发一次 scroll，别把插入线又画回来
            zones = latestRef.current.collectZones()
            if (pointerPosRef.current) setHoverTarget(resolveDropTarget(pointerPosRef.current, zones))
        }

        /** 用户滚轮 / 滚动条等本 hook 之外的滚动来源（自动滚动那部分由 tick 自己检测增量） */
        function onScroll() {
            refreshZones()
        }

        /** 本次拖拽实际挂上过监听的容器 —— 摘的时候按这份名单来，避免容器在途中被卸载而摘不干净 */
        let scrollListenerTargets: HTMLElement[] = []

        const attachScrollListeners = () => {
            scrollListenerTargets = [
                scrollContainer(),
                ...(latestRef.current.extraScrollRefs ?? []).map((r) => r.current ?? null),
            ].filter((el): el is HTMLElement => el !== null)
            for (const el of scrollListenerTargets) el.addEventListener('scroll', onScroll)
        }

        const detachScrollListeners = () => {
            for (const el of scrollListenerTargets) el.removeEventListener('scroll', onScroll)
            scrollListenerTargets = []
        }

        const stopAutoScroll = () => {
            if (rafRef.current !== null) {
                cancelAnimationFrame(rafRef.current)
                rafRef.current = null
            }
            detachScrollListeners()
        }

        const tick = () => {
            const el = scrollContainer()
            const p = pointerPosRef.current
            if (el && p) {
                const rect = el.getBoundingClientRect()
                if (rect.height > 0) { // 零高度 = 无布局（jsdom / 未挂载），不滚
                    const before = el.scrollTop
                    if (p.y < rect.top + AUTO_SCROLL_EDGE_PX) el.scrollTop -= AUTO_SCROLL_STEP_PX
                    else if (p.y > rect.bottom - AUTO_SCROLL_EDGE_PX) el.scrollTop += AUTO_SCROLL_STEP_PX
                    // 滚动确实发生时重算落点：程序化改 scrollTop 在部分环境（jsdom）不发 scroll 事件，
                    // 浏览器里也可能被合并，所以这里按自己造成的增量直接判定，不依赖事件。
                    if (el.scrollTop !== before) refreshZones()
                }
            }
            rafRef.current = requestAnimationFrame(tick)
        }

        const teardown = () => {
            window.removeEventListener('pointermove', onMove)
            window.removeEventListener('pointerup', onUp)
            window.removeEventListener('pointercancel', teardown)
            window.removeEventListener('keydown', onEsc, true)
            stopAutoScroll()
            if (dragging) document.body.style.userSelect = ''
            pointerPosRef.current = null
            teardownRef.current = null
            setDrag(null)
            setPointer(null)
            setHoverTarget(null)
            dragging = false
        }

        /** 同一指针才继续跟随（多点触控时忽略别的手指） */
        const samePointer = (ev: PointerEvent) => pointerId === undefined || ev.pointerId === undefined
            || ev.pointerId === pointerId

        const readPoint = (ev: PointerEvent) => Number.isFinite(ev.clientX) && Number.isFinite(ev.clientY)
            ? {x: ev.clientX, y: ev.clientY}
            : null

        function onMove(ev: PointerEvent) {
            if (!samePointer(ev)) return
            const point = readPoint(ev)
            if (!point) return
            lastPoint = point
            pointerPosRef.current = point
            if (!dragging) {
                if (isClickGesture(point.x - startX, point.y - startY, performance.now() - startTs)) return
                dragging = true
                zones = latestRef.current.collectZones() // 进入拖拽态才读布局（滚动时再重采，见 refreshZones）
                document.body.style.userSelect = 'none'
                setDrag(payload)
                attachScrollListeners()
                rafRef.current = requestAnimationFrame(tick)
            }
            setPointer(point)
            setHoverTarget(resolveDropTarget(point, zones))
        }

        function onUp(ev: PointerEvent) {
            if (!samePointer(ev)) return
            const point = readPoint(ev) ?? lastPoint
            // 落库前以"这一刻"的布局为准：拖拽途中容器可能滚过，陈旧落点表会把项目落到别的行
            if (dragging) zones = latestRef.current.collectZones()
            const target = dragging && point ? resolveDropTarget(point, zones) : null
            if (dragging) suppressClickRef.current = performance.now() + CLICK_SUPPRESS_MS
            teardown()
            // 已在拖拽态但落在空白处 → 视为取消，不落库
            if (target) latestRef.current.onDrop(payload, target)
        }

        function onEsc(ev: KeyboardEvent) {
            if (ev.key !== 'Escape') return
            ev.stopPropagation() // 只取消这次拖拽，不顺手关掉抽屉/菜单
            ev.preventDefault()
            teardown()
        }

        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        window.addEventListener('pointercancel', teardown)
        window.addEventListener('keydown', onEsc, true)
        teardownRef.current = teardown
    }

    return {drag, pointer, hoverTarget, onPointerDown, suppressClickRef}
}
