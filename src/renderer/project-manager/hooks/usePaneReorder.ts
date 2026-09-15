// src/renderer/project-manager/hooks/usePaneReorder.ts
// 三面板拖动换序状态机（PM 窗口「拖动标题栏交换 文件树 / 编辑区 / 变更列表」）。
//
// 纪律（照抄 SplitPane 的经验，两者必须一致，否则会出现"同步派发的 move/up 打空"）：
// - mousedown 内**同步**注册 document 的 mousemove/mouseup；注销函数登记在 activeDragRef，
//   onUp 成对移除；组件卸载 / Escape 兜底清除，不留孤儿监听、不留全局类。
// - 每帧跟手只写 DOM（`style.transform`），**不走 React state**；只有"跨列让位"（指针越过
//   某个中点）才 setState 预览顺序，一次拖动最多 5 次，且因列以 `key={paneId}` 渲染而只做 DOM 移动。
// - 松手只提交一次（onReorder），且仅在顺序真的变了时提交。
import {createContext, useCallback, useContext, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject} from 'react'
import type {PaneId} from './paneOrder'

/** 与 .pm-split-handle 的命中区宽度一致（flex: 0 0 5px） */
export const HANDLE_W = 5
/** 起手阈值：小于它视为误触，不进 dragging、不写任何 DOM/state */
const DRAG_THRESHOLD = 3

interface PaneSlot {
  id: PaneId
  left: number
  width: number
  center: number
}

/**
 * 纯几何：一行三列 + 2 条 5px 分隔条的槽位。不读 DOM rect（jsdom 无布局 ⇒ 仍可精确断言）。
 * 固定列宽 = sizes[id]；编辑区恒为唯一弹性列，吃掉 `rowW - 固定和 - 2*5`。
 */
export function computePaneSlots(order: PaneId[], sizes: Record<string, number>, rowW: number): PaneSlot[] {
  const fixedSum = order.reduce((sum, id) => sum + (id === 'editor' ? 0 : (sizes[id] ?? 0)), 0)
  const editorW = Math.max(0, rowW - fixedSum - HANDLE_W * (order.length - 1))
  let x = 0
  return order.map(id => {
    const width = id === 'editor' ? editorW : (sizes[id] ?? 0)
    const slot: PaneSlot = {id, left: x, width, center: x + width / 2}
    x += width + HANDLE_W
    return slot
  })
}

/**
 * 落点 = 「非拖拽列」中中心点落在指针左侧的列数（= 把被拖列插到这个下标）。
 * 判定基准固定为**起手时的顺序**：拖动中列会真实换序，若拿换序后的几何再判定，
 * 中点会跟着列一起移动、指针在同一位置来回抖动；基准固定 ⇒ 判定单调、可复现。
 */
export function resolveDropIndex(
  order: PaneId[],
  sizes: Record<string, number>,
  rowW: number,
  draggingId: PaneId,
  pointerX: number,
): number {
  return computePaneSlots(order, sizes, rowW)
    .filter(s => s.id !== draggingId)
    .filter(s => pointerX > s.center)
    .length
}

/** 把 id 移到下标 index（index 按"移除 id 后的数组"计）。 */
export function movePane(order: PaneId[], id: PaneId, index: number): PaneId[] {
  const rest = order.filter(x => x !== id)
  const clamped = Math.max(0, Math.min(index, rest.length))
  return [...rest.slice(0, clamped), id, ...rest.slice(clamped)]
}

function sameOrder(a: PaneId[], b: PaneId[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

export interface PaneReorderApi {
  /** 当前渲染顺序（拖动中为预览顺序；未拖动时等于已提交顺序） */
  order: PaneId[]
  /** 正在被拖的列（未拖动为 null） */
  draggingId: PaneId | null
  /** 落点高亮框（也是"让位后的空槽"）：绝对定位的 left/width，由纯几何算出 */
  placeholder: {left: number, width: number} | null
  rowRef: RefObject<HTMLDivElement | null>
  /** 各列 DOM 引用（拖动中写 transform / 拖分隔条时写 flex 都直接改它，不走 state） */
  colRefs: RefObject<Partial<Record<PaneId, HTMLDivElement | null>>>
  setColRef(id: PaneId, el: HTMLDivElement | null): void
  /** 供面板标题栏 / 标签栏 gutter 调用 */
  beginDrag(id: PaneId, e: ReactMouseEvent): void
}

export const PaneReorderContext = createContext<PaneReorderApi | null>(null)

/** 隔离渲染（如单独渲染 FileTree / EditorArea 的用例）拿到 null，不产生任何额外 DOM。 */
export function usePaneReorderOptional(): PaneReorderApi | null {
  return useContext(PaneReorderContext)
}

interface ActiveDrag {
  remove: () => void
}

export function usePaneReorder(
  order: PaneId[],
  sizes: Record<string, number>,
  onReorder: (next: PaneId[]) => void,
): PaneReorderApi {
  const rowRef = useRef<HTMLDivElement | null>(null)
  const colRefs = useRef<Partial<Record<PaneId, HTMLDivElement | null>>>({})
  // sizes / onReorder 用 ref 取最新值：beginDrag 的回调要稳定，不因尺寸提交而重建
  const sizesRef = useRef(sizes)
  sizesRef.current = sizes
  const onReorderRef = useRef(onReorder)
  onReorderRef.current = onReorder

  const [preview, setPreview] = useState<PaneId[] | null>(null)
  const [draggingId, setDraggingId] = useState<PaneId | null>(null)
  const [placeholder, setPlaceholder] = useState<{left: number, width: number} | null>(null)

  const renderedOrder = preview ?? order
  const renderedOrderRef = useRef(renderedOrder)
  renderedOrderRef.current = renderedOrder

  const activeDragRef = useRef<ActiveDrag | null>(null)

  const setColRef = useCallback((id: PaneId, el: HTMLDivElement | null) => {
    colRefs.current[id] = el
  }, [])

  const beginDrag = useCallback((id: PaneId, e: ReactMouseEvent) => {
    // 只认左键：右键/中键既不参与拖拽，也不该被 preventDefault 吞掉（会连带压掉右键菜单）
    if (e.button !== 0) return
    e.preventDefault()
    const rowEl = rowRef.current
    if (!rowEl) return
    const baseOrder = [...renderedOrderRef.current]
    if (!baseOrder.includes(id)) return

    // rowW 起手时取一次即可：拖动期间行宽不变，几何无需重测。
    // jsdom 无布局（clientWidth === 0）→ 两级回落，等同注入一个确定宽度，测试不必 mock。
    const rowW = rowEl.clientWidth || rowEl.getBoundingClientRect().width || window.innerWidth
    const rowLeft = rowEl.getBoundingClientRect().left
    const startX = e.clientX
    const startY = e.clientY
    const sizeSnapshot = sizesRef.current
    const baseSlot = computePaneSlots(baseOrder, sizeSnapshot, rowW).find(s => s.id === id)
    if (!baseSlot) return
    // 抓握点相对列左缘的偏移：拖动中列左缘始终停在 `指针 - 抓握偏移` 处（视觉位置=指针）
    const gripOffset = startX - rowLeft - baseSlot.left

    let dragging = false
    let currentPreview: PaneId[] | null = null

    const applyMove = (clientX: number) => {
      const pointerX = clientX - rowLeft
      const index = resolveDropIndex(baseOrder, sizeSnapshot, rowW, id, pointerX)
      const nextOrder = movePane(baseOrder, id, index)
      if (!sameOrder(nextOrder, renderedOrderRef.current)) {
        renderedOrderRef.current = nextOrder
        currentPreview = sameOrder(nextOrder, baseOrder) ? null : nextOrder
        setPreview(currentPreview)
        const slot = computePaneSlots(nextOrder, sizeSnapshot, rowW).find(s => s.id === id)
        if (slot) setPlaceholder({left: slot.left, width: slot.width})
      }
      const slotNow = computePaneSlots(renderedOrderRef.current, sizeSnapshot, rowW).find(s => s.id === id)
      const el = colRefs.current[id]
      if (el && slotNow) el.style.transform = `translateX(${pointerX - gripOffset - slotNow.left}px)`
    }

    const finish = (commit: boolean) => {
      const active = activeDragRef.current
      activeDragRef.current = null
      active?.remove()
      document.documentElement.classList.remove('pm-is-pane-reordering')
      const el = colRefs.current[id]
      if (el) el.style.transform = ''
      const final = renderedOrderRef.current
      setDraggingId(null)
      setPlaceholder(null)
      setPreview(null)
      renderedOrderRef.current = baseOrder
      // 未进入 dragging（小于阈值松开）⇒ 什么都没发生；顺序没变 ⇒ 不写盘
      if (commit && dragging && !sameOrder(final, baseOrder)) onReorderRef.current(final)
    }

    const onMove = (ev: MouseEvent) => {
      if (!dragging) {
        if (Math.abs(ev.clientX - startX) < DRAG_THRESHOLD && Math.abs(ev.clientY - startY) < DRAG_THRESHOLD) return
        dragging = true
        document.documentElement.classList.add('pm-is-pane-reordering')
        setDraggingId(id)
        setPlaceholder({left: baseSlot.left, width: baseSlot.width})
      }
      applyMove(ev.clientX)
    }
    const onUp = () => finish(true)
    const onKeyDown = (ev: KeyboardEvent) => { if (ev.key === 'Escape') finish(false) }

    // 上一次拖拽若未正常收尾（如重复 mousedown），先摘掉旧监听器再登记新的，避免孤儿监听器
    activeDragRef.current?.remove()
    // 同步注册：同一个事件循环内随后派发的 mousemove/mouseup 都能被处理
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.addEventListener('keydown', onKeyDown)
    activeDragRef.current = {
      remove: () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        document.removeEventListener('keydown', onKeyDown)
      },
    }
  }, [])

  // 卸载兜底：拖拽中途组件被卸载时，document 监听与全局类都必须清掉（泄漏修复）
  useEffect(() => () => {
    activeDragRef.current?.remove()
    activeDragRef.current = null
    document.documentElement.classList.remove('pm-is-pane-reordering')
  }, [])

  return {order: renderedOrder, draggingId, placeholder, rowRef, colRefs, setColRef, beginDrag}
}
