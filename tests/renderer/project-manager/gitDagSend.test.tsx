// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {render, screen, fireEvent} from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import {GitDagGraph} from '../../../src/renderer/project-manager/components/GitDagGraph'
import {SendToConversationProvider} from '../../../src/renderer/project-manager/ui/SendToConversationProvider'
import {useGitLogStore} from '../../../src/renderer/project-manager/stores/gitLogStore'
import {useWorkspaceStore} from '../../../src/renderer/project-manager/stores/workspaceStore'

const mk = (i: number) => ({
  hash: `hash${i}`, abbreviatedHash: `hash${i}`.slice(0, 9), parents: [], message: `commit ${i}`, body: '',
  author: 'a', authorEmail: 'a@a', authorDate: i, date: i, branches: [], tags: [], isHead: i === 0,
})

beforeEach(() => {
  useWorkspaceStore.setState({workspacePath: '/ws'})
  useGitLogStore.setState({
    entries: [mk(0), mk(1)], selectedHash: null, selectedHashes: new Set(), anchorHash: null,
    hasMore: false, loading: false, selectedBranch: null, lastOptions: null,
  })
  ;(window as any).electronAPI = {
    projectManager: {workspacePath: '/ws'},
    conversationListByWorkspace: vi.fn(async () => []),
  }
})

const renderGraph = () =>
  render(<SendToConversationProvider><GitDagGraph /></SendToConversationProvider>)

describe('GitDagGraph 发送到会话', () => {
  it('单击选中行，aria-selected 生效', () => {
    renderGraph()
    const row = screen.getAllByTestId('pm-commit-row')[0]
    fireEvent.click(row)
    expect(row).toHaveAttribute('aria-selected', 'true')
  })

  it('右键行 → 菜单含「发送到会话」，发送该 commit（固定前缀 commit：）', async () => {
    renderGraph()
    fireEvent.contextMenu(screen.getAllByTestId('pm-commit-row')[0])
    fireEvent.click(screen.getByRole('menuitem', {name: '发送到会话'}))
    expect(await screen.findByTestId('pm-send-dialog-preview')).toHaveTextContent('commit：hash0')
  })

  it('Ctrl 多选后右键集合内行 → 发送逗号分隔的多个 hash', async () => {
    renderGraph()
    const rows = screen.getAllByTestId('pm-commit-row')
    fireEvent.click(rows[1])                    // 先点靠后的 hash1
    fireEvent.click(rows[0], {ctrlKey: true})   // 再点靠前的 hash0 → 插入序 [hash1,hash0]
    fireEvent.contextMenu(rows[0])
    fireEvent.click(screen.getByRole('menuitem', {name: '发送到会话'}))
    const preview = await screen.findByTestId('pm-send-dialog-preview')
    // F1：按显示顺序（displayOrder = hash0,hash1），而非 Set 插入序
    expect(preview.textContent).toBe('commit：hash0,hash1')
  })

  it('右键集合外的行 → 替换为仅该行后发送', async () => {
    renderGraph()
    const rows = screen.getAllByTestId('pm-commit-row')
    fireEvent.click(rows[0])
    fireEvent.click(rows[1], {ctrlKey: true})
    fireEvent.click(rows[0], {ctrlKey: true})   // 取消 rows[0]，使其成为集合外落点
    fireEvent.contextMenu(rows[0])
    fireEvent.click(screen.getByRole('menuitem', {name: '发送到会话'}))
    expect(await screen.findByTestId('pm-send-dialog-preview')).toHaveTextContent('commit：hash0')
  })

  // 回归（displayOrder 不变式）：GitDagGraph 的 Shift 区间选必须基于「显示顺序」displayOrder，
  // 而非 store 原序 rawEntries。sortAsc 时展示顺序被倒序（新→旧 → 旧→新）。
  // 若把 GitDagGraph.tsx 的 displayOrder 误写成 rawEntries.map(...)，本用例会失败：
  //   显示第 1 行 = hash2（anchor），Shift 到显示第 3 行 = hash0
  //   正确 displayOrder = [hash2,hash1,hash0] → 预览 "commit：hash2,hash1,hash0"
  //   错误 rawEntries  = [hash0,hash1,hash2] → order.slice(0,3) 反过来 → "commit：hash0,hash1,hash2"
  // 断言用「预览中 hash 的先后顺序」，故对顺序敏感；仅断言 count/全选会漏掉该回归。
  it('sortAsc 下 Shift 区间选按显示顺序（守卫 displayOrder 不变式）', async () => {
    useGitLogStore.setState({
      entries: [mk(0), mk(1), mk(2)], selectedHash: null, selectedHashes: new Set(), anchorHash: null,
    })
    render(<SendToConversationProvider><GitDagGraph sortAsc /></SendToConversationProvider>)
    const rows = screen.getAllByTestId('pm-commit-row')
    // 先自证展示顺序确为倒序（store 新→旧 → 显示 hash2,hash1,hash0）
    expect(rows.map(r => (r.getAttribute('aria-label') ?? '').split(' ')[0]))
      .toEqual(['hash2', 'hash1', 'hash0'])
    fireEvent.click(rows[0])                      // 锚点 = 显示位第 1 行（hash2）
    fireEvent.click(rows[2], {shiftKey: true})    // Shift 到显示位第 3 行（hash0）
    fireEvent.contextMenu(rows[1])                // 集合内行 → 发送整个选区
    fireEvent.click(screen.getByRole('menuitem', {name: '发送到会话'}))
    const preview = await screen.findByTestId('pm-send-dialog-preview')
    expect(preview).toHaveTextContent('commit：hash2,hash1,hash0')
  })
})
