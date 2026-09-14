// tests/renderer/project-manager/paneRow.test.tsx
// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {render, screen, fireEvent, act} from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import {PaneRow, ownerOf} from '../../../src/renderer/project-manager/ui/PaneRow'
import {
  computePaneSlots, resolveDropIndex, movePane, HANDLE_W, usePaneReorderOptional,
} from '../../../src/renderer/project-manager/hooks/usePaneReorder'
import {DEFAULT_ORDER, type PaneId} from '../../../src/renderer/project-manager/hooks/paneOrder'
import type {PaneSizeSpecs} from '../../../src/renderer/project-manager/hooks/usePaneSize'

const SPECS: PaneSizeSpecs = {
  fileTree: {default: 200, min: 140, max: 420},
  changes: {default: 210, min: 200, max: 420},
}
// 注意：sizes 里**没有** editor 键（编辑区恒为弹性列）。若实现把它当固定列，
// computePaneSlots 会算出 NaN、inline flex 会变成 `0 0 undefinedpx`，下面的用例会立刻抓住。
const SIZES: Record<string, number> = {fileTree: 200, changes: 210}
const ROW_W = 1024   // jsdom：clientWidth=0 → 回落到 window.innerWidth(1024)

const ids = (): string[] => Array.from(document.querySelectorAll('.pm-pane-col')).map(el => el.getAttribute('data-pane-id')!)
const colOf = (id: PaneId): HTMLElement => document.querySelector<HTMLElement>(`.pm-pane-col[data-pane-id="${id}"]`)!

/** 面板内的把手：调用上下文里的 beginDrag（真实场景由 PanelHeader / 标签栏 gutter 触发） */
function DragGrip({id}: {id: PaneId}) {
  const dnd = usePaneReorderOptional()
  return <button type="button" data-testid={`grip-${id}`} onMouseDown={e => dnd?.beginDrag(id, e)}>grip</button>
}

function setup(order: PaneId[] = DEFAULT_ORDER) {
  const onReorder = vi.fn()
  const onResizeEnd = vi.fn()
  render(
    <PaneRow
      order={order}
      sizes={SIZES}
      specs={SPECS}
      testId="row"
      onResizeEnd={onResizeEnd}
      onReorder={onReorder}
      panes={{
        fileTree: <div data-testid="pane-fileTree"><DragGrip id="fileTree" /></div>,
        editor: <div data-testid="pane-editor"><DragGrip id="editor" /></div>,
        changes: <div data-testid="pane-changes"><DragGrip id="changes" /></div>,
      }}
    />,
  )
  return {onReorder, onResizeEnd}
}

/** 起手 + 至少一次移动（同一 act 内：原生 dispatchEvent 不经 RTL 的 act 包装） */
function dragTo(id: PaneId, fromX: number, toX: number, opts: {release?: boolean} = {}) {
  act(() => {
    fireEvent.mouseDown(screen.getByTestId(`grip-${id}`), {clientX: fromX, clientY: 10})
    document.dispatchEvent(new MouseEvent('mousemove', {clientX: toX, clientY: 10, bubbles: true}))
  })
  if (opts.release !== false) {
    act(() => { document.dispatchEvent(new MouseEvent('mouseup', {bubbles: true})) })
  }
}

beforeEach(() => {
  document.documentElement.className = ''
})

describe('computePaneSlots', () => {
  it('编辑区在中间：固定列 = sizes，编辑区吃掉 rowW - 固定和 - 2 条 5px', () => {
    const slots = computePaneSlots(DEFAULT_ORDER, SIZES, ROW_W)
    expect(slots).toEqual([
      {id: 'fileTree', left: 0, width: 200, center: 100},
      {id: 'editor', left: 205, width: ROW_W - 200 - 210 - 2 * HANDLE_W, center: 205 + 302},
      {id: 'changes', left: 814, width: 210, center: 919},
    ])
    expect(slots[1]!.width).toBe(604)
  })

  it('编辑区在最左：后续固定列整体左移', () => {
    const slots = computePaneSlots(['editor', 'fileTree', 'changes'], SIZES, ROW_W)
    expect(slots.map(s => [s.id, s.left, s.width])).toEqual([
      ['editor', 0, 604],
      ['fileTree', 609, 200],
      ['changes', 814, 210],
    ])
  })

  it('编辑区在最右：固定列在前，弹性列收尾', () => {
    const slots = computePaneSlots(['fileTree', 'changes', 'editor'], SIZES, ROW_W)
    expect(slots.map(s => [s.id, s.left, s.width])).toEqual([
      ['fileTree', 0, 200],
      ['changes', 205, 210],
      ['editor', 420, 604],
    ])
  })

  it('行宽小于固定列之和时弹性列宽度夹到 0（不出现负值 / NaN）', () => {
    const slots = computePaneSlots(DEFAULT_ORDER, SIZES, 300)
    expect(slots[1]!.width).toBe(0)
    expect(slots.every(s => Number.isFinite(s.width) && s.width >= 0)).toBe(true)
  })

  it('sizes 里没有 editor 键：宽度仍是有限数（不会被当成固定列算出 NaN）', () => {
    expect('editor' in SIZES).toBe(false)
    expect(computePaneSlots(DEFAULT_ORDER, SIZES, ROW_W)[1]!.width).toBe(604)
  })
})

describe('resolveDropIndex / movePane', () => {
  it('指针在首列中点左侧 → 落点 0', () => {
    expect(resolveDropIndex(DEFAULT_ORDER, SIZES, ROW_W, 'fileTree', 50)).toBe(0)
  })

  it('越过编辑区中点 → 落点 1；越过变更列表中点 → 落点 2', () => {
    expect(resolveDropIndex(DEFAULT_ORDER, SIZES, ROW_W, 'fileTree', 600)).toBe(1)
    expect(resolveDropIndex(DEFAULT_ORDER, SIZES, ROW_W, 'fileTree', 1000)).toBe(2)
  })

  it('恰好落在中点上不算越过（严格大于）', () => {
    expect(resolveDropIndex(DEFAULT_ORDER, SIZES, ROW_W, 'fileTree', 507)).toBe(0)
  })

  it('被拖列自身不参与计数', () => {
    // 拖 changes 时，只剩 fileTree(100) / editor(507) 两个中点
    expect(resolveDropIndex(DEFAULT_ORDER, SIZES, ROW_W, 'changes', 1000)).toBe(2)
    expect(resolveDropIndex(DEFAULT_ORDER, SIZES, ROW_W, 'changes', 50)).toBe(0)
  })

  it('movePane 按"移除 id 后的下标"插入；越界下标被夹紧', () => {
    expect(movePane(DEFAULT_ORDER, 'fileTree', 2)).toEqual(['editor', 'changes', 'fileTree'])
    expect(movePane(DEFAULT_ORDER, 'changes', 0)).toEqual(['changes', 'fileTree', 'editor'])
    expect(movePane(DEFAULT_ORDER, 'fileTree', 99)).toEqual(['editor', 'changes', 'fileTree'])
    expect(movePane(DEFAULT_ORDER, 'fileTree', -5)).toEqual(['fileTree', 'editor', 'changes'])
  })
})

describe('ownerOf（分隔条归属规则）', () => {
  it('默认顺序：第 1 条属于左侧的文件树，第 2 条属于右侧的变更列表（中间是弹性列）', () => {
    expect(ownerOf(DEFAULT_ORDER, 1)).toBe('fileTree')
    expect(ownerOf(DEFAULT_ORDER, 2)).toBe('changes')
  })

  it('任意排列下 owner 永不指向编辑区', () => {
    for (const order of [
      ['fileTree', 'editor', 'changes'],
      ['editor', 'fileTree', 'changes'],
      ['fileTree', 'changes', 'editor'],
      ['editor', 'changes', 'fileTree'],
      ['changes', 'fileTree', 'editor'],
      ['changes', 'editor', 'fileTree'],
    ] as PaneId[][]) {
      expect(ownerOf(order, 1), order.join('|')).not.toBe('editor')
      expect(ownerOf(order, 2), order.join('|')).not.toBe('editor')
    }
  })
})

describe('PaneRow 渲染', () => {
  it('默认顺序：DOM 列序 = fileTree, editor, changes', () => {
    setup()
    expect(ids()).toEqual(['fileTree', 'editor', 'changes'])
  })

  it('编辑区列 inline flex 恒为 1 1 0%（弹性）且不含 px；固定列 flex 为 0 0 <size>px', () => {
    setup()
    expect(colOf('editor').style.flex).toBe('1 1 0%')
    expect(colOf('editor').style.flex).not.toMatch(/px/)
    expect(colOf('fileTree').style.flex).toBe('0 0 200px')
    expect(colOf('changes').style.flex).toBe('0 0 210px')
  })

  it('编辑区不在中间时（最左 / 最右）仍是唯一弹性列', () => {
    setup(['editor', 'fileTree', 'changes'])
    expect(colOf('editor').style.flex).toBe('1 1 0%')
    expect(ids()).toEqual(['editor', 'fileTree', 'changes'])
  })

  it('渲染 2 条分隔条，可访问名跟 pane 不跟位置', () => {
    setup()
    const seps = screen.getAllByRole('separator')
    expect(seps).toHaveLength(2)
    expect(screen.getByRole('separator', {name: '文件树宽度'})).toHaveAttribute('aria-orientation', 'vertical')
    expect(screen.getByRole('separator', {name: '变更列表宽度'})).toHaveAttribute('aria-orientation', 'vertical')
  })

  it('顺序变化后分隔条仍跟 pane：最左是最右固定列时，左侧条归属右侧列', () => {
    setup(['editor', 'changes', 'fileTree'])
    // 第 1 条（editor|changes 之间）左侧是弹性列 → 归右侧 changes；第 2 条（changes|fileTree）左侧是 changes
    const seps = screen.getAllByRole('separator')
    expect(seps.map(s => s.getAttribute('aria-label'))).toEqual(['变更列表宽度', '变更列表宽度'])
  })

  it('拖动中不额外渲染任何 separator（placeholder 必须 aria-hidden）', () => {
    setup()
    dragTo('fileTree', 10, 900, {release: false})
    expect(screen.getAllByRole('separator')).toHaveLength(2)
    const ph = document.querySelector('.pm-pane-placeholder')!
    expect(ph).not.toBeNull()
    expect(ph).toHaveAttribute('aria-hidden', 'true')
    expect(ph.getAttribute('role')).toBeNull()
  })
})

describe('PaneRow 拖拽换序', () => {
  it('越过中点 → 列真实换序 + 被拖列 is-dragging + 占位框落在目标槽', () => {
    const {onReorder} = setup()
    dragTo('fileTree', 10, 900, {release: false})
    expect(ids()).toEqual(['editor', 'fileTree', 'changes'])
    expect(colOf('fileTree')).toHaveClass('is-dragging')
    expect(colOf('editor')).not.toHaveClass('is-dragging')
    const ph = document.querySelector<HTMLElement>('.pm-pane-placeholder')!
    expect(ph.style.left).toBe('609px')    // fileTree 在新顺序里的槽位
    expect(ph.style.width).toBe('200px')
    expect(onReorder).not.toHaveBeenCalled()   // 松手前不提交
  })

  it('被拖列每帧写 transform（DOM-only），松手后清空', () => {
    const {onReorder} = setup()
    dragTo('fileTree', 10, 900, {release: false})
    expect(colOf('fileTree').style.transform).not.toBe('')
    act(() => { document.dispatchEvent(new MouseEvent('mouseup', {bubbles: true})) })
    expect(colOf('fileTree').style.transform).toBe('')
    expect(colOf('fileTree')).not.toHaveClass('is-dragging')
    expect(document.querySelector('.pm-pane-placeholder')).toBeNull()
    expect(onReorder).toHaveBeenCalledTimes(1)
    expect(onReorder).toHaveBeenCalledWith(['editor', 'fileTree', 'changes'])
  })

  it('未跨中点的拖动：松手不提交、不换序', () => {
    const {onReorder} = setup()
    dragTo('fileTree', 10, 300)
    expect(onReorder).not.toHaveBeenCalled()
    expect(ids()).toEqual(['fileTree', 'editor', 'changes'])
  })

  it('位移小于 3px：不进 dragging、不出现 is-dragging、无占位框、不提交', () => {
    const {onReorder} = setup()
    dragTo('fileTree', 10, 12)
    expect(colOf('fileTree')).not.toHaveClass('is-dragging')
    expect(document.querySelector('.pm-pane-placeholder')).toBeNull()
    expect(onReorder).not.toHaveBeenCalled()
  })

  it('右键 mousedown 不起手，也不吞掉右键菜单（不 preventDefault）', () => {
    const {onReorder} = setup()
    const grip = screen.getByTestId('grip-fileTree')
    const down = new MouseEvent('mousedown', {clientX: 10, button: 2, bubbles: true, cancelable: true})
    fireEvent(grip, down)
    expect(down.defaultPrevented).toBe(false)
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', {clientX: 900, bubbles: true}))
      document.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}))
    })
    expect(ids()).toEqual(['fileTree', 'editor', 'changes'])
    expect(onReorder).not.toHaveBeenCalled()
  })

  it('mouseup 之后继续 mousemove / mouseup 无副作用（监听器已摘除）', () => {
    const {onReorder} = setup()
    dragTo('fileTree', 10, 900)
    expect(onReorder).toHaveBeenCalledTimes(1)
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', {clientX: 100, bubbles: true}))
      document.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}))
    })
    expect(onReorder).toHaveBeenCalledTimes(1)
    expect(colOf('fileTree').style.transform).toBe('')
  })

  it('拖动期挂全局类 pm-is-pane-reordering，松手 / Escape 后移除', () => {
    setup()
    dragTo('fileTree', 10, 900, {release: false})
    expect(document.documentElement.classList.contains('pm-is-pane-reordering')).toBe(true)
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})) })
    expect(document.documentElement.classList.contains('pm-is-pane-reordering')).toBe(false)
  })

  it('Escape 取消拖动：不提交，且列回到已提交顺序', () => {
    const {onReorder} = setup()
    dragTo('fileTree', 10, 900, {release: false})
    expect(ids()).toEqual(['editor', 'fileTree', 'changes'])
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})) })
    expect(ids()).toEqual(['fileTree', 'editor', 'changes'])
    expect(onReorder).not.toHaveBeenCalled()
  })

  it('拖到最右：fileTree 从最左移到最右', () => {
    const {onReorder} = setup()
    dragTo('fileTree', 10, 1000)
    expect(onReorder).toHaveBeenCalledWith(['editor', 'changes', 'fileTree'])
  })

  it('被拖列之外的列会腾挪（DOM 顺序变化），但拖拽者自身保持 is-dragging 语义', () => {
    setup()
    dragTo('changes', 1000, 10, {release: false})
    expect(ids()).toEqual(['changes', 'fileTree', 'editor'])
    expect(colOf('changes')).toHaveClass('is-dragging')
    expect(colOf('fileTree')).not.toHaveClass('is-dragging')
    expect(colOf('editor')).not.toHaveClass('is-dragging')
  })

  it('拖动不 remount 面板子树：换序前后同一个 DOM 节点', () => {
    const {onReorder} = setup()
    const before = screen.getByTestId('pane-fileTree')
    const beforeCol = colOf('fileTree')
    dragTo('fileTree', 10, 1000)
    expect(onReorder).toHaveBeenCalled()
    expect(screen.getByTestId('pane-fileTree')).toBe(before)   // 同一节点 ⇒ 组件实例未被卸载重建
    expect(colOf('fileTree')).toBe(beforeCol)
  })

  it('拖拽中途卸载：mousemove/mouseup 监听成对摘除，全局类被清理', () => {
    const add = vi.spyOn(document, 'addEventListener')
    const remove = vi.spyOn(document, 'removeEventListener')
    try {
      const {unmount} = render(
        <PaneRow
          order={DEFAULT_ORDER}
          sizes={SIZES}
          specs={SPECS}
          onResizeEnd={vi.fn()}
          onReorder={vi.fn()}
          panes={{fileTree: <DragGrip id="fileTree" />, editor: <span />, changes: <span />}}
        />,
      )
      act(() => { fireEvent.mouseDown(screen.getByTestId('grip-fileTree'), {clientX: 10, clientY: 10}) })
      act(() => { document.dispatchEvent(new MouseEvent('mousemove', {clientX: 100, clientY: 10, bubbles: true})) })
      const added = add.mock.calls.filter(c => c[0] === 'mousemove').length
      const removed = () => remove.mock.calls.filter(c => c[0] === 'mousemove').length
      expect(added).toBeGreaterThan(0)
      unmount()
      expect(removed()).toBe(added)
      expect(document.documentElement.classList.contains('pm-is-pane-reordering')).toBe(false)
    } finally {
      add.mockRestore()
      remove.mockRestore()
    }
  })
})

describe('PaneRow 分隔条拖尺寸', () => {
  it('拖动文件树分隔条：只改 owner 列的 inline flex，松手提交一次', () => {
    const {onResizeEnd} = setup()
    const handle = screen.getByRole('separator', {name: '文件树宽度'})
    act(() => {
      fireEvent.mouseDown(handle, {clientX: 200})
      document.dispatchEvent(new MouseEvent('mousemove', {clientX: 260, bubbles: true}))
    })
    expect(colOf('fileTree').style.flex).toBe('0 0 260px')
    act(() => { document.dispatchEvent(new MouseEvent('mouseup', {bubbles: true})) })
    expect(onResizeEnd).toHaveBeenCalledWith('fileTree', 260)
  })

  it('拖动变更列表分隔条：owner 在右 → delta 取反', () => {
    const {onResizeEnd} = setup()
    const handle = screen.getByRole('separator', {name: '变更列表宽度'})
    act(() => {
      fireEvent.mouseDown(handle, {clientX: 800})
      document.dispatchEvent(new MouseEvent('mousemove', {clientX: 760, bubbles: true}))
    })
    act(() => { document.dispatchEvent(new MouseEvent('mouseup', {bubbles: true})) })
    expect(onResizeEnd).toHaveBeenCalledWith('changes', 250)
  })

  it('分隔条暴露 aria-valuenow / min / max（换序后仍取 owner 列的值）', () => {
    // ['fileTree','changes','editor']：两条分隔条的 owner 分别是左侧的 fileTree 与 changes
    setup(['fileTree', 'changes', 'editor'])
    const tree = screen.getByRole('separator', {name: '文件树宽度'})
    expect(tree).toHaveAttribute('aria-valuenow', '200')
    expect(tree).toHaveAttribute('aria-valuemin', '140')
    expect(tree).toHaveAttribute('aria-valuemax', '420')
    const changes = screen.getByRole('separator', {name: '变更列表宽度'})
    expect(changes).toHaveAttribute('aria-valuenow', '210')
    expect(changes).toHaveAttribute('aria-valuemin', '200')
    expect(changes).toHaveAttribute('aria-valuemax', '420')
  })

  it('两条分隔条夹同一固定列时（editor 在最左）都归属它，均可调它', () => {
    const {onResizeEnd} = setup(['editor', 'fileTree', 'changes'])
    expect(screen.getAllByRole('separator', {name: '文件树宽度'})).toHaveLength(2)
    const handles = screen.getAllByRole('separator')
    // 左侧那条：owner 在右 → 向右拖变小
    act(() => {
      fireEvent.mouseDown(handles[0]!, {clientX: 600})
      document.dispatchEvent(new MouseEvent('mousemove', {clientX: 660, bubbles: true}))
      document.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}))
    })
    expect(onResizeEnd).toHaveBeenCalledWith('fileTree', 140)
    // 右侧那条：owner 在左 → 向右拖变大
    act(() => {
      fireEvent.mouseDown(handles[1]!, {clientX: 800})
      document.dispatchEvent(new MouseEvent('mousemove', {clientX: 860, bubbles: true}))
      document.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}))
    })
    expect(onResizeEnd).toHaveBeenLastCalledWith('fileTree', 260)
  })
})
