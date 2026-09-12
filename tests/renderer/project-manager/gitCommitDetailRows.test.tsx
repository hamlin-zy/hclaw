// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {render, screen} from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import {GitCommitDetail} from '../../../src/renderer/project-manager/components/GitCommitDetail'
import {useGitLogStore} from '../../../src/renderer/project-manager/stores/gitLogStore'

beforeEach(() => {
  ;(window as any).electronAPI = {
    projectManager: {
      gitShowCommit: vi.fn(async () => ({
        hash: 'a'.repeat(40),
        message: 'feat: 标题',
        files: [
          {path: 'src/main/a.ts', status: 'M', additions: 2, deletions: 1},
          {path: 'src/main/b.ts', status: 'A', additions: 5, deletions: 0},
        ],
      })),
      gitDiffFile: vi.fn(async () => null),
      gitShowDetail: vi.fn(async () => ''),
    },
  }
})

const entry = (over: Record<string, unknown> = {}) => ({
  hash: 'a'.repeat(40), abbreviatedHash: 'a1b2c3d4e', message: 'feat: 标题', body: '',
  parents: [], author: 'x', authorEmail: '', authorDate: 1, date: 1, branches: [], tags: [], isHead: false,
  ...over,
})

describe('GitCommitDetail 行结构（spec §10）', () => {
  it('文件行用 TreeRow，行内只显示文件名，路径走 tooltip', async () => {
    useGitLogStore.setState({selectedHash: 'a'.repeat(40), entries: [entry()]} as never)
    render(<GitCommitDetail workspace="/ws" />)
    const row = await screen.findByRole('treeitem', {name: 'src/main/a.ts'})
    expect(row).toHaveTextContent('a.ts')
    expect(row).not.toHaveTextContent('src/main/a.ts')
    expect(row).toHaveAttribute('title', expect.stringContaining('src/main/a.ts'))
  })

  it('文件行带状态字母列', async () => {
    useGitLogStore.setState({selectedHash: 'a'.repeat(40), entries: [entry({message: 'm'})]} as never)
    render(<GitCommitDetail workspace="/ws" />)
    const row = await screen.findByRole('treeitem', {name: 'src/main/a.ts'})
    expect(row.querySelector('[data-testid="status-badge"]')).toHaveTextContent('M')
  })

  it('缩进：聚合目录 13px，文件行 26px', async () => {
    useGitLogStore.setState({selectedHash: 'a'.repeat(40), entries: [entry({message: 'm'})]} as never)
    render(<GitCommitDetail workspace="/ws" />)
    await screen.findByRole('treeitem', {name: 'src/main/a.ts'})
    // R-1：TreeRow 渲染 <button role="treeitem">，显式 role 覆盖 button 隐式角色，必须按 treeitem 查询
    expect(screen.getByRole('treeitem', {name: 'src/main'})).toHaveStyle({paddingLeft: '13px'})
    expect(screen.getByRole('treeitem', {name: 'src/main/a.ts'})).toHaveStyle({paddingLeft: '26px'})
  })

  it('未选中 commit 时显示空态（面板头部仍在）', () => {
    useGitLogStore.setState({selectedHash: null, entries: []} as never)
    const {container} = render(<GitCommitDetail workspace="/ws" />)
    expect(screen.getByText('选中一个 commit 查看变更详情')).toBeInTheDocument()
    // Important 1：空态同样保留 PanelHeader（Produces 契约 pm-detail-header），兄弟面板均只换 body
    expect(container.querySelector('[data-testid="pm-detail-header"]')).not.toBeNull()
  })

  it('顶部改动摘要保留', async () => {
    useGitLogStore.setState({selectedHash: 'a'.repeat(40), entries: [entry({message: 'm'})]} as never)
    render(<GitCommitDetail workspace="/ws" />)
    expect(await screen.findByText(/2 files changed/)).toBeInTheDocument()
  })

  it('底部 message/body 区保留：body 走 .pm-detail-body（pre-wrap 由样式承担）', async () => {
    useGitLogStore.setState({selectedHash: 'a'.repeat(40), entries: [entry({body: '第一行\n第二行'})]} as never)
    const {container} = render(<GitCommitDetail workspace="/ws" />)
    await screen.findByText(/2 files changed/)
    const body = container.querySelector('.pm-detail-body')
    expect(body).not.toBeNull()
    expect(body).toHaveTextContent('第一行')
    expect(body).toHaveTextContent('第二行')
  })
})
