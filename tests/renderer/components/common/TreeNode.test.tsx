// @vitest-environment jsdom
import '@testing-library/jest-dom'
import {describe, it, expect, vi} from 'vitest'
import {render, screen, fireEvent} from '@testing-library/react'
import {TreeNode, TreeChevron} from '../../../../src/renderer/components/common/TreeNode'

/** 复刻浏览器真实双击序列：click(1) → click(2) → dblclick。
 *  注意 fireEvent.doubleClick 只派发一个 dblclick、不带前置 click 与 detail，
 *  用它测「净一次切换」会恒真通过（spec §7.2）。 */
function doubleClickWithClicks(el: Element, row: Element) {
  fireEvent.click(el, {detail: 1, bubbles: true})
  fireEvent.click(el, {detail: 2, bubbles: true})
  fireEvent.dblClick(row, {bubbles: true})
}

describe('TreeChevron', () => {
  it('hasChildren=true 渲染 chevron 按钮（role=button + svg）', () => {
    render(<TreeChevron expanded hasChildren />)
    expect(screen.getByRole('button', {name: /折叠|展开/})).toBeInTheDocument()
    expect(document.querySelector('svg polyline')).not.toBeNull()
  })

  it('expanded 时 svg 应用 rotate(90deg) 样式', () => {
    const {container} = render(<TreeChevron expanded hasChildren />)
    const svg = container.querySelector('svg')!
    expect(svg).toHaveStyle({transform: 'rotate(90deg)'})
  })

  it('未展开时 svg 不应用 rotate(90deg)', () => {
    const {container} = render(<TreeChevron expanded={false} hasChildren />)
    const svg = container.querySelector('svg')!
    expect(svg).toHaveStyle({transform: 'rotate(0deg)'})
  })

  it('hasChildren=false 渲染空占位 span（保持左右行名字对齐）', () => {
    const {container} = render(<TreeChevron hasChildren={false} />)
    expect(container.querySelector('[role="button"]')).toBeNull()
    const placeholder = container.querySelector('span[aria-hidden="true"]')
    expect(placeholder).not.toBeNull()
    expect(placeholder!).toHaveStyle({width: '12px'})
  })

  it('chevron 点击触发 onClick 并 stopPropagation', () => {
    const click = vi.fn()
    const parent = vi.fn(e => e.stopPropagation())
    const {container} = render(
      <div onClick={parent}>
        <TreeChevron expanded hasChildren onClick={click} />
      </div>
    )
    fireEvent.click(container.querySelector('[role="button"]')!)
    expect(click).toHaveBeenCalledTimes(1)
    expect(parent).not.toHaveBeenCalled()
  })

  it('双击箭头 = 净一次切换（detail>1 的第二跳被忽略）', () => {
    const onToggle = vi.fn()
    render(<TreeNode label="src" hasChildren onClick={() => {}} onToggle={onToggle} ariaLabel="dbl-chevron" />)
    const row = screen.getByRole('treeitem', {name: 'dbl-chevron'})
    doubleClickWithClicks(row.querySelector('[role="button"]')!, row)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('dblclick 不冒泡到行（行级 onDoubleClick 不被触发）', () => {
    const onDoubleClick = vi.fn()
    render(<TreeNode label="src" hasChildren onDoubleClick={onDoubleClick} ariaLabel="dbl-chevron-row" />)
    const row = screen.getByRole('treeitem', {name: 'dbl-chevron-row'})
    fireEvent.dblClick(row.querySelector('[role="button"]')!, {bubbles: true})
    expect(onDoubleClick).not.toHaveBeenCalled()
  })

  it('键盘路径不回归：chevron 吞掉 Enter 且不冒泡', () => {
    const onKeyDown = vi.fn()
    render(<div onKeyDown={onKeyDown}><TreeChevron expanded hasChildren /></div>)
    fireEvent.keyDown(screen.getByRole('button', {name: '折叠'}), {key: 'Enter', bubbles: true})
    expect(onKeyDown).not.toHaveBeenCalled()
  })
})

describe('TreeNode', () => {
  const queryRow = (ariaName: string) =>
    screen.getByRole('treeitem', {name: ariaName}) as HTMLElement

  it('渲染基础结构：外层 button + 内层 chevron + icon + label', () => {
    render(<TreeNode label="src" icon="📁" hasChildren expanded ariaLabel="src-node" />)
    const row = queryRow('src-node')
    expect(row).toBeInTheDocument()
    expect(row.tagName).toBe('BUTTON')
    expect(row).toHaveAttribute('aria-expanded', 'true')
    expect(row).toHaveAttribute('aria-selected', 'false')
    // 内部 chevron 存在（span role=button）
    expect(row.querySelector('[role="button"]')).not.toBeNull()
    // label 存在
    expect(screen.getByText('src')).toBeInTheDocument()
    // icon 存在
    expect(row.textContent).toContain('📁')
  })

  it('hasChildren=false 时 chevron 变为占位（不渲染 chevron role=button）', () => {
    render(<TreeNode label="a.ts" icon="📄" hasChildren={false} ariaLabel="a-file" />)
    const row = queryRow('a-file')
    expect(row.querySelector('[role="button"]')).toBeNull()
    // 占位 span 存在
    expect(row.querySelector('span[aria-hidden="true"]')).not.toBeNull()
  })

  it('selected 时应用 brand-muted 背景 + inset box-shadow', () => {
    render(<TreeNode label="src" icon="📁" hasChildren selected ariaLabel="src-selected" />)
    const row = queryRow('src-selected')
    expect(row).toHaveStyle({background: 'var(--brand-muted)'})
    expect(row).toHaveStyle({boxShadow: 'inset 2px 0 0 var(--brand-primary)'})
  })

  it('未 selected 时不应用品牌背景', () => {
    render(<TreeNode label="src" icon="📁" hasChildren ariaLabel="src-notsel" />)
    const row = queryRow('src-notsel')
    expect(row).toHaveStyle({background: 'transparent'})
  })

  it('depth 影响 paddingLeft：depth=0 → 4px，depth=1 → 18px', () => {
    render(<TreeNode label="root" depth={0} ariaLabel="root-depth" />)
    expect(queryRow('root-depth')).toHaveStyle({paddingLeft: '4px'})
    render(<TreeNode label="child" depth={1} ariaLabel="child-depth" />)
    expect(queryRow('child-depth')).toHaveStyle({paddingLeft: '18px'})
  })

  it('整行点击触发 onClick', () => {
    const onClick = vi.fn()
    render(<TreeNode label="src" onClick={onClick} ariaLabel="click-target" />)
    fireEvent.click(queryRow('click-target'))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('chevron 点击触发 onToggle 且不冒泡到行 onClick', () => {
    const onClick = vi.fn()
    const onToggle = vi.fn()
    render(<TreeNode label="src" hasChildren onClick={onClick} onToggle={onToggle} ariaLabel="toggle-target" />)
    const row = queryRow('toggle-target')
    const chevron = row.querySelector('[role="button"]')!
    fireEvent.click(chevron)
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('onDoubleClick 独立于 onClick', () => {
    const onClick = vi.fn()
    const onDoubleClick = vi.fn()
    render(<TreeNode label="a.ts" onClick={onClick} onDoubleClick={onDoubleClick} ariaLabel="dbl-target" />)
    const row = queryRow('dbl-target')
    fireEvent.click(row)
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(onDoubleClick).not.toHaveBeenCalled()
    fireEvent.doubleClick(row)
    expect(onDoubleClick).toHaveBeenCalledTimes(1)
  })

  it('muted 应用 opacity 0.7', () => {
    render(<TreeNode label="dim" muted ariaLabel="muted-target" />)
    expect(queryRow('muted-target')).toHaveStyle({opacity: '0.7'})
  })

  it('onContextMenu 传递', () => {
    const onContextMenu = vi.fn()
    render(<TreeNode label="x" onContextMenu={onContextMenu} ariaLabel="ctx-target" />)
    fireEvent.contextMenu(queryRow('ctx-target'))
    expect(onContextMenu).toHaveBeenCalledTimes(1)
  })

  it('trailing 渲染在行尾', () => {
    render(<TreeNode label="src" hasChildren trailing="3" ariaLabel="trailing-target" />)
    const row = queryRow('trailing-target')
    expect(row.textContent).toContain('3')
  })
})
