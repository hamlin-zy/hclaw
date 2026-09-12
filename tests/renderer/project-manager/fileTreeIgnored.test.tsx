// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {render, screen, fireEvent, waitFor} from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import {FileTree} from '../../../src/renderer/project-manager/components/FileTree'
import {useFileTreeStore} from '../../../src/renderer/project-manager/stores/fileTreeStore'
import {useWorkspaceStore} from '../../../src/renderer/project-manager/stores/workspaceStore'
import {useEditorTabStore} from '../../../src/renderer/project-manager/stores/editorTabStore'
import {useGitStatusStore} from '../../../src/renderer/project-manager/stores/gitStatusStore'

const listDir = vi.fn()
const readFile = vi.fn()

const entry = (name: string, path: string, isDir: boolean, extra: Partial<{gitStatus: 'none' | 'M' | 'A' | 'D' | 'R' | '??', ignored: boolean, hasChildren: boolean}> = {}) => ({
  name, path, isDir, size: 1, gitStatus: 'none' as const, hasChildren: isDir, ignored: false, ...extra,
})

beforeEach(() => {
  listDir.mockReset(); readFile.mockReset()
  ;(window as any).electronAPI = {projectManager: {listDirectory: listDir, readFile}}
  useWorkspaceStore.setState({workspacePath: '/ws'})
  useFileTreeStore.setState({expanded: new Set(), childrenCache: {}, cacheOrder: [], selectedPath: null})
  useEditorTabStore.setState({tabs: [], activeTabId: null})
  useGitStatusStore.setState({summary: null})
})

const ROOT = [
  entry('src', 'src', true, {hasChildren: true}),
  entry('dist', 'dist', true, {ignored: true, hasChildren: true}),
  entry('.gitignore', '.gitignore', false),
  entry('build.log', 'build.log', false, {ignored: true}),
  entry('a.ts', 'a.ts', false, {gitStatus: 'M'}),
]

describe('FileTree 忽略开关（spec §6.3 方案 A）', () => {
  it('默认显示被忽略条目', async () => {
    listDir.mockResolvedValue(ROOT)
    render(<FileTree />)
    expect(await screen.findByRole('treeitem', {name: 'dist'})).toBeInTheDocument()
    expect(screen.getByRole('treeitem', {name: 'build.log'})).toBeInTheDocument()
  })

  it('点击开关后被忽略条目从 DOM 消失，点文件不受影响', async () => {
    listDir.mockResolvedValue(ROOT)
    render(<FileTree />)
    await screen.findByRole('treeitem', {name: 'dist'})
    fireEvent.click(screen.getByRole('button', {name: '隐藏被忽略文件'}))
    expect(screen.queryByRole('treeitem', {name: 'dist'})).toBeNull()
    expect(screen.queryByRole('treeitem', {name: 'build.log'})).toBeNull()
    // 隐藏文件（点文件）始终显示
    expect(screen.getByRole('treeitem', {name: '.gitignore'})).toBeInTheDocument()
    expect(screen.getByRole('treeitem', {name: 'a.ts'})).toBeInTheDocument()
  })

  it('再点一次恢复显示', async () => {
    listDir.mockResolvedValue(ROOT)
    render(<FileTree />)
    await screen.findByRole('treeitem', {name: 'dist'})
    fireEvent.click(screen.getByRole('button', {name: '隐藏被忽略文件'}))
    fireEvent.click(screen.getByRole('button', {name: '显示被忽略文件'}))
    expect(screen.getByRole('treeitem', {name: 'dist'})).toBeInTheDocument()
  })

  it('被忽略条目不渲染状态字母列（spec §6.3）', async () => {
    listDir.mockResolvedValue([entry('dist', 'dist', true, {ignored: true, gitStatus: 'M', hasChildren: true})])
    render(<FileTree />)
    const row = await screen.findByRole('treeitem', {name: 'dist'})
    expect(row.querySelector('[data-testid="status-badge"]')).toBeNull()
  })
})

describe('FileTree 三重编码（spec §6.2）', () => {
  it('文件名按状态着色并带状态字母', async () => {
    listDir.mockResolvedValue([entry('a.ts', 'a.ts', false, {gitStatus: 'M'})])
    render(<FileTree />)
    const row = await screen.findByRole('treeitem', {name: 'a.ts'})
    expect(screen.getByText('a.ts')).toHaveClass('pm-c--M')
    expect(row.querySelector('[data-testid="status-badge"]')).toHaveTextContent('M')
  })

  it('目录按子项最高优先级染色（D > M > R > A > ??），且折叠时就已染色', async () => {
    // 状态取自 workspace 全量 statusMap（而非已加载子项）——
    // 目录保持折叠、childrenCache 为空，仍应染色（spec §6.2「不展开就知道哪里脏」）
    useGitStatusStore.setState({
      summary: {
        statusMap: {
          'src/x.ts': {path: 'src/x.ts', status: '??', indexStatus: '?', worktreeStatus: '?'},
          'src/y.ts': {path: 'src/y.ts', status: 'M', indexStatus: ' ', worktreeStatus: 'M'},
        },
        additions: 0,
        deletions: 0,
        updatedAt: 1,
      },
    })
    listDir.mockResolvedValue([entry('src', 'src', true, {hasChildren: true})])
    render(<FileTree />)
    const dirRow = await screen.findByRole('treeitem', {name: 'src'})
    // 未展开：子项不在 DOM 中
    expect(screen.queryByRole('treeitem', {name: 'x.ts'})).toBeNull()
    expect(dirRow).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('src')).toHaveClass('pm-c--M')     // M 优先于 ??
  })

  it('被忽略条目无状态色（不参与目录染色）', async () => {
    listDir.mockResolvedValue([entry('build.log', 'build.log', false, {gitStatus: 'M', ignored: true})])
    render(<FileTree />)
    const row = await screen.findByRole('treeitem', {name: 'build.log'})
    expect(row.querySelector('[data-testid="status-badge"]')).toBeNull()
    expect(screen.getByText('build.log')).not.toHaveClass('pm-c--M')
  })
})

describe('FileTree 图标体系（spec §6.1）', () => {
  it('目录行与文件行都渲染 13px 图标', async () => {
    listDir.mockResolvedValue([entry('src', 'src', true, {hasChildren: true}), entry('a.ts', 'a.ts', false)])
    render(<FileTree />)
    for (const name of ['src', 'a.ts']) {
      const row = await screen.findByRole('treeitem', {name})
      expect(row.querySelector('.pm-tree-row-icon svg')).not.toBeNull()
    }
  })

  it('回归：不再使用 emoji 图标', async () => {
    listDir.mockResolvedValue([entry('src', 'src', true, {hasChildren: true}), entry('a.ts', 'a.ts', false)])
    render(<FileTree />)
    const tree = await screen.findByTestId('pm-filetree')
    expect(tree.textContent).not.toMatch(/[\u{1F4C1}\u{1F4C4}\u{1F4C2}]/u)
  })
})

describe('FileTree 工具栏', () => {
  it('标题带根条目计数', async () => {
    listDir.mockResolvedValue(ROOT)
    render(<FileTree />)
    await screen.findByRole('treeitem', {name: 'dist'})
    expect(screen.getByTestId('pm-filetree-header')).toHaveTextContent('5')
  })

  it('「全部折叠」收起所有已展开目录', async () => {
    listDir.mockResolvedValueOnce([entry('src', 'src', true, {hasChildren: true})])
    listDir.mockResolvedValueOnce([entry('x.ts', 'src/x.ts', false)])
    render(<FileTree />)
    fireEvent.click((await screen.findByRole('treeitem', {name: 'src'})).querySelector('[role="button"]')!)
    await screen.findByRole('treeitem', {name: 'x.ts'})
    fireEvent.click(screen.getByRole('button', {name: '全部折叠'}))
    expect(screen.queryByRole('treeitem', {name: 'x.ts'})).toBeNull()
  })

  it('「刷新」重新拉取根目录', async () => {
    listDir.mockResolvedValue(ROOT)
    render(<FileTree />)
    await screen.findByRole('treeitem', {name: 'dist'})
    const before = listDir.mock.calls.length
    fireEvent.click(screen.getByRole('button', {name: '刷新'}))
    // 等 loadRoot 的 promise 落定（setChildren 触发的重渲染必须在 act 内完成，否则打印 act 警告）
    await waitFor(() => expect(listDir.mock.calls.length).toBeGreaterThan(before))
  })
})

describe('FileTree 右键菜单原语化', () => {
  it('右键弹菜单，且不再是写死的 Darcula 灰', async () => {
    listDir.mockResolvedValue(ROOT)
    render(<FileTree />)
    const row = await screen.findByRole('treeitem', {name: 'a.ts'})
    fireEvent.contextMenu(row)
    const menu = screen.getByRole('menu')
    expect(menu).toHaveClass('pm-context-menu')
    expect(menu.getAttribute('style')).not.toMatch(/252526/)   // 旧兜底色彻底消失
  })

  it('菜单含四项且点击后关闭', async () => {
    listDir.mockResolvedValue(ROOT)
    render(<FileTree />)
    fireEvent.contextMenu(await screen.findByRole('treeitem', {name: 'a.ts'}))
    expect(screen.getAllByRole('menuitem')).toHaveLength(4)
    fireEvent.click(screen.getByRole('menuitem', {name: '复制路径'}))
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
