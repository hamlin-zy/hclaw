// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {render, screen, fireEvent} from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import {GitStatusPanel} from '../../../src/renderer/project-manager/components/GitStatusPanel'
import {SendToConversationProvider} from '../../../src/renderer/project-manager/ui/SendToConversationProvider'
import {useGitStatusStore} from '../../../src/renderer/project-manager/stores/gitStatusStore'
import {useFileTreeStore} from '../../../src/renderer/project-manager/stores/fileTreeStore'

const summary = {
  statusMap: {
    'src/a.ts': {path: 'src/a.ts', status: 'M' as const, indexStatus: ' ', worktreeStatus: 'M'},
    'src/b.ts': {path: 'src/b.ts', status: 'M' as const, indexStatus: ' ', worktreeStatus: 'M'},
  },
  additions: 1, deletions: 1, updatedAt: 1,
}

beforeEach(() => {
  useGitStatusStore.setState({summary: summary as never})
  useFileTreeStore.setState({selectedPath: null, selectedPaths: new Set(), anchorPath: null})
  ;(window as any).electronAPI = {
    projectManager: {workspacePath: '/ws'},
    conversationListByWorkspace: vi.fn(async () => []),
  }
})

const renderPanel = () =>
  render(<SendToConversationProvider><GitStatusPanel workspace="/ws" /></SendToConversationProvider>)

describe('GitStatusPanel 发送到会话', () => {
  it('单击选中文件行（高亮）', () => {
    renderPanel()
    const row = screen.getByRole('treeitem', {name: 'src/a.ts'})
    fireEvent.click(row)
    expect(row).toHaveAttribute('aria-selected', 'true')
  })

  it('Ctrl 多选后右键集合内行，发送全部选中文件', async () => {
    renderPanel()
    const a = screen.getByRole('treeitem', {name: 'src/a.ts'})
    const b = screen.getByRole('treeitem', {name: 'src/b.ts'})
    fireEvent.click(a)
    fireEvent.click(b, {ctrlKey: true})
    fireEvent.contextMenu(b)
    fireEvent.click(screen.getByRole('menuitem', {name: '发送到会话'}))
    const preview = await screen.findByTestId('pm-send-dialog-preview')
    expect(preview).toHaveTextContent('/ws/src/a.ts')
    expect(preview).toHaveTextContent('/ws/src/b.ts')
  })

  it('右键集合外的行 → 替换为仅该行后发送', async () => {
    renderPanel()
    const a = screen.getByRole('treeitem', {name: 'src/a.ts'})
    const b = screen.getByRole('treeitem', {name: 'src/b.ts'})
    fireEvent.click(a)
    fireEvent.click(b, {ctrlKey: true})
    // 先取消 a 的选中，使 a 成为「集合外」的落点
    fireEvent.click(a, {ctrlKey: true})
    fireEvent.contextMenu(a)
    fireEvent.click(screen.getByRole('menuitem', {name: '发送到会话'}))
    const preview = await screen.findByTestId('pm-send-dialog-preview')
    expect(preview).toHaveTextContent('/ws/src/a.ts')
  })
})
