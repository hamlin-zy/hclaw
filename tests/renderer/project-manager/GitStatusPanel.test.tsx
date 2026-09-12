// @vitest-environment jsdom
import '@testing-library/jest-dom'
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {render, screen, fireEvent, waitFor} from '@testing-library/react'
import {GitStatusPanel} from '../../../src/renderer/project-manager/components/GitStatusPanel'
import {useGitStatusStore} from '../../../src/renderer/project-manager/stores/gitStatusStore'
import {useGitLogStore} from '../../../src/renderer/project-manager/stores/gitLogStore'
import {confirm, confirmWithInput} from '../../../src/renderer/components/ConfirmDialog'

// 原生 confirm/alert 已迁移到 ConfirmDialog 命令式原语（本文件打桩其 confirm）
vi.mock('../../../src/renderer/components/ConfirmDialog', () => ({
  confirm: vi.fn(async () => false),
  confirmWithInput: vi.fn(async () => null),
  default: () => null,
}))
const confirmMock = vi.mocked(confirm)
const confirmWithInputMock = vi.mocked(confirmWithInput)

// zustand 的 set() 会把 spy 烘焙进新的 state 对象（refresh/loadInitial 内部会 set），
// 导致 spy 跨用例泄漏到后续 store 对象上；每例前还原真实实现，保证 spy 断言互不污染。
const realRefresh = useGitStatusStore.getState().refresh
const realLoadInitial = useGitLogStore.getState().loadInitial

beforeEach(() => {
  useGitStatusStore.setState({refresh: realRefresh})
  useGitLogStore.setState({loadInitial: realLoadInitial})
  confirmMock.mockReset()
  confirmMock.mockResolvedValue(false)
  confirmWithInputMock.mockReset()
  confirmWithInputMock.mockResolvedValue(null)
  ;(window as any).electronAPI = {projectManager: {
    gitAdd: vi.fn(async () => {}),
    gitStatus: vi.fn(async () => ({statusMap: {}, additions: 0, deletions: 0, updatedAt: 1})),
    gitRmCached: vi.fn(async () => {}),
    gitCommit: vi.fn(async () => {}),
    gitPush: vi.fn(async () => {}),
    deletePath: vi.fn(async () => {}),
    gitDiscard: vi.fn(async () => {}),
    gitDiffFile: vi.fn(async () => ({filePath: 'm.ts', oldContent: '', newContent: '', diffType: 'working-tree', oldRef: 'HEAD', newRef: 'worktree', additions: 0, deletions: 0})),
    readFile: vi.fn(async () => ({path: 'u.txt', size: 1, content: 'x', isBinary: false, isImage: false, decodeError: false, mimeType: '', truncated: false, mtime: 0, hash: 'h'})),
  }}
  useGitStatusStore.setState({
    summary: {statusMap: {
      'm.ts': {path: 'm.ts', status: 'M', indexStatus: ' ', worktreeStatus: 'M'},
      'u.txt': {path: 'u.txt', status: '??', indexStatus: '?', worktreeStatus: '?'},
    }, additions: 1, deletions: 0, updatedAt: 1},
    loading: false,
  })
})

describe('GitStatusPanel', () => {
  it('渲染分组与统计', () => {
    render(<GitStatusPanel workspace="/ws" />)
    expect(screen.getByText(/已修改/)).toBeInTheDocument()
    expect(screen.getByText(/未跟踪文件/)).toBeInTheDocument()
    expect(screen.getByText('m.ts')).toBeInTheDocument()
  })
  it('双击已跟踪文件打开 Diff tab', async () => {
    const {useEditorTabStore} = await import('../../../src/renderer/project-manager/stores/editorTabStore')
    render(<GitStatusPanel workspace="/ws" />)
    fireEvent.doubleClick(screen.getByText('m.ts'))
    expect((window as any).electronAPI.projectManager.gitDiffFile).toHaveBeenCalled()
    await waitFor(() => expect(useEditorTabStore.getState().tabs.some(t => t.type === 'diff')).toBe(true))
  })
  it('双击 Untracked 标题批量 add 前弹确认', async () => {
    render(<GitStatusPanel workspace="/ws" />)
    fireEvent.doubleClick(screen.getByText(/未跟踪文件/))
    await waitFor(() => expect(confirmMock).toHaveBeenCalled())
    expect((window as any).electronAPI.projectManager.gitAdd).not.toHaveBeenCalled()
  })
  it('编辑区打开 >5MB 未跟踪文件时占位（content 空、title 含"过大"）', async () => {
    ;((window as any).electronAPI.projectManager.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
      {path: 'huge.bin', size: 6 * 1024 * 1024, content: null, isBinary: true, isImage: false, decodeError: false, mimeType: '', truncated: false, mtime: 0, hash: ''})
    useGitStatusStore.setState({
      summary: {statusMap: {'huge.bin': {path: 'huge.bin', status: '??', indexStatus: '?', worktreeStatus: '?'}}, additions: 0, deletions: 0, updatedAt: 1},
      loading: false,
    })
    const {useEditorTabStore} = await import('../../../src/renderer/project-manager/stores/editorTabStore')
    render(<GitStatusPanel workspace="/ws" />)
    fireEvent.doubleClick(screen.getByText('huge.bin'))
    await waitFor(() => expect(useEditorTabStore.getState().tabs.some(t => t.type === 'file')).toBe(true))
    const tab = useEditorTabStore.getState().tabs.find(t => t.type === 'file')!
    expect(tab.title).toContain('过大')
    expect(tab.content).toBe('')
    expect(tab.size).toBe(6 * 1024 * 1024)
  })
  it('I1: 双击已删除文件 diff 失败时提示（不 unhandled rejection）', async () => {
    ;((window as any).electronAPI.projectManager.gitDiffFile as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ENOENT'))
    useGitStatusStore.setState({
      summary: {statusMap: {'gone.ts': {path: 'gone.ts', status: 'D', indexStatus: 'D', worktreeStatus: ' '}}, additions: 0, deletions: 0, updatedAt: 1},
      loading: false,
    })
    render(<GitStatusPanel workspace="/ws" />)
    fireEvent.doubleClick(screen.getByText('gone.ts'))
    await waitFor(() => expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({title: '无法加载 diff'})))
  })

  it('含嵌套目录时渲染目录分组（默认展开）+ 文件行 paddingLeft 26px', async () => {
    useGitStatusStore.setState({
      summary: {statusMap: {
        'src/a.ts': {path: 'src/a.ts', status: 'M', indexStatus: ' ', worktreeStatus: 'M'},
        'src/lib/b.ts': {path: 'src/lib/b.ts', status: 'M', indexStatus: ' ', worktreeStatus: 'M'},
        'src/lib/c.ts': {path: 'src/lib/c.ts', status: 'M', indexStatus: ' ', worktreeStatus: 'M'},
      }, additions: 0, deletions: 0, updatedAt: 2},
      loading: false,
    })
    render(<GitStatusPanel workspace="/ws" />)
    // 目录分组行：src (1) + src/lib (2)
    expect(screen.getByText(/src \(1\)/)).toBeInTheDocument()
    expect(screen.getByText(/src\/lib \(2\)/)).toBeInTheDocument()
    // 文件行默认展开可见（行内只显示文件名，完整路径在 aria-label 上）
    expect(screen.getByRole('treeitem', {name: 'src/a.ts'})).toBeInTheDocument()
    expect(screen.getByRole('treeitem', {name: 'src/lib/b.ts'})).toBeInTheDocument()
    expect(screen.getByRole('treeitem', {name: 'src/lib/c.ts'})).toBeInTheDocument()
    // 文件行 padding 13px × 2 层 = 26px（在目录分组内缩进，spec §13.3）
    expect(screen.getByRole('treeitem', {name: 'src/a.ts'})).toHaveStyle({paddingLeft: '26px'})
    // 目录行可折叠
    fireEvent.click(screen.getByText(/src\/lib \(2\)/))
    expect(screen.queryByRole('treeitem', {name: 'src/lib/b.ts'})).not.toBeInTheDocument()
    expect(screen.queryByRole('treeitem', {name: 'src/lib/c.ts'})).not.toBeInTheDocument()
    // 折叠 src/lib 不影响 src 组
    expect(screen.getByRole('treeitem', {name: 'src/a.ts'})).toBeInTheDocument()
  })

  it('I2 切换 workspace 后双击已跟踪文件 diff 迟到结果被丢弃', async () => {
    const api = (window as any).electronAPI.projectManager
    let resolveDiff: (v: unknown) => void = () => {}
    api.gitDiffFile.mockImplementation(() => new Promise(res => { resolveDiff = res }))
    const {useEditorTabStore} = await import('../../../src/renderer/project-manager/stores/editorTabStore')
    useEditorTabStore.setState({tabs: [], activeTabId: null})
    const {rerender} = render(<GitStatusPanel workspace="/ws" />)
    fireEvent.doubleClick(screen.getByText('m.ts'))
    // 请求在途时切到另一个 workspace
    rerender(<GitStatusPanel workspace="/ws2" />)
    resolveDiff({filePath: 'm.ts', oldContent: '', newContent: '', diffType: 'working-tree', oldRef: 'HEAD', newRef: 'worktree', additions: 0, deletions: 0})
    await new Promise(r => setTimeout(r, 0))
    expect(useEditorTabStore.getState().tabs.some(t => t.type === 'diff')).toBe(false)
  })

  it('I3 切换 workspace 后双击未跟踪文件 openFile 迟到结果被丢弃', async () => {
    const api = (window as any).electronAPI.projectManager
    let resolveRead: (v: unknown) => void = () => {}
    api.readFile.mockImplementation(() => new Promise(res => { resolveRead = res }))
    const {useEditorTabStore} = await import('../../../src/renderer/project-manager/stores/editorTabStore')
    useEditorTabStore.setState({tabs: [], activeTabId: null})
    const {rerender} = render(<GitStatusPanel workspace="/ws" />)
    fireEvent.doubleClick(screen.getByText('u.txt'))
    rerender(<GitStatusPanel workspace="/ws2" />)
    resolveRead({path: 'u.txt', size: 1, content: 'x', isBinary: false, isImage: false, decodeError: false, mimeType: '', truncated: false, mtime: 0, hash: 'h'})
    await new Promise(r => setTimeout(r, 0))
    expect(useEditorTabStore.getState().tabs).toHaveLength(0)
  })

  it('I4 切换 workspace 后批量 add 迟到不刷新旧仓库', async () => {
    confirmMock.mockResolvedValue(true)
    const refreshSpy = vi.spyOn(useGitStatusStore.getState(), 'refresh').mockImplementation(async () => {})
    const api = (window as any).electronAPI.projectManager
    let resolveAdd: (v: unknown) => void = () => {}
    api.gitAdd.mockImplementation(() => new Promise(res => { resolveAdd = res }))
    const {rerender} = render(<GitStatusPanel workspace="/ws" />)
    fireEvent.doubleClick(screen.getByText(/未跟踪文件/))
    await waitFor(() => expect(api.gitAdd).toHaveBeenCalled())
    rerender(<GitStatusPanel workspace="/ws2" />)
    resolveAdd(undefined)
    await new Promise(r => setTimeout(r, 0))
    expect(refreshSpy).not.toHaveBeenCalled()
    refreshSpy.mockRestore()
  })
})

describe('变更列表提交区（R2 / spec §2.2）', () => {
  const setSummary = (statusMap: Record<string, unknown>) =>
    useGitStatusStore.setState({summary: {statusMap, additions: 0, deletions: 0, updatedAt: 1} as never})

  it('A5 changed === 0 → 不渲染按钮行', () => {
    setSummary({})
    render(<GitStatusPanel workspace="/ws" />)
    expect(screen.queryByTestId('pm-changes-actions')).toBeNull()
  })

  it('A6 只有未跟踪 → 两按钮存在、aria-disabled=true、title 含「加入 Git 跟踪」', () => {
    setSummary({'u.txt': {path: 'u.txt', status: '??', indexStatus: '?', worktreeStatus: '?'}})
    render(<GitStatusPanel workspace="/ws" />)
    expect(screen.getByTestId('pm-changes-actions')).toBeInTheDocument()
    for (const name of ['提交', '提交并推送']) {
      const btn = screen.getByRole('button', {name})
      expect(btn).toHaveAttribute('aria-disabled', 'true')
      expect(btn).toHaveAttribute('title', expect.stringContaining('加入 Git 跟踪'))
    }
  })

  it('A7 混合态（1 个 M + 1 个 ??）→ 按钮可用（判定式是 status !== "??"）', () => {
    setSummary({
      'm.ts': {path: 'm.ts', status: 'M', indexStatus: ' ', worktreeStatus: 'M'},
      'u.txt': {path: 'u.txt', status: '??', indexStatus: '?', worktreeStatus: '?'},
    })
    render(<GitStatusPanel workspace="/ws" />)
    expect(screen.getByRole('button', {name: '提交'})).toHaveAttribute('aria-disabled', 'false')
  })

  it('A8 有已跟踪变更 → 两按钮可用', () => {
    setSummary({'m.ts': {path: 'm.ts', status: 'M', indexStatus: ' ', worktreeStatus: 'M'}})
    render(<GitStatusPanel workspace="/ws" />)
    for (const name of ['提交', '提交并推送']) {
      expect(screen.getByRole('button', {name})).toHaveAttribute('aria-disabled', 'false')
    }
  })
})
describe('提交流程（R2 / spec §4.4）', () => {
  const pm = () => (window as any).electronAPI.projectManager
  const tracked = {'m.ts': {path: 'm.ts', status: 'M', indexStatus: ' ', worktreeStatus: 'M'}}
  const setSummary = (statusMap: Record<string, unknown>) =>
    useGitStatusStore.setState({summary: {statusMap, additions: 0, deletions: 0, updatedAt: 1} as never})

  it('A13 提交成功 → 调 gitCommit 一次，随后 refresh 与 loadInitial', async () => {
    setSummary(tracked)
    confirmWithInputMock.mockResolvedValue('feat: x')
    const refreshSpy = vi.spyOn(useGitStatusStore.getState(), 'refresh').mockResolvedValue(undefined)
    const {useGitLogStore} = await import('../../../src/renderer/project-manager/stores/gitLogStore')
    const loadSpy = vi.spyOn(useGitLogStore.getState(), 'loadInitial').mockResolvedValue(undefined)
    render(<GitStatusPanel workspace="/ws" />)
    fireEvent.click(screen.getByRole('button', {name: '提交'}))
    await waitFor(() => expect(pm().gitCommit).toHaveBeenCalledWith('/ws', 'feat: x'))
    await waitFor(() => expect(refreshSpy).toHaveBeenCalledWith('/ws'))
    expect(loadSpy).toHaveBeenCalledWith('/ws')
    expect(pm().gitPush).not.toHaveBeenCalled()
    refreshSpy.mockRestore(); loadSpy.mockRestore()
  })

  it('A14 取消（confirmWithInput 返回 null）→ 零写调用、零刷新', async () => {
    setSummary(tracked)
    confirmWithInputMock.mockResolvedValue(null)
    const refreshSpy = vi.spyOn(useGitStatusStore.getState(), 'refresh').mockResolvedValue(undefined)
    render(<GitStatusPanel workspace="/ws" />)
    fireEvent.click(screen.getByRole('button', {name: '提交'}))
    await waitFor(() => expect(confirmWithInputMock).toHaveBeenCalled())
    expect(pm().gitCommit).not.toHaveBeenCalled()
    expect(refreshSpy).not.toHaveBeenCalled()
    refreshSpy.mockRestore()
  })

  it('A15 提交失败 → 弹「提交失败」，且 refresh / loadInitial 均未调用', async () => {
    setSummary(tracked)
    confirmWithInputMock.mockResolvedValue('feat: x')
    pm().gitCommit.mockRejectedValue(new Error('nothing to commit'))
    const refreshSpy = vi.spyOn(useGitStatusStore.getState(), 'refresh').mockResolvedValue(undefined)
    const {useGitLogStore} = await import('../../../src/renderer/project-manager/stores/gitLogStore')
    const loadSpy = vi.spyOn(useGitLogStore.getState(), 'loadInitial').mockResolvedValue(undefined)
    render(<GitStatusPanel workspace="/ws" />)
    fireEvent.click(screen.getByRole('button', {name: '提交'}))
    await waitFor(() => expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({title: '提交失败'})))
    expect(refreshSpy).not.toHaveBeenCalled()
    expect(loadSpy).not.toHaveBeenCalled()
    refreshSpy.mockRestore(); loadSpy.mockRestore()
  })

  it('A10 失败后按钮恢复可用、文案回退', async () => {
    setSummary(tracked)
    confirmWithInputMock.mockResolvedValue('m')
    pm().gitCommit.mockRejectedValue(new Error('boom'))
    render(<GitStatusPanel workspace="/ws" />)
    fireEvent.click(screen.getByRole('button', {name: '提交'}))
    await waitFor(() => expect(confirmMock).toHaveBeenCalled())
    expect(screen.getByRole('button', {name: '提交'})).toHaveAttribute('aria-disabled', 'false')
  })

  it('A9+A16 提交并推送 → gitCommit 先于 gitPush，进行中显示「推送中…」', async () => {
    setSummary(tracked)
    confirmWithInputMock.mockResolvedValue('m')
    const order: string[] = []
    pm().gitCommit.mockImplementation(async () => { order.push('commit') })
    let releasePush: () => void = () => {}
    pm().gitPush.mockImplementation(() => { order.push('push'); return new Promise<void>(res => { releasePush = res }) })
    const refreshSpy = vi.spyOn(useGitStatusStore.getState(), 'refresh').mockResolvedValue(undefined)
    const {useGitLogStore} = await import('../../../src/renderer/project-manager/stores/gitLogStore')
    const loadSpy = vi.spyOn(useGitLogStore.getState(), 'loadInitial').mockResolvedValue(undefined)
    render(<GitStatusPanel workspace="/ws" />)
    fireEvent.click(screen.getByRole('button', {name: '提交并推送'}))
    await waitFor(() => expect(screen.getByText('推送中…')).toBeInTheDocument())
    expect(order).toEqual(['commit', 'push'])
    releasePush()
    await waitFor(() => expect(screen.getByRole('button', {name: '提交并推送'})).toBeInTheDocument())
    refreshSpy.mockRestore(); loadSpy.mockRestore()
  })

  it('A17 commit 成功 + push 失败 → 弹「提交成功，但推送失败」，refresh 仍被调用、busy 复位', async () => {
    setSummary(tracked)
    confirmWithInputMock.mockResolvedValue('m')
    pm().gitPush.mockRejectedValue(new Error('rejected by remote'))
    const refreshSpy = vi.spyOn(useGitStatusStore.getState(), 'refresh').mockResolvedValue(undefined)
    const {useGitLogStore} = await import('../../../src/renderer/project-manager/stores/gitLogStore')
    const loadSpy = vi.spyOn(useGitLogStore.getState(), 'loadInitial').mockResolvedValue(undefined)
    render(<GitStatusPanel workspace="/ws" />)
    fireEvent.click(screen.getByRole('button', {name: '提交并推送'}))
    await waitFor(() => expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({title: '提交成功，但推送失败'})))
    expect(refreshSpy).toHaveBeenCalledWith('/ws')
    expect(loadSpy).toHaveBeenCalledWith('/ws')
    expect(screen.getByRole('button', {name: '提交'})).toHaveAttribute('aria-disabled', 'false')
    refreshSpy.mockRestore(); loadSpy.mockRestore()
  })

  it('A11 同按钮防重入：进行中重复点击不产生第二次调用', async () => {
    setSummary(tracked)
    confirmWithInputMock.mockResolvedValue('m')
    let release: () => void = () => {}
    pm().gitCommit.mockImplementation(() => new Promise<void>(res => { release = res }))
    render(<GitStatusPanel workspace="/ws" />)
    fireEvent.click(screen.getByRole('button', {name: '提交'}))
    await waitFor(() => expect(pm().gitCommit).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', {name: '提交'}))
    expect(pm().gitCommit).toHaveBeenCalledTimes(1)
    release()
  })

  it('A12 跨按钮防重入：commit 在途时点「提交并推送」→ gitPush 不被调用', async () => {
    setSummary(tracked)
    confirmWithInputMock.mockResolvedValue('m')
    let release: () => void = () => {}
    pm().gitCommit.mockImplementation(() => new Promise<void>(res => { release = res }))
    render(<GitStatusPanel workspace="/ws" />)
    fireEvent.click(screen.getByRole('button', {name: '提交'}))
    await waitFor(() => expect(pm().gitCommit).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', {name: '提交并推送'}))
    expect(pm().gitPush).not.toHaveBeenCalled()
    release()
  })

  it('A18 归属守卫：commit 在途切 workspace → 不 refresh / 不 loadInitial / 不bumpRefs / 不弹错误框', async () => {
    setSummary(tracked)
    confirmWithInputMock.mockResolvedValue('m')
    let rejectCommit: (e: Error) => void = () => {}
    pm().gitCommit.mockImplementation(() => new Promise<void>((_res, rej) => { rejectCommit = rej }))
    const refreshSpy = vi.spyOn(useGitStatusStore.getState(), 'refresh').mockResolvedValue(undefined)
    const bumpSpy = vi.spyOn(useGitStatusStore.getState(), 'bumpRefs')
    const {useGitLogStore} = await import('../../../src/renderer/project-manager/stores/gitLogStore')
    const loadSpy = vi.spyOn(useGitLogStore.getState(), 'loadInitial').mockResolvedValue(undefined)
    const {rerender} = render(<GitStatusPanel workspace="/ws" />)
    fireEvent.click(screen.getByRole('button', {name: '提交'}))
    await waitFor(() => expect(pm().gitCommit).toHaveBeenCalled())
    rerender(<GitStatusPanel workspace="/ws2" />)
    rejectCommit(new Error('boom'))
    await new Promise(r => setTimeout(r, 0))
    expect(refreshSpy).not.toHaveBeenCalled()
    expect(loadSpy).not.toHaveBeenCalled()
    expect(bumpSpy).not.toHaveBeenCalled()
    expect(confirmMock).not.toHaveBeenCalled()
    refreshSpy.mockRestore(); bumpSpy.mockRestore(); loadSpy.mockRestore()
  })
})

describe('变更列表头部手动刷新（C）', () => {
  it('头部渲染「刷新」按钮（与文件树头部同款图标按钮）', () => {
    render(<GitStatusPanel workspace="/ws" />)
    expect(screen.getByTestId('pm-changes-header')).toContainElement(screen.getByRole('button', {name: '刷新'}))
  })

  it('点击刷新 → 按当前 workspace 调 gitStatus', async () => {
    render(<GitStatusPanel workspace="/ws" />)
    fireEvent.click(screen.getByRole('button', {name: '刷新'}))
    await waitFor(() => expect((window as any).electronAPI.projectManager.gitStatus).toHaveBeenCalledWith('/ws'))
  })

  it('loading 时按钮禁用', () => {
    useGitStatusStore.setState({loading: true})
    render(<GitStatusPanel workspace="/ws" />)
    expect(screen.getByRole('button', {name: '刷新'})).toBeDisabled()
  })
})

describe('GitStatusPanel 右键删除/丢弃（danger）', () => {
  it('未跟踪文件菜单含「删除文件」，确认后调用 deletePath', async () => {
    confirmMock.mockResolvedValue(true)
    render(<GitStatusPanel workspace="/ws" />)
    fireEvent.contextMenu(screen.getByRole('treeitem', {name: 'u.txt'}))
    const item = screen.getByRole('menuitem', {name: '删除文件'})
    expect(item).toHaveClass('pm-context-menu-item--danger')
    fireEvent.click(item)
    await waitFor(() => expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({
      title: '删除文件', confirmVariant: 'danger',
    })))
    await waitFor(() => expect((window as any).electronAPI.projectManager.deletePath).toHaveBeenCalledWith('/ws', 'u.txt'))
  })

  it('已跟踪文件菜单含「丢弃更改」与「删除文件」', async () => {
    render(<GitStatusPanel workspace="/ws" />)
    fireEvent.contextMenu(screen.getByRole('treeitem', {name: 'm.ts'}))
    expect(screen.getByRole('menuitem', {name: '丢弃更改'})).toHaveClass('pm-context-menu-item--danger')
    expect(screen.getByRole('menuitem', {name: '删除文件'})).toHaveClass('pm-context-menu-item--danger')
  })

  it('「丢弃更改」确认后调用 gitDiscard（带 status）', async () => {
    confirmMock.mockResolvedValue(true)
    render(<GitStatusPanel workspace="/ws" />)
    fireEvent.contextMenu(screen.getByRole('treeitem', {name: 'm.ts'}))
    fireEvent.click(screen.getByRole('menuitem', {name: '丢弃更改'}))
    await waitFor(() => expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({
      title: '丢弃更改', confirmText: '丢弃', confirmVariant: 'danger',
    })))
    await waitFor(() => expect((window as any).electronAPI.projectManager.gitDiscard).toHaveBeenCalledWith('/ws', 'm.ts', 'M'))
  })

  it('取消确认时不调用 gitDiscard', async () => {
    render(<GitStatusPanel workspace="/ws" />)
    fireEvent.contextMenu(screen.getByRole('treeitem', {name: 'm.ts'}))
    fireEvent.click(screen.getByRole('menuitem', {name: '丢弃更改'}))
    await waitFor(() => expect(confirmMock).toHaveBeenCalled())
    expect((window as any).electronAPI.projectManager.gitDiscard).not.toHaveBeenCalled()
  })
})
