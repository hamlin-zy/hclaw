// tests/renderer/project-manager/uiControls.test.tsx
// @vitest-environment jsdom
import {describe, it, expect, vi} from 'vitest'
import {render, screen, fireEvent} from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import {SearchInput} from '../../../src/renderer/project-manager/ui/SearchInput'
import {ToggleChip} from '../../../src/renderer/project-manager/ui/ToggleChip'
import {IconButton} from '../../../src/renderer/project-manager/ui/IconButton'
import {ContextMenu} from '../../../src/renderer/project-manager/ui/ContextMenu'
import {Eye, Search} from 'lucide-react'

describe('SearchInput §8.1 / §9.2', () => {
  it('输入触发 onChange', () => {
    const onChange = vi.fn()
    render(<SearchInput value="" onChange={onChange} placeholder="Branch or tag" ariaLabel="搜索分支" />)
    fireEvent.change(screen.getByPlaceholderText('Branch or tag'), {target: {value: 'feat'}})
    expect(onChange).toHaveBeenCalledWith('feat')
  })

  it('不传 onSubmit 时不渲染提交按钮，Enter 也不触发任何事', () => {
    const onChange = vi.fn()
    render(<SearchInput value="" onChange={onChange} placeholder="Branch or tag" ariaLabel="搜索分支" />)
    expect(screen.queryByRole('button', {name: '搜索'})).toBeNull()
    fireEvent.keyDown(screen.getByPlaceholderText('Branch or tag'), {key: 'Enter'})
    // 无 onSubmit 的 Enter 不得产生任何回调——onChange 是唯一可被触发的回调
    expect(onChange).not.toHaveBeenCalled()
  })

  it('有值时出现清除按钮，点击回调空串', () => {
    const onChange = vi.fn()
    render(<SearchInput value="feat" onChange={onChange} placeholder="p" ariaLabel="a" />)
    fireEvent.click(screen.getByRole('button', {name: '清除'}))
    expect(onChange).toHaveBeenCalledWith('')
  })

  it('无值时没有清除按钮', () => {
    render(<SearchInput value="" onChange={vi.fn()} placeholder="p" ariaLabel="a" />)
    expect(screen.queryByRole('button', {name: '清除'})).toBeNull()
  })

  it('Enter 触发显式提交（不做输入即过滤，spec §9.2）', () => {
    const onSubmit = vi.fn()
    render(<SearchInput value="abc" onChange={vi.fn()} placeholder="Text or hash" ariaLabel="搜索提交" onSubmit={onSubmit} />)
    fireEvent.keyDown(screen.getByPlaceholderText('Text or hash'), {key: 'Enter'})
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('submitLabel 决定提交按钮的可访问名（GitLogPanel 传"查找"以保持既有测试可用）', () => {
    render(<SearchInput value="" onChange={vi.fn()} placeholder="Text or hash" ariaLabel="a" onSubmit={vi.fn()} submitLabel="查找" />)
    expect(screen.getByRole('button', {name: '查找'})).toBeInTheDocument()
  })

  it('不写内联样式', () => {
    render(<SearchInput value="x" onChange={vi.fn()} placeholder="p" ariaLabel="a" onSubmit={vi.fn()} />)
    expect(screen.getByPlaceholderText('p').getAttribute('style')).toBeNull()
  })
})

describe('ToggleChip', () => {
  it('激活态加 is-active 类并暴露 aria-pressed', () => {
    const onToggle = vi.fn()
    render(<ToggleChip label=".*" active onToggle={onToggle} />)
    const chip = screen.getByRole('button', {name: '.*'})
    expect(chip).toHaveClass('is-active')
    expect(chip).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(chip)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('未激活时不带 is-active', () => {
    render(<ToggleChip label="Cc" active={false} onToggle={vi.fn()} />)
    const chip = screen.getByRole('button', {name: 'Cc'})
    expect(chip).not.toHaveClass('is-active')
    expect(chip).toHaveAttribute('aria-pressed', 'false')
  })
})

describe('IconButton', () => {
  it('label 同时作为 aria-label 与 title', () => {
    render(<IconButton icon={Eye} label="显示被忽略文件" />)
    const btn = screen.getByRole('button', {name: '显示被忽略文件'})
    expect(btn).toHaveAttribute('title', '显示被忽略文件')
  })

  it('pressed 传入时渲染切换态', () => {
    render(<IconButton icon={Eye} label="显示被忽略文件" pressed />)
    const btn = screen.getByRole('button', {name: '显示被忽略文件'})
    expect(btn).toHaveAttribute('aria-pressed', 'true')
    expect(btn).toHaveClass('is-active')
  })

  it('不传 pressed 时不渲染 aria-pressed（纯动作按钮）', () => {
    render(<IconButton icon={Search} label="刷新" />)
    expect(screen.getByRole('button', {name: '刷新'})).not.toHaveAttribute('aria-pressed')
  })

  it('disabled 时不可点击', () => {
    const onClick = vi.fn()
    render(<IconButton icon={Search} label="刷新" onClick={onClick} disabled />)
    fireEvent.click(screen.getByRole('button', {name: '刷新'}))
    expect(onClick).not.toHaveBeenCalled()
  })

  it('图标是装饰性的', () => {
    render(<IconButton icon={Search} label="刷新" />)
    expect(screen.getByRole('button', {name: '刷新'}).querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })
})

describe('ContextMenu §13.6', () => {
  function open(items = [
    {label: 'Checkout', disabled: true, reason: '窗口只读'},
    {label: 'Copy name', onClick: vi.fn()},
    {label: 'Copy hash', onClick: vi.fn()},
  ]) {
    const onClose = vi.fn()
    render(<ContextMenu x={10} y={20} items={items} onClose={onClose} />)
    return {onClose, items}
  }

  it('渲染 role=menu 与 role=menuitem 列表', () => {
    open()
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(screen.getAllByRole('menuitem')).toHaveLength(3)
  })

  it('定位走内联 style（唯一的动态计算值）', () => {
    open()
    expect(screen.getByRole('menu').style.left).toBe('10px')
    expect(screen.getByRole('menu').style.top).toBe('20px')
  })

  it('点击可用项触发回调并关闭', () => {
    const {onClose, items} = open()
    fireEvent.click(screen.getByRole('menuitem', {name: 'Copy name'}))
    expect((items[1] as {onClick: ReturnType<typeof vi.fn>}).onClick).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('disabled 项不可点击、带原因提示、不触发回调', () => {
    const {onClose} = open()
    const item = screen.getByRole('menuitem', {name: 'Checkout'})
    expect(item).toBeDisabled()
    expect(item).toHaveAttribute('title', '窗口只读')
    fireEvent.click(item)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('Esc 关闭', () => {
    const {onClose} = open()
    fireEvent.keyDown(document, {key: 'Escape'})
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('方向键在可用项之间移动焦点（跳过 disabled）', () => {
    open()
    const copyName = screen.getByRole('menuitem', {name: 'Copy name'})
    copyName.focus()
    fireEvent.keyDown(screen.getByRole('menu'), {key: 'ArrowDown'})
    expect(document.activeElement).toBe(screen.getByRole('menuitem', {name: 'Copy hash'}))
    fireEvent.keyDown(screen.getByRole('menu'), {key: 'ArrowDown'})
    expect(document.activeElement).toBe(copyName)   // 环绕回第一个可用项
  })
})
