// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {render, screen, fireEvent, act, waitFor} from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import {readFileSync} from 'fs'
import {join} from 'path'
import {GitBranchTree} from '../../../src/renderer/project-manager/components/GitBranchTree'
import {useGitLogStore} from '../../../src/renderer/project-manager/stores/gitLogStore'
import {useGitStatusStore} from '../../../src/renderer/project-manager/stores/gitStatusStore'
import {useWorkspaceStore} from '../../../src/renderer/project-manager/stores/workspaceStore'

// ConfirmDialog 真实实现依赖 window 事件 + 用户点击才会 resolve，删除分支的 confirm 必须打桩
vi.mock('../../../src/renderer/components/ConfirmDialog', () => ({
  confirm: vi.fn(async () => true),
  default: () => null,
}))
import {confirm} from '../../../src/renderer/components/ConfirmDialog'
const confirmMock = vi.mocked(confirm)

const makeBranch = (over: Record<string, unknown>) => ({
  name: 'b', hash: 'h', type: 'local', isCurrent: false, isRemote: false, ...over,
})

beforeEach(() => {
  useWorkspaceStore.setState({workspacePath: '/ws'})
  useGitLogStore.setState({selectedBranch: null, selectedHash: null, entries: []})
  confirmMock.mockReset()
  confirmMock.mockResolvedValue(true)
  ;(window as any).electronAPI = {
    projectManager: {
      // 远端分支的 name 是完整短 ref（origin/develop），remoteName 是首段（origin）
      // —— 与主进程 src/main/project-manager/git/branches.ts 的真实输出一致
      gitBranches: vi.fn(async () => [
        makeBranch({name: 'main', isCurrent: true, type: 'local', hash: 'h1'}),
        makeBranch({name: 'feature/login', type: 'local', hash: 'h2'}),
        makeBranch({name: 'develop', type: 'local', hash: 'h3'}),
        makeBranch({name: 'origin/main', type: 'remote', isRemote: true, remoteName: 'origin', hash: 'h4'}),
        makeBranch({name: 'origin/develop', type: 'remote', isRemote: true, remoteName: 'origin', hash: 'h5'}),
        makeBranch({name: 'upstream/dev', type: 'remote', isRemote: true, remoteName: 'upstream', hash: 'h6'}),
        makeBranch({name: 'v1.0', type: 'tag', hash: 'h7'}),
      ]),
      gitLog: vi.fn(async () => []),
      gitDeleteBranch: vi.fn(async () => {}),
    },
  }
})

describe('分支搜索框隔离性（spec §8.1 / §16.2）', () => {
  it('有独立的搜索框，占位文案为 分支或标签', async () => {
    render(<GitBranchTree />)
    expect(await screen.findByPlaceholderText('分支或标签')).toBeInTheDocument()
  })

  it('输入即过滤分支列表（前端本地过滤，无防抖）', async () => {
    render(<GitBranchTree />)
    await screen.findByRole('treeitem', {name: 'main'})
    fireEvent.change(screen.getByPlaceholderText('分支或标签'), {target: {value: 'login'}})
    expect(screen.getByRole('treeitem', {name: 'feature/login'})).toBeInTheDocument()
    expect(screen.queryByRole('treeitem', {name: 'develop'})).toBeNull()
  })

  it('过滤忽略大小写，且匹配子串', async () => {
    render(<GitBranchTree />)
    await screen.findByRole('treeitem', {name: 'main'})
    fireEvent.change(screen.getByPlaceholderText('分支或标签'), {target: {value: 'LOGIN'}})
    expect(screen.getByRole('treeitem', {name: 'feature/login'})).toBeInTheDocument()
  })

  it('命中分支高亮匹配段，且保留原串大小写（spec §8.1）', async () => {
    const {container} = render(<GitBranchTree />)
    await screen.findByRole('treeitem', {name: 'main'})
    // 查询为空：不高亮
    expect(container.querySelector('.pm-search-match')).toBeNull()
    fireEvent.change(screen.getByPlaceholderText('分支或标签'), {target: {value: 'LOGIN'}})
    // 只有 feature/login 命中；高亮元素内容取原串大小写（login，而非输入的 LOGIN）
    const matches = container.querySelectorAll('.pm-search-match')
    expect(matches).toHaveLength(1)
    expect(matches[0].textContent).toBe('login')
    const row = screen.getByRole('treeitem', {name: 'feature/login'})
    expect(row.querySelector('.pm-search-match')?.textContent).toBe('login')
    // aria-label 不因高亮而变，仍是完整 ref
    expect(row).toHaveAttribute('aria-label', 'feature/login')
  })

  it('高亮底色不得与选中行底色相同（否则选中后高亮整段消失，spec §8.1 要求命中段可见）', () => {
    const css = readFileSync(join(process.cwd(), 'src/renderer/styles/globals.css'), 'utf-8')
    const bodyOf = (selector: string) => {
      const m = css.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}'))
      expect(m, `缺少 ${selector} 规则`).not.toBeNull()
      return m![1]
    }
    const background = (body: string) => body.match(/background\s*:\s*([^;]+);/)?.[1].trim()
    const selected = background(bodyOf('.pm-tree-row.is-selected'))
    const match = background(bodyOf('.pm-search-match'))
    expect(selected).toBe('var(--brand-muted)')
    expect(match).not.toBe(selected)
    expect(match).not.toContain('--brand-muted')
  })

  it('★ 核心约束：分支搜索绝不调用 applyFilters（不过滤 Commit 列表）', async () => {
    const applyFilters = vi.fn()
    useGitLogStore.setState({applyFilters: applyFilters as never})
    render(<GitBranchTree />)
    await screen.findByRole('treeitem', {name: 'main'})
    fireEvent.change(screen.getByPlaceholderText('分支或标签'), {target: {value: 'dev'}})
    expect(applyFilters).not.toHaveBeenCalled()
  })

  it('点击分支行仍然调用 applyFilters（现有行为保留）', async () => {
    const applyFilters = vi.fn()
    useGitLogStore.setState({applyFilters: applyFilters as never})
    render(<GitBranchTree />)
    fireEvent.click(await screen.findByRole('treeitem', {name: 'develop'}))
    expect(applyFilters).toHaveBeenCalledWith('/ws', {limit: 100, filterBranch: ['develop']})
  })

  it('清除按钮恢复完整列表', async () => {
    render(<GitBranchTree />)
    await screen.findByRole('treeitem', {name: 'main'})
    const input = screen.getByPlaceholderText('分支或标签')
    fireEvent.change(input, {target: {value: 'login'}})
    fireEvent.click(screen.getByRole('button', {name: '清除'}))
    expect(screen.getByRole('treeitem', {name: 'develop'})).toBeInTheDocument()
  })

  it('过滤后无命中时显示空态', async () => {
    render(<GitBranchTree />)
    await screen.findByRole('treeitem', {name: 'main'})
    fireEvent.change(screen.getByPlaceholderText('分支或标签'), {target: {value: 'zzzz'}})
    expect(screen.getByText('无匹配分支')).toBeInTheDocument()
  })
})

describe('Remote 二级分组（spec §8.2）', () => {
  it('按远端名再分一层，多个远端各自成组', async () => {
    render(<GitBranchTree />)
    await screen.findByRole('treeitem', {name: 'main'})
    // 二级组头：远端名 + 计数（可访问名即远端名本身，避免与 origin/main 之类混淆）
    expect(screen.getByRole('treeitem', {name: 'origin'})).toBeInTheDocument()
    expect(screen.getByRole('treeitem', {name: 'upstream'})).toBeInTheDocument()
  })

  it('二级组可折叠', async () => {
    render(<GitBranchTree />)
    await screen.findByRole('treeitem', {name: 'main'})
    const group = screen.getByRole('treeitem', {name: 'upstream'})
    expect(group).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(group)
    expect(group).toHaveAttribute('aria-expanded', 'false')
  })

  it('缩进三级递进：顶层组 8 / 直系分支 13 / Remote 二级 26 / 二级下分支 39（spec §8.2 / §13.3）', async () => {
    render(<GitBranchTree />)
    await screen.findByRole('treeitem', {name: 'main'})
    expect(screen.getByRole('treeitem', {name: '远程分支'})).toHaveStyle({paddingLeft: '8px'})
    expect(screen.getByRole('treeitem', {name: '本地分支'})).toHaveStyle({paddingLeft: '8px'})
    expect(screen.getByRole('treeitem', {name: 'origin'})).toHaveStyle({paddingLeft: '26px'})
    expect(screen.getByRole('treeitem', {name: 'develop'})).toHaveStyle({paddingLeft: '13px'})
    expect(screen.getByRole('treeitem', {name: 'origin/develop'})).toHaveStyle({paddingLeft: '39px'})
  })

  it('无远端时 Remote 组不渲染', async () => {
    ;(window as any).electronAPI.projectManager.gitBranches = vi.fn(async () => [makeBranch({name: 'main', isCurrent: true})])
    render(<GitBranchTree />)
    await screen.findByRole('treeitem', {name: 'main'})
    expect(screen.queryByRole('treeitem', {name: '远程分支'})).toBeNull()
    expect(screen.queryByRole('treeitem', {name: 'origin'})).toBeNull()
  })
})

describe('分支名目录化（IDEA Git Branches 行为）', () => {
  it('Local 分支名中的 / 拆成可折叠目录：feature（13px）> feature/login（26px）', async () => {
    const applyFilters = vi.fn()
    useGitLogStore.setState({applyFilters: applyFilters as never})
    render(<GitBranchTree />)
    await screen.findByRole('treeitem', {name: 'main'})
    const dir = screen.getByRole('treeitem', {name: 'feature'})
    expect(dir).toHaveStyle({paddingLeft: '13px'})
    expect(dir).toHaveAttribute('aria-expanded', 'true')
    const leaf = screen.getByRole('treeitem', {name: 'feature/login'})
    expect(leaf).toHaveStyle({paddingLeft: '26px'})
    // 点击目录行折叠：叶子消失，且绝不调用 applyFilters
    fireEvent.click(dir)
    expect(dir).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('treeitem', {name: 'feature/login'})).toBeNull()
    expect(applyFilters).not.toHaveBeenCalled()
  })

  it('Remote 组同样拆目录：origin(26px) > feature(39px) > login(52px)，叶子 aria-label 为完整 ref', async () => {
    ;(window as any).electronAPI.projectManager.gitBranches = vi.fn(async () => [
      makeBranch({name: 'origin/feature/login', type: 'remote', isRemote: true, remoteName: 'origin', hash: 'hr'}),
    ])
    render(<GitBranchTree />)
    await screen.findByRole('treeitem', {name: 'origin'})
    expect(screen.getByRole('treeitem', {name: 'origin'})).toHaveStyle({paddingLeft: '26px'})
    expect(screen.getByRole('treeitem', {name: 'origin/feature'})).toHaveStyle({paddingLeft: '39px'})
    const leaf = screen.getByRole('treeitem', {name: 'origin/feature/login'})
    expect(leaf).toHaveStyle({paddingLeft: '52px'})
  })

  it('搜索命中深处叶子时祖先目录一并渲染并强制展开，清空后恢复用户折叠态', async () => {
    render(<GitBranchTree />)
    await screen.findByRole('treeitem', {name: 'main'})
    // 先手动折叠 feature 目录
    fireEvent.click(screen.getByRole('treeitem', {name: 'feature'}))
    expect(screen.queryByRole('treeitem', {name: 'feature/login'})).toBeNull()
    // 输入查询 → 命中深处叶子，祖先目录被强制展开
    const input = screen.getByPlaceholderText('分支或标签')
    fireEvent.change(input, {target: {value: 'login'}})
    expect(screen.getByRole('treeitem', {name: 'feature'})).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('treeitem', {name: 'feature/login'})).toBeInTheDocument()
    // 清空查询 → 恢复用户折叠态
    fireEvent.change(input, {target: {value: ''}})
    expect(screen.getByRole('treeitem', {name: 'feature'})).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('treeitem', {name: 'feature/login'})).toBeNull()
  })

  it('同名既是分支又是目录时两者都渲染且都能用（feat + feat/x）', async () => {
    const applyFilters = vi.fn()
    useGitLogStore.setState({applyFilters: applyFilters as never})
    ;(window as any).electronAPI.projectManager.gitBranches = vi.fn(async () => [
      makeBranch({name: 'feat', type: 'local', hash: 'hFeat'}),
      makeBranch({name: 'feat/x', type: 'local', hash: 'hX'}),
    ])
    render(<GitBranchTree />)
    const rows = await screen.findAllByRole('treeitem', {name: 'feat'})
    expect(rows).toHaveLength(2)
    const folder = rows.find(r => r.getAttribute('aria-expanded') !== null)!
    const leaf = rows.find(r => r.getAttribute('aria-expanded') === null)!
    expect(folder).toHaveAttribute('aria-expanded', 'true')
    // 目录下挂着同名分支的派生子分支
    expect(screen.getByRole('treeitem', {name: 'feat/x'})).toHaveStyle({paddingLeft: '26px'})
    // 叶子行点击 → applyFilters（完整 ref 仍是 feat）
    fireEvent.click(leaf)
    expect(applyFilters).toHaveBeenCalledWith('/ws', {limit: 100, filterBranch: ['feat']})
    applyFilters.mockClear()
    // 目录行点击只折叠，不触发 applyFilters
    fireEvent.click(folder)
    expect(applyFilters).not.toHaveBeenCalled()
    expect(screen.queryByRole('treeitem', {name: 'feat/x'})).toBeNull()
  })

  it('目录行点击/chevron 不触发 applyFilters（叶子行仍触发）', async () => {
    const applyFilters = vi.fn()
    useGitLogStore.setState({applyFilters: applyFilters as never})
    render(<GitBranchTree />)
    await screen.findByRole('treeitem', {name: 'main'})
    const dir = screen.getByRole('treeitem', {name: 'feature'})
    // 点 chevron（role=button 的子节点）
    fireEvent.click(dir.querySelector('[role="button"]')!)
    expect(applyFilters).not.toHaveBeenCalled()
    expect(screen.queryByRole('treeitem', {name: 'feature/login'})).toBeNull()
    // 叶子行点击仍然触发
    fireEvent.click(dir)
    fireEvent.click(screen.getByRole('treeitem', {name: 'feature/login'}))
    expect(applyFilters).toHaveBeenCalledWith('/ws', {limit: 100, filterBranch: ['feature/login']})
  })
})

describe('Checkout 文案（spec §5）', () => {
  it('右键菜单 Checkout 仍禁用，reason 不再是「窗口只读」', async () => {
    render(<GitBranchTree />)
    fireEvent.contextMenu(await screen.findByRole('treeitem', {name: 'main'}))
    const item = screen.getByRole('menuitem', {name: '检出'})
    expect(item).toBeDisabled()
    expect(item).toHaveAttribute('title', '本窗口不支持检出')
  })

  it('refsVersion 变化时重新拉取分支（commit/push 后 tip 不陈旧）', async () => {
    render(<GitBranchTree />)
    await screen.findByRole('treeitem', {name: 'main'})
    const before = ((window as any).electronAPI.projectManager.gitBranches as ReturnType<typeof vi.fn>).mock.calls.length
    act(() => { useGitStatusStore.getState().bumpRefs() })
    await waitFor(() => expect(((window as any).electronAPI.projectManager.gitBranches as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(before))
  })
})

describe('删除分支（danger）', () => {
  it('本地分支菜单含「删除分支」，确认后调用 gitDeleteBranch（isRemote:false）', async () => {
    render(<GitBranchTree />)
    fireEvent.contextMenu(await screen.findByRole('treeitem', {name: 'develop'}))
    const item = screen.getByRole('menuitem', {name: '删除分支'})
    expect(item).toHaveClass('pm-context-menu-item--danger')
    fireEvent.click(item)
    await waitFor(() => expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({title: '删除分支', confirmVariant: 'danger'})))
    await waitFor(() => expect((window as any).electronAPI.projectManager.gitDeleteBranch).toHaveBeenCalledWith('/ws', {name: 'develop', isRemote: false, remoteName: undefined, force: false}))
  })

  it('取消确认时不调用 gitDeleteBranch', async () => {
    confirmMock.mockResolvedValue(false)
    render(<GitBranchTree />)
    fireEvent.contextMenu(await screen.findByRole('treeitem', {name: 'develop'}))
    fireEvent.click(screen.getByRole('menuitem', {name: '删除分支'}))
    await waitFor(() => expect(confirmMock).toHaveBeenCalled())
    expect((window as any).electronAPI.projectManager.gitDeleteBranch).not.toHaveBeenCalled()
  })

  it('本地分支未合并（主进程标记「未合并」）时二次确认后强制删除', async () => {
    const del = vi.fn()
      .mockRejectedValueOnce(new Error('分支未合并，需强制删除'))
      .mockResolvedValueOnce(undefined)
    ;(window as any).electronAPI.projectManager.gitDeleteBranch = del
    render(<GitBranchTree />)
    fireEvent.contextMenu(await screen.findByRole('treeitem', {name: 'develop'}))
    fireEvent.click(screen.getByRole('menuitem', {name: '删除分支'}))
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(2))
    expect(del).toHaveBeenLastCalledWith('/ws', {name: 'develop', isRemote: false, force: true})
  })

  it('失败原因不含「未合并」→ 不弹强制删除，直接弹「删除失败」', async () => {
    const del = vi.fn().mockRejectedValueOnce(new Error('error: Cannot delete branch checked out'))
    ;(window as any).electronAPI.projectManager.gitDeleteBranch = del
    render(<GitBranchTree />)
    fireEvent.contextMenu(await screen.findByRole('treeitem', {name: 'develop'}))
    fireEvent.click(screen.getByRole('menuitem', {name: '删除分支'}))
    await waitFor(() => expect(confirmMock).toHaveBeenLastCalledWith(expect.objectContaining({title: '删除失败'})))
    // 只删一次（force:false），未进入强制删除分支
    expect(del).toHaveBeenCalledTimes(1)
    expect(del).toHaveBeenCalledWith('/ws', {name: 'develop', isRemote: false, remoteName: undefined, force: false})
  })

  it('远程分支「删除分支」：文案明确写出远程分支名，opts 带 isRemote/remoteName', async () => {
    render(<GitBranchTree />)
    fireEvent.contextMenu(await screen.findByRole('treeitem', {name: 'origin/main'}))
    fireEvent.click(screen.getByRole('menuitem', {name: '删除分支'}))
    await waitFor(() => expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({
      title: '删除分支',
      message: expect.stringContaining('删除远程分支 origin/main'),
    })))
    await waitFor(() => expect((window as any).electronAPI.projectManager.gitDeleteBranch).toHaveBeenCalledWith('/ws', {name: 'main', isRemote: true, remoteName: 'origin', force: false}))
  })

  it('tag 节点「删除分支」禁用并给出 reason（不做无意义的 branch -d）', async () => {
    render(<GitBranchTree />)
    fireEvent.contextMenu(await screen.findByRole('treeitem', {name: 'v1.0'}))
    const item = screen.getByRole('menuitem', {name: '删除分支'})
    expect(item).toBeDisabled()
    expect(item).toHaveAttribute('title', '标签与当前分支不支持删除')
  })

  it('当前分支（HEAD）「删除分支」禁用并给出 reason', async () => {
    render(<GitBranchTree />)
    fireEvent.contextMenu(await screen.findByRole('treeitem', {name: 'main'}))
    expect(screen.getByRole('menuitem', {name: '删除分支'})).toBeDisabled()
  })

  it('非当前本地分支与远程分支「删除分支」可用', async () => {
    render(<GitBranchTree />)
    fireEvent.contextMenu(await screen.findByRole('treeitem', {name: 'develop'}))
    expect(screen.getByRole('menuitem', {name: '删除分支'})).toBeEnabled()
    fireEvent.contextMenu(screen.getByRole('treeitem', {name: 'origin/develop'}))
    expect(screen.getByRole('menuitem', {name: '删除分支'})).toBeEnabled()
  })
})
