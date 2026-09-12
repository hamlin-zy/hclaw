// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {render, screen, fireEvent} from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import {GitCommitDetail} from '../../../src/renderer/project-manager/components/GitCommitDetail'
import {SendToConversationProvider} from '../../../src/renderer/project-manager/ui/SendToConversationProvider'
import {useGitLogStore} from '../../../src/renderer/project-manager/stores/gitLogStore'
import {useWorkspaceStore} from '../../../src/renderer/project-manager/stores/workspaceStore'

const HASH = 'a'.repeat(40)

beforeEach(() => {
  useWorkspaceStore.setState({workspacePath: '/ws'})
  useGitLogStore.setState({
    selectedHash: HASH,
    entries: [{hash: HASH, abbreviatedHash: 'a1b2c3d4e', message: 'feat: 标题', body: '', parents: [], author: 'x', authorEmail: '', authorDate: 1, date: 1, branches: [], tags: [], isHead: false}] as never,
  })
  ;(window as any).electronAPI = {
    projectManager: {
      workspacePath: '/ws',
      gitShowCommit: vi.fn(async () => ({
        hash: HASH, message: 'feat: 标题',
        files: [
          {path: 'src/main/a.ts', status: 'M', additions: 2, deletions: 1},
          {path: 'src/main/b.ts', status: 'A', additions: 5, deletions: 0},
        ],
      })),
      gitDiffFile: vi.fn(async () => null),
      gitShowDetail: vi.fn(async () => ''),
    },
    conversationListByWorkspace: vi.fn(async () => []),
  }
})

const renderDetail = () =>
  render(<SendToConversationProvider><GitCommitDetail workspace="/ws" /></SendToConversationProvider>)

describe('GitCommitDetail 发送到会话', () => {
  it('单击文件行选中', async () => {
    renderDetail()
    const row = await screen.findByRole('treeitem', {name: 'src/main/b.ts'})
    fireEvent.click(row)
    expect(row).toHaveAttribute('aria-selected', 'true')
  })

  it('右键文件行 → 发送该文件的绝对路径', async () => {
    renderDetail()
    fireEvent.contextMenu(await screen.findByRole('treeitem', {name: 'src/main/b.ts'}))
    fireEvent.click(screen.getByRole('menuitem', {name: '发送到会话'}))
    expect(await screen.findByTestId('pm-send-dialog-preview')).toHaveTextContent('/ws/src/main/b.ts')
  })

  it('Ctrl 多选后发送多个文件的绝对路径', async () => {
    renderDetail()
    const a = await screen.findByRole('treeitem', {name: 'src/main/a.ts'})
    const b = screen.getByRole('treeitem', {name: 'src/main/b.ts'})
    fireEvent.click(b)
    fireEvent.click(a, {ctrlKey: true})
    fireEvent.contextMenu(a)
    fireEvent.click(screen.getByRole('menuitem', {name: '发送到会话'}))
    const preview = await screen.findByTestId('pm-send-dialog-preview')
    expect(preview).toHaveTextContent('/ws/src/main/a.ts')
    expect(preview).toHaveTextContent('/ws/src/main/b.ts')
  })
})
