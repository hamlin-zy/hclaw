// @vitest-environment jsdom
import '@testing-library/jest-dom'
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, act} from '@testing-library/react'
import {GitBranchTree} from '../../../src/renderer/project-manager/components/GitBranchTree'
import {GitDagGraph} from '../../../src/renderer/project-manager/components/GitDagGraph'
import {GitLogPanel} from '../../../src/renderer/project-manager/components/GitLogPanel'
import {useGitLogStore} from '../../../src/renderer/project-manager/stores/gitLogStore'
import {useWorkspaceStore} from '../../../src/renderer/project-manager/stores/workspaceStore'
import {relativeTime} from '../../../src/renderer/project-manager/utils/format'
import type {GitLogEntry, BranchTreeNode} from '../../../src/shared/types/project-manager'

const flush = () => new Promise(r => setTimeout(r, 0))

const makeEntry = (overrides: Partial<GitLogEntry> = {}): GitLogEntry => ({
  hash: 'hash0', abbreviatedHash: 'hash0abc', parents: [], message: 'init', body: '',
  author: 'Alice', authorEmail: 'alice@test.com',
  authorDate: Date.now() - 30 * 60 * 1000,   // 30 min ago
  date: Date.now(),
  branches: ['main'], tags: ['v1.0'], isHead: true,
  ...overrides,
})

const makeBranch = (overrides: Partial<BranchTreeNode> = {}): BranchTreeNode => ({
  name: 'main', hash: 'hash0', type: 'local', isCurrent: true, isRemote: false,
  ...overrides,
})

beforeEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  useGitLogStore.setState({entries: [], selectedHash: null, selectedBranch: null, loading: false, hasMore: false, lastOptions: null})
  useWorkspaceStore.setState({workspacePath: '/ws'})
  ;(window as any).electronAPI = {projectManager: {gitBranches: vi.fn(async () => []), gitLog: vi.fn(async () => [])}}
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('GitBranchTree', () => {
  it('未选择分支时无选中态', async () => {
    useGitLogStore.setState({selectedBranch: null})
    ;(window as any).electronAPI.projectManager.gitBranches.mockResolvedValue([makeBranch()])
    render(<GitBranchTree />)
    const row = await screen.findByRole('treeitem', {name: 'main'})
    // 分支行改用 TreeRow 后，选中态不再是内联样式，而是 .pm-tree-row.is-selected
    // （globals.css:2915 提供 brand-muted 底 + inset 品牌色竖条）
    expect(row).not.toHaveClass('is-selected')
  })

  it('点击分支行后 applyFilters 被调用（后续由 store 写入 selectedBranch）', async () => {
    ;(window as any).electronAPI.projectManager.gitBranches.mockResolvedValue([
      makeBranch({name: 'main', hash: 'hA'}),
      makeBranch({name: 'develop', isCurrent: false, hash: 'hD'}),
    ])
    render(<GitBranchTree />)
    const row = await screen.findByRole('treeitem', {name: 'develop'})
    fireEvent.click(row)
    // 异步应用 filter：mock gitLog 立即返回；store 写入 selectedBranch + 清空 selectedHash
    await flush()
    expect(useGitLogStore.getState().selectedBranch).toBe('develop')
  })

  it('selectedBranch 命中时该行显示 brand-muted 背景 + inset shadow', async () => {
    useGitLogStore.setState({selectedBranch: 'develop'})
    ;(window as any).electronAPI.projectManager.gitBranches.mockResolvedValue([
      makeBranch({name: 'main', hash: 'hashMain'}),
      makeBranch({name: 'develop', isCurrent: false, hash: 'hashDev'}),
    ])
    render(<GitBranchTree />)
    const main = await screen.findByRole('treeitem', {name: 'main'})
    const develop = screen.getByRole('treeitem', {name: 'develop'})
    expect(main).not.toHaveClass('is-selected')
    expect(develop).toHaveClass('is-selected')
    expect(develop).toHaveAttribute('aria-selected', 'true')
  })

  it('当前分支仍显示 ★（选中态与当前态可共存）', async () => {
    useGitLogStore.setState({selectedBranch: 'main'})
    ;(window as any).electronAPI.projectManager.gitBranches.mockResolvedValue([
      makeBranch({name: 'main', isCurrent: true, hash: 'hashMain'}),
    ])
    render(<GitBranchTree />)
    const row = await screen.findByRole('treeitem', {name: 'main'})
    expect(row.textContent).toContain('★')
    expect(row).toHaveClass('is-selected')
  })

  it('分支组头点击可折叠/展开子分支', async () => {
    ;(window as any).electronAPI.projectManager.gitBranches.mockResolvedValue([
      makeBranch({name: 'main', isCurrent: true, hash: 'hashMain'}),
      makeBranch({name: 'develop', isCurrent: false, hash: 'hashDev'}),
    ])
    render(<GitBranchTree />)
    await screen.findByText('develop')
    fireEvent.click(screen.getByRole('treeitem', {name: 'Local'}))
    // Local 组折叠后，Local 子分支隐藏；HEAD 组仍展开
    expect(screen.queryByText('develop')).not.toBeInTheDocument()
    // HEAD 组仍显示 main
    expect(screen.getByText(/HEAD \(main\)/)).toBeInTheDocument()
    // 再点展开
    fireEvent.click(screen.getByRole('treeitem', {name: 'Local'}))
    expect(screen.getByText('develop')).toBeInTheDocument()
  })

  it('HEAD 组可折叠/展开', async () => {
    ;(window as any).electronAPI.projectManager.gitBranches.mockResolvedValue([
      makeBranch({name: 'main', isCurrent: true, hash: 'hashMain'}),
    ])
    render(<GitBranchTree />)
    await screen.findByText('HEAD (main)')
    // HEAD 组展开时含 aria-label="HEAD main" 的 treeitem（与 Local 组同名消歧）
    expect(screen.getByRole('treeitem', {name: 'HEAD main'})).toBeInTheDocument()
    // 折叠 HEAD 组
    fireEvent.click(screen.getByRole('treeitem', {name: /HEAD \(main\)/}))
    expect(screen.queryByRole('treeitem', {name: 'HEAD main'})).not.toBeInTheDocument()
    // 展开 HEAD 组
    fireEvent.click(screen.getByRole('treeitem', {name: /HEAD \(main\)/}))
    expect(screen.getByRole('treeitem', {name: 'HEAD main'})).toBeInTheDocument()
    // Local 组仍保留 current（IDEA 语义），其 aria-label="main" 可独立查询
    expect(screen.getByRole('treeitem', {name: 'main'})).toBeInTheDocument()
  })

  it('层级缩进：顶层组 8px，直系分支 13px，Remote 下二级组 26px，远端分支 39px', async () => {
    ;(window as any).electronAPI.projectManager.gitBranches.mockResolvedValue([
      makeBranch({name: 'main', isCurrent: true, type: 'local', hash: 'hL'}),
      makeBranch({name: 'origin/main', type: 'remote', isRemote: true, remoteName: 'origin', isCurrent: false, hash: 'hR'}),
      makeBranch({name: 'v1.0', type: 'tag', isCurrent: false, hash: 'hT'}),
    ])
    render(<GitBranchTree />)
    // 统一缩进尺度（spec §13.3）：每层 13px，depth 0 例外为 8px
    expect(await screen.findByRole('treeitem', {name: 'Local'})).toHaveStyle({paddingLeft: '8px'})
    const localRow = screen.getByRole('treeitem', {name: 'main'})
    expect(localRow).toHaveStyle({paddingLeft: '13px'})
    // 远端分支落在 Remote → origin → 分支 的第三层
    expect(screen.getByRole('treeitem', {name: 'origin'})).toHaveStyle({paddingLeft: '26px'})
    const remoteRow = screen.getByRole('treeitem', {name: 'origin/main'})
    expect(remoteRow).toHaveStyle({paddingLeft: '39px'})
    // tag 是顶层组直系，与 local 同步缩进
    const tagRow = screen.getByRole('treeitem', {name: 'v1.0'})
    expect(tagRow).toHaveStyle({paddingLeft: '13px'})
  })

  it('顶部过滤控件统一走原语：class 契约、无内联样式', () => {
    render(<GitLogPanel />)
    // 输入框与提交按钮改用 ui/SearchInput 原语（Task 14）：边框/底色/圆角全部由
    // globals.css 的 .pm-search-* 提供，组件不再往 DOM 写 style 属性
    // （旧断言读的正是被删除的 controlStyle/inputStyle 内联对象）
    // 过滤栏文案已中文化（Task）：placeholder 由 'Text or hash' 改为 '文本或哈希'
    const input = screen.getByPlaceholderText('文本或哈希')
    expect(input).toHaveClass('pm-search-input')
    expect(input).not.toHaveAttribute('style')
    // 可访问名来自 SearchInput 的 submitLabel="查找"（GitLogPanel 显式传入以保住既有语义）
    const findBtn = screen.getByRole('button', {name: '查找'})
    expect(findBtn).toHaveClass('pm-search-submit')
    expect(findBtn).not.toHaveAttribute('style')
  })

  it('git 检测首次返回空数组时显示"正在检测仓库…"并在 800ms 后重试一次', async () => {
    vi.useFakeTimers()
    const branchesMock = vi.fn()
      .mockResolvedValueOnce([])                                       // 首次调用：空
      .mockResolvedValueOnce([makeBranch({name: 'main', hash: 'hA'})]) // 重试：返回分支
    ;(window as any).electronAPI = {projectManager: {gitBranches: branchesMock, gitLog: vi.fn(async () => [])}}

    render(<GitBranchTree />)
    // 初始渲染 nodes=[] → 显示检测中提示
    expect(screen.getByText('正在检测仓库…')).toBeInTheDocument()

    // 首次 gitBranches 返回后，内部设置 800ms 重试定时器
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(branchesMock).toHaveBeenCalledTimes(1)

    // 800ms 后触发重试，再让 .then(r => setNodes(r)) 完成
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800)
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(branchesMock).toHaveBeenCalledTimes(2)

    // 重试返回分支数据 → 渲染出分支树，隐藏检测中提示
    expect(screen.getByRole('treeitem', {name: 'main'})).toBeInTheDocument()
    expect(screen.queryByText('正在检测仓库…')).not.toBeInTheDocument()
  })

  it('点击分支行时 applyFilters 收到纯分支名 filterBranch（不带 hash）', async () => {
    const applyFiltersMock = vi.fn()
    useGitLogStore.setState({applyFilters: applyFiltersMock as any})
    ;(window as any).electronAPI.projectManager.gitBranches.mockResolvedValue([
      // hash 与 name 分字段（branches.ts 修复后的数据形态）；
      // 断言 applyFilters 收到的是 n.name，而非 "n.name <hash>"
      makeBranch({name: 'main', hash: 'aabbccdd0011223344556677889900aabbccdd0011', isCurrent: false}),
    ])
    render(<GitBranchTree />)
    const row = await screen.findByRole('treeitem', {name: 'main'})
    fireEvent.click(row)
    expect(applyFiltersMock).toHaveBeenCalledTimes(1)
    expect(applyFiltersMock).toHaveBeenCalledWith('/ws', {
      limit: 100,
      filterBranch: ['main'], // ← NOT ['main <40 位 hash>']
    })
  })
})

describe('GitDagGraph', () => {
  it('commit 行显示 abbreviatedHash 与 message', () => {
    useGitLogStore.setState({entries: [makeEntry()], selectedHash: null})
    render(<GitDagGraph />)
    expect(screen.getByText('hash0abc')).toBeInTheDocument()
    expect(screen.getByText('init')).toBeInTheDocument()
  })

  it('四段式单行：hash + subject + refs 徽章 + 作者·时间同处一行', () => {
    useGitLogStore.setState({entries: [makeEntry({branches: ['main'], isHead: true, tags: []})], selectedHash: null})
    render(<GitDagGraph />)
    const row = screen.getByTestId('pm-commit-row')
    // spec §9.1 的四段全部落在同一行 div 内（旧「序号 + @refs 后缀」已按 spec 移除）
    expect(row.querySelector('.pm-commit-hash')).toHaveTextContent('hash0abc')
    expect(row.querySelector('.pm-commit-subject')).toHaveTextContent('init')
    expect(row.querySelector('.pm-commit-meta')).toHaveTextContent('Alice')
    // refs 改为徽章：分支名与 HEAD 都在 .pm-commit-refs 内，不再是 `@main` 文本
    const refs = row.querySelector('.pm-commit-refs')!
    expect(refs.textContent).toContain('main')
    expect(refs.textContent).toContain('HEAD')
    // 行内恰好五段（rail / hash / subject / refs / meta），没有多行 metadata 块
    expect(row.children).toHaveLength(5)
  })

  it('commit 行显示 author 与 relative time metadata', () => {
    useGitLogStore.setState({entries: [makeEntry()], selectedHash: null})
    render(<GitDagGraph />)
    expect(screen.getByText(/Alice/)).toBeInTheDocument()
    // 30 min ago → '30m ago'；走的是 authorDate（committer date 是 makeEntry 里的 now → 'just now'）
    expect(screen.getByText(/30m ago/)).toBeInTheDocument()
    expect(screen.queryByText(/just now/)).toBeNull()
  })

  it('refs 非空时逐个渲染分支徽章', () => {
    useGitLogStore.setState({entries: [makeEntry({branches: ['main', 'origin/main'], tags: [], isHead: false})], selectedHash: null})
    render(<GitDagGraph />)
    const refs = screen.getByTestId('pm-commit-row').querySelector('.pm-commit-refs')!
    expect([...refs.querySelectorAll('.pm-ref-badge')].map(b => b.textContent)).toEqual(['main', 'origin/main'])
  })

  it('refs 为空时不渲染任何分支徽章', () => {
    useGitLogStore.setState({entries: [makeEntry({branches: [], tags: [], isHead: false})], selectedHash: null})
    render(<GitDagGraph />)
    expect(screen.getByTestId('pm-commit-row').querySelectorAll('.pm-ref-badge')).toHaveLength(0)
  })

  it('行 tooltip 是 subject 全文；作者/时间/refs 落在行内各段（可见性增强回归）', () => {
    useGitLogStore.setState({entries: [makeEntry({branches: ['main'], authorDate: Date.now() - 5 * 60 * 1000})], selectedHash: null})
    render(<GitDagGraph />)
    const row = screen.getByTestId('pm-commit-row')
    // 单行省略后靠整行 title 展示 subject 全文（spec §9.1：subject 省略号 + tooltip 全文）
    expect(row).toHaveAttribute('title', 'init')
    // 可见段必须真渲染 `{e.author} · {relativeTime}`（防"tooltip 存在但行空"回归）
    expect(row.querySelector('.pm-commit-meta')).toHaveTextContent('Alice · 5m ago')
    expect(row.querySelector('.pm-commit-refs')).toHaveTextContent('main')
  })

  it('HEAD 徽章和 tag 徽章保留', () => {
    useGitLogStore.setState({entries: [makeEntry({isHead: true, tags: ['v1.0']})], selectedHash: null})
    render(<GitDagGraph />)
    const refs = screen.getByTestId('pm-commit-row').querySelector('.pm-commit-refs')!
    const badges = [...refs.querySelectorAll('.pm-ref-badge')].map(b => b.textContent)
    expect(badges).toContain('HEAD')
    expect(badges).toContain('tag:v1.0')
  })

  it('merge commit 不再渲染 Nx 徽章（四段式无此段），改由 rail 圆点着色区分', () => {
    useGitLogStore.setState({entries: [makeEntry({parents: ['a', 'b'], isHead: false})], selectedHash: null})
    render(<GitDagGraph />)
    // spec §9.1 的四段式没有 merge 计数段；spec §9.3 用圆点颜色区分 merge
    expect(screen.queryByText('2p')).toBeNull()
    expect(screen.getByTestId('pm-commit-row').querySelector('.pm-commit-rail-dot')).toHaveClass('is-merge')
  })

  it('选中态使用 .is-selected 类（不再用内联 brand-muted 背景）', () => {
    useGitLogStore.setState({entries: [makeEntry()], selectedHash: 'hash0'})
    render(<GitDagGraph />)
    const row = screen.getByTestId('pm-commit-row')
    expect(row).toHaveClass('is-selected')
    // 底色 + inset 竖条由 globals.css 的 .pm-commit-row.is-selected 提供，组件不写内联样式
    expect(row.getAttribute('style')).toBeNull()
  })

  it('sortAsc=true 时倒序渲染', () => {
    useGitLogStore.setState({entries: [makeEntry({message: 'older'}), makeEntry({message: 'newer'})], selectedHash: null})
    const {container} = render(<GitDagGraph sortAsc />)
    const texts = container.textContent ?? ''
    const newerIdx = texts.indexOf('newer')
    const olderIdx = texts.indexOf('older')
    expect(newerIdx).toBeLessThan(olderIdx)
  })
})

describe('relativeTime', () => {
  const now = Date.now()
  it('少于 1 分钟 → just now', () => {
    expect(relativeTime(now - 30 * 1000)).toBe('just now')
  })
  it('1-60 分钟 → Xm ago', () => {
    expect(relativeTime(now - 5 * 60 * 1000)).toBe('5m ago')
  })
  it('1-24 小时 → Xh ago', () => {
    expect(relativeTime(now - 3 * 60 * 60 * 1000)).toBe('3h ago')
  })
  it('1-7 天 → Xd ago', () => {
    expect(relativeTime(now - 2 * 24 * 60 * 60 * 1000)).toBe('2d ago')
  })
  it('>= 7 天 → YYYY-MM-DD', () => {
    const past = new Date('2020-01-15T10:00:00')
    expect(relativeTime(past.getTime())).toBe('2020-01-15')
  })
  it('支持 ISO 字符串输入', () => {
    const past = new Date('2020-01-15T10:00:00').toISOString()
    expect(relativeTime(past)).toBe('2020-01-15')
  })
})
