// @vitest-environment jsdom
import {describe, it, expect, vi, beforeAll} from 'vitest'
import {render, screen, fireEvent} from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import {readFileSync} from 'fs'
import {join} from 'path'
import {TreeRow} from '../../../src/renderer/project-manager/ui/TreeRow'
import {StatusBadge} from '../../../src/renderer/project-manager/ui/StatusBadge'
import {statusClassSuffix} from '../../../src/renderer/project-manager/lib/statusColor'

// vitest.config.ts 未开启 css: true，globals.css 不会自动进入 jsdom。
// 本文件断言 .pm-tree-row / .pm-tree-row-name 的计算样式，故手动注入一次真实样式表
// （与 themeTokens.test.ts 直接读 globals.css 的做法同源，只是这里落进 <style>）。
beforeAll(() => {
  const css = readFileSync(join(process.cwd(), 'src/renderer/styles/globals.css'), 'utf-8')
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
})

describe('TreeRow 缩进尺度 §13.3', () => {
  it.each([[0, '8px'], [1, '13px'], [2, '26px'], [3, '39px']])('depth %i → paddingLeft %s', (depth, expected) => {
    render(<TreeRow label={`L${depth}`} depth={depth} />)
    expect(screen.getByRole('treeitem')).toHaveStyle({paddingLeft: expected})
  })
})

describe('TreeRow 单行铁律 §13.1', () => {
  it('名称列 nowrap + hidden + ellipsis + min-width 0', () => {
    render(<TreeRow label="很长的文件名字很长的文件名字很长的文件名字" depth={1} />)
    const name = screen.getByText('很长的文件名字很长的文件名字很长的文件名字')
    const cs = getComputedStyle(name)
    expect(cs.whiteSpace).toBe('nowrap')
    expect(cs.overflow).toBe('hidden')
    expect(cs.textOverflow).toBe('ellipsis')
    expect(cs.minWidth).toBe('0px')
  })

  it('行高固定 20px', () => {
    render(<TreeRow label="a" depth={1} />)
    expect(getComputedStyle(screen.getByRole('treeitem')).height).toBe('20px')
  })
})

describe('TreeRow aria 契约（与 common/TreeNode 一致）', () => {
  it('行是 role=treeitem 且带 aria-selected / aria-label', () => {
    render(<TreeRow label="src" depth={1} ariaLabel="src" selected />)
    const row = screen.getByRole('treeitem', {name: 'src'})
    expect(row).toHaveAttribute('aria-selected', 'true')
  })

  it('hasChildren 时 chevron 是 role=button 且带 aria-expanded', () => {
    render(<TreeRow label="src" depth={1} ariaLabel="src" hasChildren expanded />)
    const row = screen.getByRole('treeitem', {name: 'src'})
    expect(row.querySelector('[role="button"]')).not.toBeNull()
    expect(row).toHaveAttribute('aria-expanded', 'true')
  })

  it('hasChildren=false 时 chevron 退化为无 role 的占位（文件行）', () => {
    render(<TreeRow label="a.ts" depth={1} ariaLabel="a.ts" />)
    const row = screen.getByRole('treeitem', {name: 'a.ts'})
    expect(row.querySelector('[role="button"]')).toBeNull()
    expect(row).not.toHaveAttribute('aria-expanded')
  })

  it('onToggle 存在时点 chevron 触发 onToggle 且不冒泡到行点击', () => {
    const onToggle = vi.fn()
    const onClick = vi.fn()
    render(<TreeRow label="src" depth={1} ariaLabel="src" hasChildren onToggle={onToggle} onClick={onClick} />)
    fireEvent.click(screen.getByRole('button', {name: '展开'}))
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('trailing 渲染在行尾', () => {
    render(<TreeRow label="a" depth={1} trailing={<StatusBadge status="M" />} />)
    expect(screen.getByTestId('status-badge')).toHaveTextContent('M')
  })
})

describe('StatusBadge §3.1 三重编码', () => {
  it.each([
    ['M', 'M', '已修改', 'pm-c--M'],
    ['A', 'A', '已新增', 'pm-c--A'],
    ['D', 'D', '已删除', 'pm-c--D'],
    ['R', 'R', '已重命名', 'pm-c--R'],
    ['??', '??', '未跟踪', 'pm-c--untracked'],
  ] as const)('%s → 字母 %s / aria-label %s / 类 %s', (status, letter, label, cls) => {
    render(<StatusBadge status={status} />)
    const badge = screen.getByTestId('status-badge')
    expect(badge).toHaveTextContent(letter)
    expect(badge).toHaveAttribute('aria-label', label)
    expect(badge).toHaveClass(cls)
  })

  it('none 渲染空字母、无 aria-label', () => {
    render(<StatusBadge status="none" />)
    const badge = screen.getByTestId('status-badge')
    expect(badge.textContent).toBe('')
    expect(badge).not.toHaveAttribute('aria-label')
  })
})

describe('statusClassSuffix', () => {
  it('?? 映射为 untracked，其余原样', () => {
    expect(statusClassSuffix('??')).toBe('untracked')
    expect(statusClassSuffix('M')).toBe('M')
    expect(statusClassSuffix('none')).toBe('none')
  })
})

describe('TreeRow data-path（spec §3.1 定位锚点）', () => {
  it('传 path 时渲染 data-path', () => {
    render(<TreeRow label="c.ts" depth={2} ariaLabel="c.ts" path="a/b/c.ts" />)
    expect(screen.getByRole('treeitem', {name: 'c.ts'})).toHaveAttribute('data-path', 'a/b/c.ts')
  })

  it('不传 path 时无 data-path 属性', () => {
    render(<TreeRow label="x" depth={0} ariaLabel="x" />)
    expect(screen.getByRole('treeitem', {name: 'x'})).not.toHaveAttribute('data-path')
  })

  it('行级 onDoubleClick 透传', () => {
    const onDoubleClick = vi.fn()
    render(<TreeRow label="x" depth={0} ariaLabel="x-dbl" onDoubleClick={onDoubleClick} />)
    fireEvent.dblClick(screen.getByRole('treeitem', {name: 'x-dbl'}))
    expect(onDoubleClick).toHaveBeenCalledTimes(1)
  })
})

describe('TreeRow onClick 透传 MouseEvent（多选修饰键依赖）', () => {
  it('onClick 收到原生 MouseEvent（含 ctrlKey/shiftKey）', () => {
    const onClick = vi.fn()
    render(<TreeRow label="x" depth={0} onClick={onClick} />)
    fireEvent.click(screen.getByRole('treeitem', {name: 'x'}), {ctrlKey: true})
    expect(onClick).toHaveBeenCalledWith(expect.objectContaining({type: 'click', ctrlKey: true}))
  })

  it('onClick 类型允许消费 MouseEvent 的回调（修饰键可被读取）', () => {
    const seen: {ctrlKey: boolean; shiftKey: boolean}[] = []
    const onClick = (e: {ctrlKey: boolean; shiftKey: boolean}) => { seen.push(e) }
    render(<TreeRow label="y" depth={0} onClick={onClick} />)
    fireEvent.click(screen.getByRole('treeitem', {name: 'y'}), {shiftKey: true})
    expect(seen[0].shiftKey).toBe(true)
  })
})
