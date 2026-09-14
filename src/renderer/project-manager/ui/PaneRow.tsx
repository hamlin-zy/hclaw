// src/renderer/project-manager/ui/PaneRow.tsx
// 扁平三列 + 2 条分隔条（替换上半区原来的两层嵌套 SplitPane）。
//
// 为什么必须扁平：实时让位预览要求「顺序变化时不重挂载面板子树」。嵌套 SplitPane 的树形
// 随编辑区处于第 1/2/3 列而变（三种不同 JSX 结构）→ 顺序一变子树整棵卸载重建，丢失
// showIgnored / 滚动位 / mdViewMode / Git 分组展开等局部状态，且一次拖动最多发生 5 次（闪烁 + 掉帧）。
// 扁平 row 的列恒以 `key={paneId}` 渲染：重排只是数组换序，React 移动 DOM 节点而保留组件实例。
//
// 分隔条复用既有 `.pm-split-handle .pm-split-handle--x` 类（5px 命中区 / 透明本体 / ::after 中缝 hover），
// 不新增样式类、不改 SplitPane（底部 Git 区仍用它）。
import {Fragment, useEffect, useRef, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject} from 'react'
import clsx from 'clsx'
import type {PaneId} from '../hooks/paneOrder'
import {PaneReorderContext, usePaneReorder, type PaneReorderApi} from '../hooks/usePaneReorder'
import type {PaneSizeSpecs} from '../hooks/usePaneSize'

/** 分隔条可访问名：**跟 pane 不跟位置**（既有断言按 name 取条，换序后仍指向同一列） */
const PANE_RESIZE_LABEL: Record<PaneId, string> = {
  fileTree: '文件树宽度',
  changes: '变更列表宽度',
  editor: '编辑区宽度',   // 编辑区恒为弹性列、永不当 owner，这里只为类型完备
}

/**
 * 分隔条 owner 规则：handle 位于第 i-1 / i 列之间，**左邻是固定列则取左邻，否则取右邻**。
 * 三列里恰有一列（编辑区）是弹性列 ⇒ owner 永不落空、永不指向编辑区。
 * owner 决定 size/min/max/onResizeEnd/aria-label 与 delta 符号（owner 在右 ⇒ 取反）。
 */
export function ownerOf(order: PaneId[], i: number): PaneId {
  const left = order[i - 1]
  return left !== undefined && left !== 'editor' ? left : order[i]!
}

interface PaneHandleProps {
  ownerId: PaneId
  ownerOnLeft: boolean
  colRefs: RefObject<Partial<Record<PaneId, HTMLDivElement | null>>>
  specs: PaneSizeSpecs
  sizes: Record<string, number>
  onResizeEnd: (key: string, px: number) => void
}

function PaneHandle({ownerId, ownerOnLeft, colRefs, specs, sizes, onResizeEnd}: PaneHandleProps) {
  const activeRef = useRef<{remove: () => void} | null>(null)
  const spec = specs[ownerId]!
  const size = sizes[ownerId] ?? spec.default

  const onMouseDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    // 只认左键：右键/中键不参与拖拽，也不该被 preventDefault 吞掉（会压掉右键菜单）
    if (e.button !== 0) return
    e.preventDefault()
    const el = colRefs.current[ownerId]
    if (!el) return

    // 起点信息全部留在闭包里，拖动过程中只改 DOM style，不触发 React 重渲染
    const startX = e.clientX
    const startSize = size
    const clamp = (px: number) => Math.min(spec.max, Math.max(spec.min, px))
    let current = startSize

    const onMove = (ev: MouseEvent) => {
      // 固定栏在左（ownerOnLeft）时向右拖 = 变大；在右时取反（等价于 SplitPane fixed='second'）
      current = clamp(startSize + (ev.clientX - startX) * (ownerOnLeft ? 1 : -1))
      el.style.flex = `0 0 ${current}px`
    }
    const onUp = () => {
      // 先摘登记再注销：重复 mouseup / 卸载兜底都只会提交一次
      const active = activeRef.current
      activeRef.current = null
      active?.remove()
      onResizeEnd(ownerId, clamp(current))
    }

    activeRef.current?.remove()
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    activeRef.current = {
      remove: () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      },
    }
  }

  useEffect(() => () => {
    activeRef.current?.remove()
    activeRef.current = null
  }, [])

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={PANE_RESIZE_LABEL[ownerId]}
      aria-valuenow={Math.round(size)}
      aria-valuemin={spec.min}
      aria-valuemax={spec.max}
      className="pm-split-handle pm-split-handle--x"
      onMouseDown={onMouseDown}
    />
  )
}

export interface PaneRowProps {
  /** 已提交的列顺序（拖动中的预览顺序由内部状态机维护） */
  order: PaneId[]
  sizes: Record<string, number>
  specs: PaneSizeSpecs
  /** 面板内容，按 pane id 取（外层持有 element ⇒ 换序不重建它的 element 身份） */
  panes: Record<PaneId, ReactNode>
  onResizeEnd: (key: string, px: number) => void
  onReorder: (next: PaneId[]) => void
  testId?: string
}

export function PaneRow({order, sizes, specs, panes, onResizeEnd, onReorder, testId}: PaneRowProps) {
  const dnd: PaneReorderApi = usePaneReorder(order, sizes, onReorder)

  return (
    <div className="pm-pane-row" data-testid={testId} ref={dnd.rowRef}>
      {/* 落点高亮 = 让位后的空槽（被拖列已用 transform 跟随指针离开该槽），无需第二个指示器 */}
      {dnd.placeholder && (
        <div
          className="pm-pane-placeholder"
          aria-hidden="true"
          style={{left: dnd.placeholder.left, width: dnd.placeholder.width}}
        />
      )}
      <PaneReorderContext.Provider value={dnd}>
        {dnd.order.map((id, i) => (
          <Fragment key={id}>
            {i > 0 && (
              <PaneHandle
                ownerId={ownerOf(dnd.order, i)}
                ownerOnLeft={ownerOf(dnd.order, i) === dnd.order[i - 1]}
                colRefs={dnd.colRefs}
                specs={specs}
                sizes={sizes}
                onResizeEnd={onResizeEnd}
              />
            )}
            <div
              className={clsx('pm-pane-col', dnd.draggingId === id && 'is-dragging')}
              data-pane-id={id}
              ref={el => dnd.setColRef(id, el)}
              // 编辑区恒为唯一弹性列：flex-basis 写 `0%` 而不是 `0`——两者在浏览器里等价
              // （单个弹性项吃掉全部剩余空间），但 jsdom 的 cssstyle 会静默丢弃无单位 0 的
              // flex 简写（style.flex 变空串）而 `0%` 可解析，测试才拿得到这条不变量。
              style={{flex: id === 'editor' ? '1 1 0%' : `0 0 ${sizes[id]}px`}}
            >
              {panes[id]}
            </div>
          </Fragment>
        ))}
      </PaneReorderContext.Provider>
    </div>
  )
}
