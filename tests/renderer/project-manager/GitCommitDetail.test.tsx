// @vitest-environment jsdom
import '@testing-library/jest-dom'
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {render, screen, fireEvent, waitFor} from '@testing-library/react'
import {GitCommitDetail} from '../../../src/renderer/project-manager/components/GitCommitDetail'
import {useGitLogStore} from '../../../src/renderer/project-manager/stores/gitLogStore'
import {useEditorTabStore} from '../../../src/renderer/project-manager/stores/editorTabStore'
import type {GitCommitFiles} from '../../../src/shared/types/project-manager'

const flush = () => new Promise(r => setTimeout(r, 0))

const entryOf = (hash: string) => ({
  hash, abbreviatedHash: hash.slice(0, 8), parents: [], message: `msg-${hash}`, body: '',
  author: '', authorEmail: '', authorDate: 0, date: 0, branches: [], tags: [], isHead: false,
})

const showResultOf = (hash: string, paths: string[]): GitCommitFiles => ({
  hash, message: `msg-${hash}`,
  files: paths.map(p => ({path: p, status: 'M', additions: 0, deletions: 0})),
})

beforeEach(() => {
  ;(window as any).electronAPI = {projectManager: {
    gitShowCommit: vi.fn(async () => showResultOf('abc123', ['src/a.ts', 'src/lib/b.ts'])),
    gitDiffFile: vi.fn(async () => ({filePath: 'src/a.ts', oldContent: '', newContent: '', diffType: 'commit', oldRef: 'abc123^', newRef: 'abc123', additions: 0, deletions: 0})),
    gitShowDetail: vi.fn(async () => 'show text'),
  }}
  useGitLogStore.setState({selectedHash: 'abc123', entries: [entryOf('abc123')], loading: false, hasMore: true, lastOptions: null})
  useEditorTabStore.setState({tabs: [], activeTabId: null})
})

describe('GitCommitDetail', () => {
  it('按路径聚合渲染文件树', async () => {
    render(<GitCommitDetail workspace="/ws" />)
    expect(await screen.findByText(/已更改 2 个文件/)).toBeInTheDocument()
    expect(screen.getByText('a.ts')).toBeInTheDocument()
    expect(screen.getByText('b.ts')).toBeInTheDocument()
  })

  it('双击文件打开 commit 级 Diff tab', async () => {
    render(<GitCommitDetail workspace="/ws" />)
    fireEvent.doubleClick(await screen.findByText('a.ts'))
    const tab = useEditorTabStore.getState().tabs[0]!
    expect(tab.type).toBe('diff')
    expect(tab.diffType).toBe('commit')
    expect(tab.ref).toBe('abc123')
  })

  it('I1 竞态守卫：快速切换 commit 后旧迟到结果被丢弃且不写缓存', async () => {
    let resolveA: (v: GitCommitFiles) => void = () => {}
    const api = (window as any).electronAPI.projectManager
    api.gitShowCommit.mockImplementation((ws: string, hash: string) => new Promise(res => {
      if (hash === 'aaa') resolveA = res
      else res(showResultOf(hash, [`${hash}.ts`]))
    }))
    const {rerender} = render(<GitCommitDetail workspace="/ws" />)
    useGitLogStore.setState({selectedHash: 'aaa', entries: [entryOf('abc123'), entryOf('aaa')]})
    rerender(<GitCommitDetail workspace="/ws" />)
    // 立即切走，aaa 的 gitShowCommit 迟迟未决
    useGitLogStore.setState({selectedHash: 'bbb', entries: [entryOf('abc123'), entryOf('aaa'), entryOf('bbb')]})
    rerender(<GitCommitDetail workspace="/ws" />)
    await flush()
    resolveA(showResultOf('aaa', ['stale-file.ts']))
    await flush()
    // 过期结果不渲染，也不触发针对 aaa 的预取
    expect(screen.queryByText('stale-file.ts')).not.toBeInTheDocument()
    const prefetchCalls = api.gitDiffFile.mock.calls.filter(([, p]: any[]) => p === 'stale-file.ts')
    expect(prefetchCalls).toHaveLength(0)
    // 当前 commit bbb 的内容正常展示
    expect(await screen.findByText('bbb.ts')).toBeInTheDocument()
  })

  it('I2 文件数超过预取上限时不预取', async () => {
    ;(window as any).electronAPI.projectManager.gitShowCommit.mockResolvedValue(
      showResultOf('abc123', Array.from({length: 21}, (_, i) => `f${i}.ts`)))
    render(<GitCommitDetail workspace="/ws" />)
    expect(await screen.findByText(/已更改 21 个文件/)).toBeInTheDocument()
    await flush()
    expect((window as any).electronAPI.projectManager.gitDiffFile).not.toHaveBeenCalled()
  })

  it('I3 预取失败后双击走异步兜底仍能打开 tab', async () => {
    const api = (window as any).electronAPI.projectManager
    let prefetched = false
    api.gitDiffFile.mockImplementation(() => {
      // 预取阶段失败，兜底阶段成功
      if (!prefetched) { prefetched = true; return Promise.reject(new Error('boom')) }
      return Promise.resolve({filePath: 'src/a.ts', oldContent: '', newContent: '', diffType: 'commit', oldRef: 'abc123^', newRef: 'abc123', additions: 0, deletions: 0})
    })
    render(<GitCommitDetail workspace="/ws" />)
    const row = await screen.findByText('a.ts')
    await flush() // 等预取失败
    expect(api.gitDiffFile).toHaveBeenCalledTimes(2) // 两个文件预取均失败被 catch，不抛未处理拒绝
    fireEvent.doubleClick(row)
    await waitFor(() => expect(useEditorTabStore.getState().tabs).toHaveLength(1))
    expect(useEditorTabStore.getState().tabs[0]!.ref).toBe('abc123')
  })

  it('I4 Compare with HEAD 有选中文件时可用，from/to 语义正确', async () => {
    render(<GitCommitDetail workspace="/ws" />)
    const btn = await screen.findByRole('button', {name: '与 HEAD 比较'})
    await waitFor(() => expect(btn).not.toBeDisabled()) // 默认选中第一个文件
    fireEvent.click(btn)
    expect((window as any).electronAPI.projectManager.gitDiffFile).toHaveBeenCalledWith('/ws', 'src/a.ts', {from: 'abc123', to: 'HEAD'})
    await flush()
    const tab = useEditorTabStore.getState().tabs[0]!
    expect(tab.ref).toBe('abc123..HEAD')
  })

  it('I4 Compare with HEAD 与双击 tab 不撞键：同文件两个 tab 并存', async () => {
    render(<GitCommitDetail workspace="/ws" />)
    const row = await screen.findByText('a.ts')
    await flush() // 等预取写入缓存
    fireEvent.doubleClick(row)
    const btn = screen.getByRole('button', {name: '与 HEAD 比较'})
    fireEvent.click(btn)
    await flush()
    const tabs = useEditorTabStore.getState().tabs
    expect(tabs).toHaveLength(2)
    expect(new Set(tabs.map(t => `${t.filePath}:${t.ref}`)).size).toBe(2)
    expect(tabs.map(t => t.ref).sort()).toEqual(['abc123', 'abc123..HEAD'])
  })

  it('I4 Compare with HEAD 无选中文件时禁用', async () => {
    ;(window as any).electronAPI.projectManager.gitShowCommit.mockResolvedValue(showResultOf('abc123', []))
    render(<GitCommitDetail workspace="/ws" />)
    expect(await screen.findByRole('button', {name: '与 HEAD 比较'})).toBeDisabled()
  })

  it('文件行选中态：.is-selected 底 + 左竖条，状态色走 --vcs-* 令牌', async () => {
    render(<GitCommitDetail workspace="/ws" />)
    // 默认首个文件被选中（TreeRow 的选中态是 .is-selected 类，底/竖条由样式表提供）
    const row = await screen.findByRole('treeitem', {name: 'src/a.ts'})
    expect(row).toHaveClass('is-selected')
    // 状态色保留：状态类与 pm-file-name 同挂标签 span（.pm-c--M.pm-file-name 复合规则才生效）
    expect(row.querySelector('.pm-file-name')).toHaveClass('pm-c--M')
  })

  it('点击另一个文件切换选中态', async () => {
    render(<GitCommitDetail workspace="/ws" />)
    const a = await screen.findByRole('treeitem', {name: 'src/a.ts'})
    const b = screen.getByRole('treeitem', {name: 'src/lib/b.ts'})
    expect(a).toHaveClass('is-selected')
    // 点击 b.ts
    fireEvent.click(b)
    expect(a).not.toHaveClass('is-selected')
    expect(b).toHaveClass('is-selected')
  })

  it('目录行可折叠：点击后文件行隐藏，再点展开', async () => {
    render(<GitCommitDetail workspace="/ws" />)
    // mock: 两个文件在不同目录（src/ 与 src/lib/）
    // 默认展开：可见文件行
    const dirRows = await screen.findAllByText(/个文件）$/)
    expect(dirRows.length).toBeGreaterThanOrEqual(1)
    // 定位首个目录行（src 组，含 a.ts）
    const dirRow = dirRows.find(el => el.textContent?.includes('src（1 个文件）'))!
    expect(screen.getByText('a.ts')).toBeInTheDocument()
    expect(screen.getByText('b.ts')).toBeInTheDocument()
    // 点击目录行折叠：src 目录下的 a.ts 消失，src/lib 目录下的 b.ts 仍在
    fireEvent.click(dirRow)
    expect(screen.queryByText('a.ts')).not.toBeInTheDocument()
    expect(screen.getByText('b.ts')).toBeInTheDocument()
    // 再点展开
    fireEvent.click(screen.getByText(/src（1 个文件）/))
    expect(screen.getByText('a.ts')).toBeInTheDocument()
  })

  it('目录折叠回归：文件行选中态、双击、Compare with HEAD 保持工作', async () => {
    render(<GitCommitDetail workspace="/ws" />)
    // 折叠 src 目录再展开（不影响其他目录）
    const dirRows = await screen.findAllByText(/个文件）$/)
    const dirRow = dirRows.find(el => el.textContent?.includes('src（1 个文件）'))!
    fireEvent.click(dirRow)
    fireEvent.click(screen.getByText(/src（1 个文件）/))
    // 双击文件仍能打开 Diff tab
    const row = await screen.findByText('a.ts')
    fireEvent.doubleClick(row)
    await waitFor(() => expect(useEditorTabStore.getState().tabs).toHaveLength(1))
    expect(useEditorTabStore.getState().tabs[0]!.type).toBe('diff')
    // Compare with HEAD 按钮仍可用（选中态保留）
    const btn = screen.getByRole('button', {name: '与 HEAD 比较'})
    expect(btn).not.toBeDisabled()
  })

  it('中段滚动容器：.pm-detail-scroll 存在并承载主体内容（flex/overflow 声明见 globals.css）', async () => {
    const {container} = render(<GitCommitDetail workspace="/ws" />)
    await screen.findByText(/已更改/)
    // 仅断言容器存在：flex:1 / overflow:auto / min-height:0 由 globals.css 的 .pm-detail-scroll 承担，
    // jsdom 不加载样式表，查询到该类名并不证明任何声明生效，故不再写自证的 toHaveClass
    const scrollContainer = container.querySelector('.pm-detail-scroll')
    expect(scrollContainer).not.toBeNull()
  })

  it('I5 切换 workspace 后双击兜底 diff 迟到结果被丢弃', async () => {
    const api = (window as any).electronAPI.projectManager
    // >20 文件不预取 → 双击走异步兜底
    api.gitShowCommit.mockResolvedValue(showResultOf('abc123', Array.from({length: 21}, (_, i) => `f${i}.ts`)))
    let resolveDiff: (v: unknown) => void = () => {}
    api.gitDiffFile.mockImplementation(() => new Promise(res => { resolveDiff = res }))
    const {rerender} = render(<GitCommitDetail workspace="/ws" />)
    await screen.findByText(/已更改 21 个文件/)
    fireEvent.doubleClick(screen.getByText('f0.ts'))
    // 请求在途时切到另一个 workspace
    rerender(<GitCommitDetail workspace="/ws2" />)
    resolveDiff({filePath: 'f0.ts', oldContent: '', newContent: '', diffType: 'commit', oldRef: 'x', newRef: 'y', additions: 0, deletions: 0})
    await flush()
    // 旧仓库的 diff 不得写入新仓库
    expect(useEditorTabStore.getState().tabs).toHaveLength(0)
  })

  it('I6 切换 workspace 后 Show in Terminal 迟到结果被丢弃', async () => {
    const api = (window as any).electronAPI.projectManager
    let resolveShow: (v: string) => void = () => {}
    api.gitShowDetail.mockImplementation(() => new Promise(res => { resolveShow = res }))
    const {rerender} = render(<GitCommitDetail workspace="/ws" />)
    await screen.findByText(/已更改 2 个文件/)
    fireEvent.click(screen.getByRole('button', {name: '在终端中显示'}))
    rerender(<GitCommitDetail workspace="/ws2" />)
    resolveShow('late text')
    await flush()
    expect(useEditorTabStore.getState().tabs).toHaveLength(0)
  })

  it('I7 切换 workspace 后 Compare with HEAD 迟到结果被丢弃', async () => {
    const api = (window as any).electronAPI.projectManager
    api.gitShowCommit.mockResolvedValue(showResultOf('abc123', Array.from({length: 21}, (_, i) => `f${i}.ts`)))
    let resolveDiff: (v: unknown) => void = () => {}
    api.gitDiffFile.mockImplementation(() => new Promise(res => { resolveDiff = res }))
    const {rerender} = render(<GitCommitDetail workspace="/ws" />)
    const btn = await screen.findByRole('button', {name: '与 HEAD 比较'})
    await waitFor(() => expect(btn).not.toBeDisabled())
    fireEvent.click(btn)
    rerender(<GitCommitDetail workspace="/ws2" />)
    resolveDiff({filePath: 'f0.ts', oldContent: '', newContent: '', diffType: 'commit', oldRef: 'x', newRef: 'y', additions: 0, deletions: 0})
    await flush()
    expect(useEditorTabStore.getState().tabs).toHaveLength(0)
  })
})
