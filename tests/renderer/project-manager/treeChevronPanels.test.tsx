// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {render, screen, fireEvent} from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import {GitStatusPanel} from '../../../src/renderer/project-manager/components/GitStatusPanel'
import {GitCommitDetail} from '../../../src/renderer/project-manager/components/GitCommitDetail'
import {GitBranchTree} from '../../../src/renderer/project-manager/components/GitBranchTree'
import {PanelHeader} from '../../../src/renderer/project-manager/ui/PanelHeader'
import {useGitStatusStore} from '../../../src/renderer/project-manager/stores/gitStatusStore'
import {useGitLogStore} from '../../../src/renderer/project-manager/stores/gitLogStore'
import {useWorkspaceStore} from '../../../src/renderer/project-manager/stores/workspaceStore'
import {useEditorTabStore} from '../../../src/renderer/project-manager/stores/editorTabStore'

/** 复刻浏览器真实双击序列（spec §7.2：fireEvent.doubleClick 会假绿通过） */
function doubleClickWithClicks(el: Element, row: Element) {
  fireEvent.click(el, {detail: 1, bubbles: true})
  fireEvent.click(el, {detail: 2, bubbles: true})
  fireEvent.dblClick(row, {bubbles: true})
}

const chevronOf = (row: Element) => row.querySelector('[role="button"]')!

/** 手势后展开态必须与手势前不同（未加守卫时净 0 → 不变） */
function expectNetOneToggle(name: string) {
  const before = screen.getByRole('treeitem', {name}).getAttribute('aria-expanded')
  const row = screen.getByRole('treeitem', {name})
  doubleClickWithClicks(chevronOf(row), row)
  expect(screen.getByRole('treeitem', {name}).getAttribute('aria-expanded')).not.toBe(before)
}

beforeEach(() => {
  useWorkspaceStore.setState({workspacePath: '/ws'})
  useEditorTabStore.setState({tabs: [], activeTabId: null})
  useGitStatusStore.setState({summary: {statusMap: {
    'src/a.ts': {path: 'src/a.ts', status: 'M', indexStatus: ' ', worktreeStatus: 'M'},
  }, additions: 0, deletions: 0, updatedAt: 1} as never})
  useGitLogStore.setState({selectedHash: 'abc123', loading: false, lastOptions: null, entries: [{
    hash: 'abc123', abbreviatedHash: 'abc123', parents: [], message: 'm', body: '',
    author: '', authorEmail: '', authorDate: 0, date: 0, branches: [], tags: [], isHead: false,
  } as never]})
  ;(window as any).electronAPI = {projectManager: {
    gitShowCommit: vi.fn(async () => ({hash: 'abc123', message: 'm', files: [{path: 'src/a.ts', status: 'M', additions: 0, deletions: 0}]})),
    gitBranches: vi.fn(async () => [{name: 'main', hash: 'h', type: 'local', isCurrent: true, isRemote: false}]),
    gitLog: vi.fn(async () => []),
  }}
})

describe('双击箭头 = 净一次切换（跨面板，spec §3.2）', () => {
  it('GitStatusPanel 目录分组行', () => {
    render(<GitStatusPanel workspace="/ws" />)
    expectNetOneToggle('src')
  })

  it('GitCommitDetail 目录行', async () => {
    render(<GitCommitDetail workspace="/ws" />)
    await screen.findByRole('treeitem', {name: 'src'})
    expectNetOneToggle('src')
  })

  it('GitBranchTree 分组行（Local）', async () => {
    render(<GitBranchTree />)
    await screen.findByRole('treeitem', {name: '本地分支'})
    expectNetOneToggle('本地分支')
  })

  it('PanelHeader（Git 区标题条）', () => {
    const onToggle = vi.fn()
    render(<PanelHeader title="Git" expanded onToggle={onToggle} />)
    const main = document.querySelector('.pm-panel-header-main')!
    doubleClickWithClicks(chevronOf(main), main)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })
})
