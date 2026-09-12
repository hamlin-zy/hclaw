// tests/renderer/project-manager/SessionPicker.test.tsx
// @vitest-environment jsdom
import {describe, expect, it, vi} from 'vitest'
import {fireEvent, render, screen} from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import {SessionPicker} from '../../../src/renderer/project-manager/components/SessionPicker'
import type {ConversationMeta} from '../../../src/shared/types/infra'

function conv(id: string, title: string, updatedAt = 0): ConversationMeta {
  return {id, title, workspacePath: '/ws', createdAt: 0, updatedAt, preview: '', status: 'active'}
}

const ITEMS = [conv('c1', '重构登录流程', 200), conv('c2', '修复构建脚本', 100)]

describe('SessionPicker', () => {
  it('渲染全部候选并高亮 value', () => {
    render(<SessionPicker items={ITEMS} value="c2" onChange={() => {}} />)
    expect(screen.getAllByRole('option')).toHaveLength(2)
    expect(screen.getByRole('option', {name: '修复构建脚本'})).toHaveAttribute('aria-selected', 'true')
  })

  it('点击某项触发 onChange', () => {
    const onChange = vi.fn()
    render(<SessionPicker items={ITEMS} value={null} onChange={onChange} />)
    fireEvent.click(screen.getByRole('option', {name: '重构登录流程'}))
    expect(onChange).toHaveBeenCalledWith('c1')
  })

  it('搜索过滤候选', () => {
    render(<SessionPicker items={ITEMS} value={null} onChange={() => {}} />)
    fireEvent.change(screen.getByTestId('pm-session-picker-input'), {target: {value: '构建'}})
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByRole('option', {name: '修复构建脚本'})).toBeInTheDocument()
  })

  it('↑/↓ 移动高亮，Enter 选中高亮项', () => {
    const onChange = vi.fn()
    render(<SessionPicker items={ITEMS} value={null} onChange={onChange} />)
    const input = screen.getByTestId('pm-session-picker-input')
    fireEvent.keyDown(input, {key: 'ArrowDown'})
    fireEvent.keyDown(input, {key: 'Enter'})
    expect(onChange).toHaveBeenCalledWith('c2')
  })

  it('空列表显示空提示', () => {
    render(<SessionPicker items={[]} value={null} onChange={() => {}} />)
    expect(screen.getByTestId('pm-session-picker-empty')).toBeInTheDocument()
    expect(screen.queryAllByRole('option')).toHaveLength(0)
  })
})
