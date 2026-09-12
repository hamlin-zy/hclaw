// tests/renderer/project-manager/splitPane.test.tsx
// @vitest-environment jsdom
import {describe, it, expect, vi} from 'vitest'
import {render, screen, fireEvent} from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import {readFileSync} from 'fs'
import {join} from 'path'
import {SplitPane} from '../../../src/renderer/project-manager/ui/SplitPane'

function setup(overrides: Partial<React.ComponentProps<typeof SplitPane>> = {}) {
  const onResizeEnd = vi.fn()
  render(
    <SplitPane
      axis="x"
      size={200}
      min={140}
      max={420}
      onResizeEnd={onResizeEnd}
      label="文件树宽度"
      first={<div>左栏</div>}
      second={<div>右栏</div>}
      {...overrides}
    />,
  )
  return {onResizeEnd}
}

function drag(from: number, to: number, axis: 'x' | 'y' = 'x') {
  const handle = screen.getByRole('separator')
  fireEvent.mouseDown(handle, axis === 'x' ? {clientX: from} : {clientY: from})
  const coords = axis === 'x' ? {clientX: to} : {clientY: to}
  document.dispatchEvent(new MouseEvent('mousemove', {...coords, bubbles: true}))
  document.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}))
}

describe('SplitPane 渲染', () => {
  it('渲染两栏与分隔条', () => {
    setup()
    expect(screen.getByText('左栏')).toBeInTheDocument()
    expect(screen.getByText('右栏')).toBeInTheDocument()
    expect(screen.getByRole('separator')).toBeInTheDocument()
  })

  it('横向分栏的 aria-orientation 为 vertical，纵向为 horizontal', () => {
    setup()
    expect(screen.getByRole('separator')).toHaveAttribute('aria-orientation', 'vertical')
  })

  it('纵向分栏的 aria-orientation 为 horizontal', () => {
    setup({axis: 'y', label: 'Git 区高度'})
    expect(screen.getByRole('separator')).toHaveAttribute('aria-orientation', 'horizontal')
  })

  it('暴露 aria-valuenow / min / max', () => {
    setup()
    const handle = screen.getByRole('separator')
    expect(handle).toHaveAttribute('aria-valuenow', '200')
    expect(handle).toHaveAttribute('aria-valuemin', '140')
    expect(handle).toHaveAttribute('aria-valuemax', '420')
  })

  it('组件自身不写内联样式（样式一律走 .pm-* 类）', () => {
    setup()
    expect(screen.getByRole('separator').getAttribute('style')).toBeNull()
    expect(screen.getByText('左栏').parentElement!.getAttribute('style')).not.toBeNull()   // 第一栏只有动态 flex
    expect(screen.getByText('右栏').parentElement!.getAttribute('style')).toBeNull()
  })
})

describe('SplitPane 拖拽', () => {
  it('向右拖动后提交新宽度', () => {
    const {onResizeEnd} = setup()
    drag(200, 260)
    expect(onResizeEnd).toHaveBeenCalledWith(260)
  })

  it('拖动期间直接改 DOM style，不走 React state', () => {
    setup()
    const handle = screen.getByRole('separator')
    fireEvent.mouseDown(handle, {clientX: 200})
    document.dispatchEvent(new MouseEvent('mousemove', {clientX: 275, bubbles: true}))
    expect(screen.getByText('左栏').parentElement!.style.flex).toBe('0 0 275px')
  })

  it('小于 min 时夹到 min', () => {
    const {onResizeEnd} = setup()
    drag(200, -5000)
    expect(onResizeEnd).toHaveBeenCalledWith(140)
  })

  it('大于 max 时夹到 max', () => {
    const {onResizeEnd} = setup()
    drag(200, 5000)
    expect(onResizeEnd).toHaveBeenCalledWith(420)
  })

  it('纵向拖动使用 clientY', () => {
    const {onResizeEnd} = setup({axis: 'y', size: 236, min: 120, max: 600, label: 'Git 区高度'})
    drag(236, 336, 'y')
    expect(onResizeEnd).toHaveBeenCalledWith(336)
  })

  it('fixed="second" 时向右拖使右侧固定栏变小（delta 取反）', () => {
    // min 取 100（< 160）以便断言检验**纯粹的 delta 取反**；夹取边界已由前后两例单独覆盖。
    // 注：若沿用生产 spec 的 min=200，210-50=160 会被夹到 200，断言将失去对符号的区分度。
    const {onResizeEnd} = setup({fixed: 'second', size: 210, min: 100, max: 420, label: '变更列表宽度'})
    drag(210, 260)          // 向右拖 50px
    expect(onResizeEnd).toHaveBeenCalledWith(160)   // 210 - 50
  })

  it('fixed="second" 时左侧吃掉剩余空间，只有右侧带内联 flex', () => {
    setup({fixed: 'second', size: 210, label: '变更列表宽度'})
    expect(screen.getByText('右栏').parentElement!.getAttribute('style')).not.toBeNull()
    expect(screen.getByText('左栏').parentElement!.getAttribute('style')).toBeNull()
  })

  it('mouseup 后不再响应后续 mousemove', () => {
    const {onResizeEnd} = setup()
    drag(200, 260)
    onResizeEnd.mockClear()
    document.dispatchEvent(new MouseEvent('mousemove', {clientX: 400, bubbles: true}))
    document.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}))
    expect(onResizeEnd).not.toHaveBeenCalled()
  })

  it('仅左键起手：右键 mousedown 不启动拖拽，也不 preventDefault（不吞掉右键菜单）', () => {
    const {onResizeEnd} = setup()
    const handle = screen.getByRole('separator')
    const down = new MouseEvent('mousedown', {clientX: 200, button: 2, bubbles: true, cancelable: true})
    fireEvent(handle, down)
    expect(down.defaultPrevented).toBe(false)
    document.dispatchEvent(new MouseEvent('mousemove', {clientX: 400, bubbles: true}))
    document.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}))
    expect(onResizeEnd).not.toHaveBeenCalled()
  })
})

describe('分隔条样式契约（spec §5.3）', () => {
  const CSS = readFileSync(join(process.cwd(), 'src/renderer/styles/globals.css'), 'utf-8')

  it('命中区 5px 且透明', () => {
    const m = CSS.match(/\.pm-split-handle\s*\{([^}]*)\}/)
    expect(m, '缺少 .pm-split-handle 规则').not.toBeNull()
    expect(m![1]).toMatch(/flex\s*:\s*0 0 5px/)
    expect(m![1]).toMatch(/background\s*:\s*transparent/)
  })

  it('光标随轴向变化', () => {
    expect(CSS).toMatch(/\.pm-split-handle--x\s*\{[^}]*cursor\s*:\s*col-resize/)
    expect(CSS).toMatch(/\.pm-split-handle--y\s*\{[^}]*cursor\s*:\s*row-resize/)
  })

  it('回归守卫：不得有 hover 浮动反馈（用户明确要求）', () => {
    expect(CSS).not.toMatch(/\.pm-split-handle:hover/)
  })
})
