// src/renderer/project-manager/ui/SplitPane.tsx
// 可拖分栏（spec §4 / §5.2 / §5.3）
//
// 关键约束：
// - 拖动期间**不走 React state**——每帧 setState 会掉帧。直接改 first 元素的 style，
//   mouseup 时才通过 onResizeEnd 提交一次，由调用方落库并持久化。
// - mousemove/mouseup 由 handleMouseDown **同步**注册到 document，保证同一个事件循环内
//   后续派发的 move/up 一定被处理（若等到 React flush state 后再注册，同步派发会打空）。
// - 本次拖拽的注销函数登记在 activeDragRef：onUp 成对移除并清空；组件在拖拽中途卸载时，
//   卸载 effect 会兜底调用它，监听器不会永久驻留在 document 上。
// - 分隔条无 hover 浮动反馈，仅光标变化。
import React, {useCallback, useEffect, useRef} from 'react'

export interface SplitPaneProps {
  /** 'x' = 左右分栏（纵向分隔条）；'y' = 上下分栏（横向分隔条） */
  axis: 'x' | 'y'
  /**
   * 哪一栏是固定尺寸（另一栏 flex:1 吃掉剩余空间）。默认 'first'。
   * 三列布局（固定 | 弹性 | 固定）靠**嵌套两层**实现：外层 fixed='first'，
   * 内层 fixed='second'——因为 SplitPane 一次只切两栏。
   */
  fixed?: 'first' | 'second'
  /** 固定栏已提交的尺寸（px） */
  size: number
  min: number
  max: number
  /** 拖动结束时提交一次 */
  onResizeEnd: (px: number) => void
  /** 左栏 / 上栏内容 */
  first: React.ReactNode
  /** 右栏 / 下栏内容 */
  second: React.ReactNode
  /** 分隔条的 aria-label */
  label: string
  testId?: string
}

/** 进行中拖拽的注销句柄：调用后成对移除 document 上的 mousemove/mouseup。 */
interface ActiveDrag {
  remove: () => void
}

export function SplitPane({axis, fixed = 'first', size, min, max, onResizeEnd, first, second, label, testId}: SplitPaneProps) {
  const fixedRef = useRef<HTMLDivElement>(null)
  const activeDragRef = useRef<ActiveDrag | null>(null)
  const isX = axis === 'x'
  const isFirst = fixed === 'first'

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    // 只认左键：右键/中键既不参与拖拽，也不该被 preventDefault 吞掉（会连带压掉右键菜单）
    if (e.button !== 0) return
    e.preventDefault()
    const el = fixedRef.current
    if (!el) return

    // 起点信息全部留在闭包里，拖动过程中只改 DOM style，不触发 React 重渲染
    const startCoord = isX ? e.clientX : e.clientY
    const startSize = size
    const clamp = (px: number) => Math.min(max, Math.max(min, px))
    let current = startSize

    const onMove = (ev: MouseEvent) => {
      const coord = isX ? ev.clientX : ev.clientY
      // 固定栏在左/上（'first'）时向右下拖 = 变大；固定栏在右/下（'second'）时取反
      const delta = (coord - startCoord) * (isFirst ? 1 : -1)
      current = clamp(startSize + delta)
      el.style.flex = `0 0 ${current}px`
    }
    const onUp = () => {
      // 先摘掉登记再注销：重复 mouseup / 卸载兜底都只会提交一次
      const active = activeDragRef.current
      activeDragRef.current = null
      active?.remove()
      onResizeEnd(clamp(current))
    }

    // 上一次拖拽若未正常收尾（如重复 mousedown），先摘掉旧监听器再登记新的，避免孤儿监听器
    activeDragRef.current?.remove()

    // 同步注册：同一个事件循环内随后派发的 mousemove/mouseup 都能被处理
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    activeDragRef.current = {
      remove: () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      },
    }
  }, [isX, isFirst, size, min, max, onResizeEnd])

  // 卸载兜底：拖拽中途组件被卸载时，document 上的监听器必须成对摘除（泄漏修复）
  useEffect(() => () => {
    activeDragRef.current?.remove()
    activeDragRef.current = null
  }, [])

  const fixedPane = (
    <div ref={fixedRef} className="pm-split-fixed" style={{flex: `0 0 ${size}px`}}>
      {isFirst ? first : second}
    </div>
  )

  return (
    <div className={`pm-split pm-split--${axis}`} data-testid={testId}>
      {isFirst ? fixedPane : <div className="pm-split-flex">{first}</div>}
      <div
        role="separator"
        aria-orientation={isX ? 'vertical' : 'horizontal'}
        aria-label={label}
        aria-valuenow={Math.round(size)}
        aria-valuemin={min}
        aria-valuemax={max}
        className={`pm-split-handle pm-split-handle--${axis}`}
        onMouseDown={handleMouseDown}
      />
      {isFirst ? <div className="pm-split-flex">{second}</div> : fixedPane}
    </div>
  )
}
