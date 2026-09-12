// @vitest-environment jsdom
import {describe, it, expect, vi} from 'vitest'
import {render, screen, fireEvent} from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import {PanelCard} from '../../../src/renderer/project-manager/ui/PanelCard'
import {PanelHeader} from '../../../src/renderer/project-manager/ui/PanelHeader'
import {PanelToolbar} from '../../../src/renderer/project-manager/ui/PanelToolbar'
import {EmptyState} from '../../../src/renderer/project-manager/ui/EmptyState'
import {FileText} from 'lucide-react'

describe('PanelCard §2.3 圆角卡片', () => {
  it('渲染子内容并带 pm-panel-card 类', () => {
    render(<PanelCard testId="card">内容</PanelCard>)
    const card = screen.getByTestId('card')
    expect(card).toHaveClass('pm-panel-card')
    expect(card).toHaveTextContent('内容')
  })

  it('不写内联样式', () => {
    render(<PanelCard testId="card">内容</PanelCard>)
    expect(screen.getByTestId('card').getAttribute('style')).toBeNull()
  })
})

describe('PanelHeader', () => {
  it('渲染标题与计数', () => {
    render(<PanelHeader title="文件树" count={52} testId="h" />)
    expect(screen.getByTestId('h')).toHaveTextContent('文件树')
    expect(screen.getByTestId('h')).toHaveTextContent('52')
  })

  it('可折叠时是 role=button 且带 aria-expanded，点击触发 onToggle', () => {
    const onToggle = vi.fn()
    render(<PanelHeader title="Git" expanded={false} onToggle={onToggle} testId="h" />)
    const btn = screen.getByRole('button', {name: /Git/})
    expect(btn).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(btn)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('点 chevron 也只触发一次 onToggle（不冒泡成两次）', () => {
    const onToggle = vi.fn()
    render(<PanelHeader title="Git" expanded onToggle={onToggle} testId="h" />)
    const chevron = screen.getByRole('button', {name: '折叠'})
    fireEvent.click(chevron)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('不可折叠时不渲染 role=button', () => {
    render(<PanelHeader title="文件树" testId="h" />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('actions 渲染在右侧', () => {
    render(<PanelHeader title="文件树" actions={<span>动作区</span>} testId="h" />)
    expect(screen.getByText('动作区')).toBeInTheDocument()
  })
})

describe('PanelToolbar', () => {
  it('渲染子内容并带 pm-panel-toolbar 类', () => {
    render(<PanelToolbar testId="t"><span>a</span><span>b</span></PanelToolbar>)
    const bar = screen.getByTestId('t')
    expect(bar).toHaveClass('pm-panel-toolbar')
    expect(bar).toHaveTextContent('ab')
  })
})

describe('EmptyState §13.5', () => {
  it('渲染文案', () => {
    render(<EmptyState text="Working tree clean" testId="e" />)
    expect(screen.getByTestId('e')).toHaveTextContent('Working tree clean')
  })

  it('可选图标标记为装饰性（aria-hidden）', () => {
    render(<EmptyState text="空" icon={FileText} testId="e" />)
    const svg = screen.getByTestId('e').querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg).toHaveAttribute('aria-hidden', 'true')
  })
})


// className 拼接矩阵：锁定「条件拼接」行为的精确输出（无多余空格、无 "undefined"）。
const classMatrix: Array<[string, string | undefined, string]> = [
  ['undefined', undefined, 'pm-panel-card'],
  ['空字符串', '', 'pm-panel-card'],
  ['单个自定义类', 'custom', 'pm-panel-card custom'],
  ['多个自定义类', 'a b', 'pm-panel-card a b'],
]

describe('PanelCard className 拼接矩阵', () => {
  it.each(classMatrix)('className=%s → 精确类名', (_label, className, expected) => {
    render(<PanelCard className={className} testId="card">{null}</PanelCard>)
    expect(screen.getByTestId('card').getAttribute('class')).toBe(expected)
  })
})

const toolbarClassMatrix: Array<[string, string | undefined, string]> = [
  ['undefined', undefined, 'pm-panel-toolbar'],
  ['空字符串', '', 'pm-panel-toolbar'],
  ['单个自定义类', 'custom', 'pm-panel-toolbar custom'],
  ['多个自定义类', 'a b', 'pm-panel-toolbar a b'],
]

describe('PanelToolbar className 拼接矩阵', () => {
  it.each(toolbarClassMatrix)('className=%s → 精确类名', (_label, className, expected) => {
    render(<PanelToolbar className={className} testId="t">{null}</PanelToolbar>)
    expect(screen.getByTestId('t').getAttribute('class')).toBe(expected)
  })
})
