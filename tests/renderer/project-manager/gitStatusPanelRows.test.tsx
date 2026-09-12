// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {readFileSync} from 'fs'
import {join} from 'path'
import {render, screen, fireEvent, waitFor} from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import {GitStatusPanel} from '../../../src/renderer/project-manager/components/GitStatusPanel'
import {useGitStatusStore} from '../../../src/renderer/project-manager/stores/gitStatusStore'
import {useFileTreeStore} from '../../../src/renderer/project-manager/stores/fileTreeStore'

const summary = {
  statusMap: {
    'src/a.ts': {path: 'src/a.ts', status: 'M' as const, indexStatus: ' ', worktreeStatus: 'M'},
    'src/b.ts': {path: 'src/b.ts', status: 'A' as const, indexStatus: 'A', worktreeStatus: ' '},
    'c.ts': {path: 'c.ts', status: '??' as const, indexStatus: '?', worktreeStatus: '?'},
  },
  additions: 46,
  deletions: 4,
  updatedAt: 1,
}

beforeEach(() => {
  useGitStatusStore.setState({summary: summary as never})
  useFileTreeStore.setState({selectedPath: null})
})

describe('GitStatusPanel 行结构（spec §7）', () => {
  it('文件行用 TreeRow：文件名 + 状态字母列', () => {
    render(<GitStatusPanel workspace="/ws" />)
    const row = screen.getByRole('treeitem', {name: 'src/a.ts'})
    expect(row.querySelector('[data-testid="status-badge"]')).toHaveTextContent('M')
    // 路径聚合后行内只显示文件名，目录名在组标题上（spec §7）
    expect(row).toHaveTextContent('a.ts')
    expect(row).not.toHaveTextContent('src/a.ts')
  })

  it('缩进：目录组 13px，文件行 26px', () => {
    render(<GitStatusPanel workspace="/ws" />)
    expect(screen.getAllByRole('treeitem', {name: 'src'})[0]).toHaveStyle({paddingLeft: '13px'})
    expect(screen.getByRole('treeitem', {name: 'src/a.ts'})).toHaveStyle({paddingLeft: '26px'})
  })

  it('未跟踪分组保留，且它的文件行也走 TreeRow', () => {
    render(<GitStatusPanel workspace="/ws" />)
    expect(screen.getByText(/未跟踪文件/)).toBeInTheDocument()
    expect(screen.getByRole('treeitem', {name: 'c.ts'})).toHaveTextContent('c.ts')
  })

  it('未跟踪分组被 .pm-untracked-section 包住（供横线分隔 + 灰色调作用域）', () => {
    const {container} = render(<GitStatusPanel workspace="/ws" />)
    const section = container.querySelector('.pm-untracked-section')
    expect(section).not.toBeNull()
    // 未跟踪的组标题与文件行都必须落在该作用域内，否则灰调覆盖不到
    expect(section!).toHaveTextContent(/未跟踪文件/)
    expect(section!.querySelector('[role="treeitem"][aria-label="c.ts"]')).not.toBeNull()
    // 已跟踪变更不得被卷进未跟踪作用域
    expect(section!.querySelector('[role="treeitem"][aria-label="src/a.ts"]')).toBeNull()
  })

  it('未跟踪分组样式：横线分隔 + 灰色调（jsdom 不解析外部 CSS → 静态断言）', () => {
    const css = readFileSync(join(process.cwd(), 'src/renderer/styles/globals.css'), 'utf-8')
    const at = css.indexOf('.pm-untracked-section {')
    expect(at).toBeGreaterThanOrEqual(0)
    const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at))
    expect(body).toMatch(/border-top:\s*1px solid var\(--border\)/)
    expect(body).toMatch(/color:\s*var\(--text-muted\)/)
    // 图标与状态色类是自带颜色的，必须显式覆盖到，不能只靠继承
    expect(css).toContain('.pm-untracked-section .pm-c--untracked { color: var(--text-muted); }')
    // 图标只能靠 stroke 改灰：lucide-react 把 color 渲染成 svg 的 stroke 属性（不是 color 属性），
    // 只写 color 会让图标保持原色 —— 这条断言是防回归的关键（见 globals.css 的 ⚠️ 注释）。
    expect(css).toContain('.pm-untracked-section svg { color: var(--text-muted); stroke: var(--text-muted); }')
    // 防重复：同规则块被写两遍会形成「后一条悄悄覆盖前一条」的隐性地雷
    expect(css.match(/^\.pm-untracked-section \{/gm) ?? []).toHaveLength(1)
  })

  it('底部统计行按 spec §7 的格式', () => {
    render(<GitStatusPanel workspace="/ws" />)
    expect(screen.getByTestId('pm-changes-summary')).toHaveTextContent('已更改 3 个文件 · +46 · −4')
  })

  it('无变更时显示空态', () => {
    useGitStatusStore.setState({summary: {statusMap: {}, additions: 0, deletions: 0, updatedAt: 0} as never})
    render(<GitStatusPanel workspace="/ws" />)
    expect(screen.getByText('工作区干净')).toBeInTheDocument()
  })

  it('分组标题带对应状态色的徽章', () => {
    render(<GitStatusPanel workspace="/ws" />)
    expect(screen.getByText(/已修改/)).toHaveClass('pm-c--M')
  })

  it('所有分组标题都走 pm-group-title（spec §7 加粗）且不沾文件行装饰', () => {
    render(<GitStatusPanel workspace="/ws" />)
    for (const re of [/已修改/, /已新增/, /未跟踪文件/]) {
      expect(screen.getByText(re)).toHaveClass('pm-group-title')
    }
    // pm-file-name 的装饰（M 加粗 / D 删除线 / ?? 斜体）是文件行专用，聚合标题不得沾
    expect(screen.getByText(/已新增/)).not.toHaveClass('pm-file-name')
    expect(screen.getByText(/未跟踪文件/)).not.toHaveClass('pm-file-name')
  })

  it('A1 未跟踪分组标题的无障碍名不含 ??', () => {
    render(<GitStatusPanel workspace="/ws" />)
    const row = screen.getByRole('treeitem', {name: /^未跟踪文件 \(/})
    expect(row).toHaveAttribute('aria-label', '未跟踪文件 (1)')
    expect(screen.queryByText(/\?\?/)).toBeNull()
  })

  it('A2 未跟踪行去掉徽章后仍可识别（行名仍带 pm-c--untracked）', () => {
    render(<GitStatusPanel workspace="/ws" />)
    const row = screen.getByRole('treeitem', {name: 'c.ts'})
    expect(row.querySelector('[data-testid="status-badge"]')).toBeNull()
    expect(row.querySelector('.pm-c--untracked')).not.toBeNull()
  })

  it('A3 M/A/D/R 行仍渲染徽章', () => {
    useGitStatusStore.setState({summary: {statusMap: {
      'm.ts': {path: 'm.ts', status: 'M', indexStatus: ' ', worktreeStatus: 'M'},
      'a.ts': {path: 'a.ts', status: 'A', indexStatus: 'A', worktreeStatus: ' '},
      'd.ts': {path: 'd.ts', status: 'D', indexStatus: 'D', worktreeStatus: ' '},
      'r.ts': {path: 'r.ts', status: 'R', indexStatus: 'R', worktreeStatus: ' '},
    }, additions: 0, deletions: 0, updatedAt: 9} as never})
    render(<GitStatusPanel workspace="/ws" />)
    for (const [path, letter] of [['m.ts', 'M'], ['a.ts', 'A'], ['d.ts', 'D'], ['r.ts', 'R']] as const) {
      const row = screen.getByRole('treeitem', {name: path})
      expect(row.querySelector('[data-testid="status-badge"]')).toHaveTextContent(letter)
    }
  })
})

describe('GitStatusPanel 双击行为保持不变（回归）', () => {
  it('已跟踪文件双击打开 Diff tab', async () => {
    const openDiffTab = vi.fn()
    const {useEditorTabStore} = await import('../../../src/renderer/project-manager/stores/editorTabStore')
    useEditorTabStore.setState({openDiffTab: openDiffTab as never})
    ;(window as any).electronAPI = {projectManager: {gitDiffFile: vi.fn(async () => ({filePath: 'src/a.ts', oldContent: '', newContent: '', diffType: 'working-tree', oldRef: 'HEAD', newRef: 'worktree', additions: 0, deletions: 0}))}}
    render(<GitStatusPanel workspace="/ws" />)
    fireEvent.doubleClick(screen.getByRole('treeitem', {name: 'src/a.ts'}))
    await waitFor(() => expect(openDiffTab).toHaveBeenCalledTimes(1))
  })

  it('右键「文件树中显示」写入 fileTreeStore.revealTarget（spec §3.1 统一入口）', () => {
    render(<GitStatusPanel workspace="/ws" />)
    fireEvent.contextMenu(screen.getByRole('treeitem', {name: 'src/a.ts'}))
    fireEvent.click(screen.getByRole('menuitem', {name: '文件树中显示'}))
    expect(useFileTreeStore.getState().revealTarget).toBe('src/a.ts')
  })
})
