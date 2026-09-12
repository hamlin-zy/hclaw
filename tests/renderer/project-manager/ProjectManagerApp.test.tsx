// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {render, screen, fireEvent, act, waitFor} from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import {ProjectManagerApp} from '../../../src/renderer/project-manager/ProjectManagerApp'
import {useEditorTabStore} from '../../../src/renderer/project-manager/stores/editorTabStore'
import {useFileTreeStore} from '../../../src/renderer/project-manager/stores/fileTreeStore'
import {useWorkspaceStore} from '../../../src/renderer/project-manager/stores/workspaceStore'
import {useGitStatusStore} from '../../../src/renderer/project-manager/stores/gitStatusStore'
import {useGitLogStore} from '../../../src/renderer/project-manager/stores/gitLogStore'

beforeEach(() => {
  ;(window as any).electronAPI = {
    projectManager: {
      workspacePath: '/ws',
      listDirectory: vi.fn(async () => []),
      readFile: vi.fn(async () => ({path: 'a.ts', size: 1, content: 'x', isBinary: false, isImage: false, decodeError: false, mimeType: '', truncated: false, mtime: 0, hash: 'h1'})),
      gitStatus: vi.fn(async () => ({statusMap: {}, additions: 0, deletions: 0, updatedAt: 1})),
      gitLog: vi.fn(async () => []),
      gitBranches: vi.fn(async () => []),
      gitDiffFile: vi.fn(async () => ({filePath: 'a.ts', oldContent: '', newContent: '', diffType: 'working-tree', oldRef: 'HEAD', newRef: 'worktree', additions: 0, deletions: 0})),
      gitShowCommit: vi.fn(async () => ({hash: '', message: '', files: []})),
      gitShowDetail: vi.fn(async () => ''),
      gitAdd: vi.fn(async () => {}),
      gitRmCached: vi.fn(async () => {}),
      onStatusChanged: vi.fn(() => () => {}),
      onRefsChanged: vi.fn(() => () => {}),
      onFileChanged: vi.fn(() => () => {}),
    },
  }
  localStorage.clear()
  useEditorTabStore.getState().closeAll()
  useFileTreeStore.setState({expanded: new Set(), childrenCache: {}, cacheOrder: [], selectedPath: null})
})

describe('ProjectManagerApp', () => {
  it('打开文件 tab 后显示 tab 标题并可关闭', () => {
    render(<ProjectManagerApp />)
    // zustand 更新需在 act 内才能同步 flush（React 18 concurrent）
    act(() => {
      useEditorTabStore.getState().openFileTab({path: 'a.ts', title: 'a.ts', content: 'x', hash: 'h1'})
    })
    expect(screen.getByText('a.ts')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', {name: /close-tab/i}))
    expect(useEditorTabStore.getState().tabs).toHaveLength(0)
  })
  it('订阅 status-changed 推送', () => {
    render(<ProjectManagerApp />)
    expect(window.electronAPI!.projectManager.onStatusChanged).toHaveBeenCalled()
    expect(window.electronAPI!.projectManager.onFileChanged).toHaveBeenCalled()
  })

  it('订阅 refs-changed：外部 commit/push 后重取变更列表 / 分支树，并置 commit 列表待刷新标记', () => {
    // spy 必须在 render 前安装：effect 闭包持有渲染时的 refresh 引用
    const refreshSpy = vi.spyOn(useGitStatusStore.getState(), 'refresh').mockResolvedValue(undefined)
    // commit 列表改为「延迟刷新」：这里只验证置标记这一步，消费由 GitDagGraph 负责
    const markSpy = vi.spyOn(useGitLogStore.getState(), 'markHeadRefresh')
    useGitLogStore.setState({pendingHeadRefresh: false})
    render(<ProjectManagerApp />)
    expect(window.electronAPI!.projectManager.onRefsChanged).toHaveBeenCalled()
    const cb = vi.mocked(window.electronAPI!.projectManager.onRefsChanged).mock.calls[0][0]
    refreshSpy.mockClear(); markSpy.mockClear()
    const refsBefore = useGitStatusStore.getState().refsVersion
    act(() => cb('/ws'))
    expect(refreshSpy).toHaveBeenCalledWith('/ws')
    expect(markSpy).toHaveBeenCalled()   // commit 列表待刷新标记（不直接 loadInitial）
    expect(useGitStatusStore.getState().refsVersion).toBe(refsBefore + 1)   // 分支树 / Git 区头部重取
    refreshSpy.mockRestore(); markSpy.mockRestore()
  })

  it('refs-changed 归属其他 workspace 时忽略', () => {
    const refreshSpy = vi.spyOn(useGitStatusStore.getState(), 'refresh').mockResolvedValue(undefined)
    const markSpy = vi.spyOn(useGitLogStore.getState(), 'markHeadRefresh')
    useGitLogStore.setState({pendingHeadRefresh: false})
    render(<ProjectManagerApp />)
    const cb = vi.mocked(window.electronAPI!.projectManager.onRefsChanged).mock.calls[0][0]
    refreshSpy.mockClear(); markSpy.mockClear()
    act(() => cb('/other'))
    expect(refreshSpy).not.toHaveBeenCalled()
    expect(markSpy).not.toHaveBeenCalled()
    refreshSpy.mockRestore(); markSpy.mockRestore()
  })

  it('file-changed 相对路径前缀命中：失效受影响目录缓存，保留无关目录', () => {
    const entry = (name: string, path: string, isDir: boolean) => ({name, path, isDir, size: 1, gitStatus: 'none' as const, hasChildren: isDir, ignored: false})
    useFileTreeStore.getState().setChildren('a', [entry('b', 'a/b', true)])
    useFileTreeStore.getState().setChildren('a/b', [entry('c.txt', 'a/b/c.txt', false)])
    useFileTreeStore.getState().setChildren('z', [entry('z.txt', 'z/z.txt', false)])
    render(<ProjectManagerApp />)
    const cb = vi.mocked(window.electronAPI!.projectManager.onFileChanged).mock.calls[0][0]
    act(() => cb('/ws', {path: 'a/b/c.txt', type: 'change'}))
    const {childrenCache} = useFileTreeStore.getState()
    expect(childrenCache['a/b']).toBeUndefined()   // 变更文件父目录失效
    expect(childrenCache['a']).toBeDefined()       // 更上级目录不受影响
    expect(childrenCache['z']).toBeDefined()       // 无关目录保留
  })

  it('file-changed 后 500ms 防抖取最新 tab 快照，hash 变化触发重载', async () => {
    vi.useFakeTimers()
    try {
      const readFile = vi.mocked(window.electronAPI!.projectManager.readFile)
      readFile.mockResolvedValue({path: 'a.ts', size: 1, content: 'new-content', isBinary: false, isImage: false, decodeError: false, mimeType: '', truncated: false, mtime: 0, hash: 'h2'})
      render(<ProjectManagerApp />)
      act(() => {
        useEditorTabStore.getState().openFileTab({path: 'a.ts', title: 'a.ts', content: 'old', hash: 'h1'})
        const cb = vi.mocked(window.electronAPI!.projectManager.onFileChanged).mock.calls[0][0]
        cb('/ws', {path: 'a.ts', type: 'change'})
      })
      await act(async () => { await vi.runAllTimersAsync() })
      const tab = useEditorTabStore.getState().tabs.find(t => t.filePath === 'a.ts')
      expect(tab?.fileHash).toBe('h2')
      expect(tab?.content).toBe('new-content')
    } finally {
      vi.useRealTimers()
    }
  })

  it('防抖期间 tab 已关闭则跳过重载', () => {
    vi.useFakeTimers()
    try {
      const readFile = vi.mocked(window.electronAPI!.projectManager.readFile)
      render(<ProjectManagerApp />)
      act(() => {
        useEditorTabStore.getState().openFileTab({path: 'a.ts', title: 'a.ts', content: 'old', hash: 'h1'})
        const cb = vi.mocked(window.electronAPI!.projectManager.onFileChanged).mock.calls[0][0]
        cb('/ws', {path: 'a.ts', type: 'change'})
      })
      act(() => { useEditorTabStore.getState().closeAll() })
      act(() => { vi.advanceTimersByTime(500) })
      expect(readFile).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('file-changed 只重载匹配 payload.path 的 tab（不遍历全部 file tab）', async () => {
    vi.useFakeTimers()
    try {
      const readFile = vi.mocked(window.electronAPI!.projectManager.readFile)
      readFile.mockResolvedValue({path: 'a.ts', size: 1, content: 'new-a', isBinary: false, isImage: false, decodeError: false, mimeType: '', truncated: false, mtime: 0, hash: 'h2a'})
      render(<ProjectManagerApp />)
      act(() => {
        useEditorTabStore.getState().openFileTab({path: 'a.ts', title: 'a.ts', content: 'old-a', hash: 'h1a'})
        useEditorTabStore.getState().openFileTab({path: 'b.ts', title: 'b.ts', content: 'old-b', hash: 'h1b'})
      })
      const cb = vi.mocked(window.electronAPI!.projectManager.onFileChanged).mock.calls[0][0]
      act(() => cb('/ws', {path: 'a.ts', type: 'change'}))
      await act(async () => { await vi.runAllTimersAsync() })
      // a.ts 被重载
      expect(useEditorTabStore.getState().tabs.find(t => t.filePath === 'a.ts')!.fileHash).toBe('h2a')
      // b.ts 不受影响（readFile 未为 b.ts 调用）
      expect(useEditorTabStore.getState().tabs.find(t => t.filePath === 'b.ts')!.fileHash).toBe('h1b')
      expect(readFile).not.toHaveBeenCalledWith('/ws', 'b.ts')
    } finally {
      vi.useRealTimers()
    }
  })

  it('file-changed readFile 失败（虚拟路径 ENOENT）不再 unhandled rejection', async () => {
    vi.useFakeTimers()
    try {
      const readFile = vi.mocked(window.electronAPI!.projectManager.readFile)
      readFile.mockRejectedValue(new Error('ENOENT'))
      const errorHandler = vi.spyOn(console, 'error').mockImplementation(() => {})
      render(<ProjectManagerApp />)
      act(() => {
        useEditorTabStore.getState().openFileTab({path: 'a.ts', title: 'a.ts', content: 'old', hash: 'h1'})
        const cb = vi.mocked(window.electronAPI!.projectManager.onFileChanged).mock.calls[0][0]
        cb('/ws', {path: 'a.ts', type: 'change'})
      })
      await act(async () => { await vi.runAllTimersAsync() })
      // 应捕获错误，不抛出 unhandled rejection
      expect(readFile).toHaveBeenCalled()
      errorHandler.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reloadTabContent 非激活 tab content >2MB 时只更新 hash 不回填 content', async () => {
    vi.useFakeTimers()
    try {
      const bigContent = 'x'.repeat(3 * 1024 * 1024)
      const readFile = vi.mocked(window.electronAPI!.projectManager.readFile)
      readFile.mockResolvedValue({path: 'big.ts', size: 3 * 1024 * 1024, content: bigContent, isBinary: false, isImage: false, decodeError: false, mimeType: '', truncated: false, mtime: 0, hash: 'h2big'})
      render(<ProjectManagerApp />)
      act(() => {
        useEditorTabStore.getState().openFileTab({path: 'big.ts', title: 'big.ts', content: 'x'.repeat(3 * 1024 * 1024), hash: 'h1big'})
        // 打开另一个 tab 使 big.ts 成为非激活（content >2MB 会被淘汰）
        useEditorTabStore.getState().openFileTab({path: 'other.ts', title: 'other.ts', content: 'x', hash: 'h1other'})
      })
      const cb = vi.mocked(window.electronAPI!.projectManager.onFileChanged).mock.calls[0][0]
      act(() => cb('/ws', {path: 'big.ts', type: 'change'}))
      await act(async () => { await vi.runAllTimersAsync() })
      const tab = useEditorTabStore.getState().tabs.find(t => t.filePath === 'big.ts')!
      expect(tab.fileHash).toBe('h2big')     // hash 更新
      expect(tab.content).toBeUndefined()    // content 未回填（保持淘汰闭环）
    } finally {
      vi.useRealTimers()
    }
  })

  it('渲染独立窗口标题栏（workspace basename 主标题），窗口控制按钮可调用', () => {
    const minimize = vi.fn()
    const maximize = vi.fn()
    const close = vi.fn()
    ;(window as any).electronAPI = {
      ...(window as any).electronAPI,
      projectManager: {
        ...window.electronAPI?.projectManager,
        workspacePath: '/proj/app',
      },
      windowControls: {
        minimize,
        maximize,
        close,
        isMaximized: vi.fn(async () => false),
        onMaximizedChange: vi.fn(() => () => {}),
      },
    }
    render(<ProjectManagerApp />)
    // basename 作为主标题
    expect(screen.getByTestId('titlebar-title')).toHaveTextContent('app')
    fireEvent.click(screen.getByRole('button', {name: '最小化'}))
    expect(minimize).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', {name: '最大化'}))
    expect(maximize).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', {name: '关闭'}))
    expect(close).toHaveBeenCalled()
  })

  it('标题栏显示 workspace basename + 绝对路径次级文字', () => {
    ;(window as any).electronAPI.projectManager.workspacePath = 'E:\\proj\\my-app'
    ;(window as any).electronAPI.projectManager.listDirectory = vi.fn(async () => [])
    render(<ProjectManagerApp />)
    // basename 作为主标题，并标注「(只读)」（指编辑器只读查看，非窗口无写能力）
    expect(screen.getByTestId('titlebar-title')).toHaveTextContent('my-app')
    expect(screen.getByTestId('titlebar-title')).toHaveTextContent('(只读)')
    // 绝对路径作为次级文字（更小、更浅）
    expect(screen.getByTestId('titlebar-subtitle')).toHaveTextContent('E:\\proj\\my-app')
  })

  it('有工作区标题标注「(只读)」；无工作区不加后缀', () => {
    ;(window as any).electronAPI.projectManager.workspacePath = 'E:\\proj\\my-app'
    const first = render(<ProjectManagerApp />)
    expect(first.getByTestId('titlebar-title').textContent).toMatch(/\(只读\)/)
    first.unmount()
    ;(window as any).electronAPI.projectManager.workspacePath = ''
    const second = render(<ProjectManagerApp />)
    expect(second.getByTestId('titlebar-title').textContent).not.toMatch(/只读/)
  })

  it('不再出现「窗口只读」文案（写能力已开放，UI 不得自相矛盾）', async () => {
    ;(window as any).electronAPI.projectManager.workspacePath = 'E:\\proj\\my-app'
    const {container} = render(<ProjectManagerApp />)
    expect(container.textContent).not.toContain('窗口只读')
  })

  it('渲染 5 条可拖分隔条（上半区 2 + 下半区 2 + 横向 1）', () => {
    render(<ProjectManagerApp />)
    // 下区的「分支宽度」「Commit 详情宽度」由 Task 14 引入（GitLogPanel 自持 usePaneSize 实例）
    expect(screen.getAllByRole('separator')).toHaveLength(5)
  })

  it('分隔条带轴向与可访问名', () => {
    render(<ProjectManagerApp />)
    expect(screen.getByRole('separator', {name: '文件树宽度'})).toHaveAttribute('aria-orientation', 'vertical')
    expect(screen.getByRole('separator', {name: '变更列表宽度'})).toHaveAttribute('aria-orientation', 'vertical')
    expect(screen.getByRole('separator', {name: '分支宽度'})).toHaveAttribute('aria-orientation', 'vertical')
    expect(screen.getByRole('separator', {name: '提交详情宽度'})).toHaveAttribute('aria-orientation', 'vertical')
    expect(screen.getByRole('separator', {name: 'Git 区高度'})).toHaveAttribute('aria-orientation', 'horizontal')
  })

  it('拖动文件树分隔条后尺寸写入 localStorage，刷新（重挂载）后保持', () => {
    const first = render(<ProjectManagerApp />)
    const handle = screen.getByRole('separator', {name: '文件树宽度'})
    // 原生 dispatchEvent 不经 RTL 的 act 包装，需显式包裹否则 onResizeEnd 的 setState 会告警
    act(() => {
      fireEvent.mouseDown(handle, {clientX: 200})
      document.dispatchEvent(new MouseEvent('mousemove', {clientX: 320, bubbles: true}))
      document.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}))
    })
    expect(JSON.parse(localStorage.getItem('pm:layout:/ws')!).sizes.fileTree).toBe(320)
    first.unmount()

    render(<ProjectManagerApp />)
    expect(screen.getByRole('separator', {name: '文件树宽度'})).toHaveAttribute('aria-valuenow', '320')
  })

  it('点击 Git 区标题条折叠到 22px，再点展开还原', () => {
    render(<ProjectManagerApp />)
    const sep = () => screen.getByRole('separator', {name: 'Git 区高度'})
    fireEvent.click(screen.getByRole('button', {name: /Git/}))
    // 折叠态的 min 必须跟随折叠高度。否则 valuenow(22) < valuemin(120) 违反 separator 契约，
    // 且拖拽起手第一帧就被 clamp 到 120，面板从 22 跳到 120。
    expect(sep()).toHaveAttribute('aria-valuenow', '22')
    expect(sep()).toHaveAttribute('aria-valuemin', '22')
    fireEvent.click(screen.getByRole('button', {name: /Git/}))
    expect(sep()).toHaveAttribute('aria-valuenow', '236')
    expect(sep()).toHaveAttribute('aria-valuemin', '120')
  })

  it('头部摘要与状态栏同源：纯未跟踪工作区显示 N files changed，不误报 Working tree clean', async () => {
    // git diff --numstat HEAD 不含未跟踪（??）文件；头部摘要若只看 additions/deletions，
    // 就会在"纯未跟踪"工作区显示 Working tree clean，而状态栏显示 N files changed。
    vi.mocked(window.electronAPI!.projectManager.gitStatus).mockResolvedValue({
      statusMap: {'new.txt': {path: 'new.txt', status: '??', indexStatus: '?', worktreeStatus: '?'}},
      additions: 0,
      deletions: 0,
      updatedAt: 1,
    })
    render(<ProjectManagerApp />)
    const header = screen.getByTestId('pm-git-header')
    // 注意：变更列表底部的 pm-changes-summary 文案格式相同，所以必须限定在头部摘要里查
    await waitFor(() => expect(header).toHaveTextContent('已更改 1 个文件 · +0 · −0'))
    expect(header).not.toHaveTextContent('工作区干净')
  })

  it('Git 区折叠态持久化（重挂载后仍折叠）', () => {
    const first = render(<ProjectManagerApp />)
    fireEvent.click(screen.getByRole('button', {name: /Git/}))
    first.unmount()
    render(<ProjectManagerApp />)
    expect(screen.getByRole('separator', {name: 'Git 区高度'})).toHaveAttribute('aria-valuenow', '22')
  })

  it('回归：主布局不再写死像素 grid', () => {
    render(<ProjectManagerApp />)
    // 只断言旧写死签名已消失；不能做全文档查询——GitLogPanel 自己仍内联 grid-template-columns（Task 14 处理）
    expect(document.querySelector('[style*="260px 1fr 280px"]')).toBeNull()
  })

  it('I8 切换 workspace 后旧 gitBranches 迟到结果被丢弃', async () => {
    const branches = vi.mocked(window.electronAPI!.projectManager.gitBranches)
    const resolvers: Array<(v: any) => void> = []
    branches.mockImplementation(() => new Promise(res => { resolvers.push(res) }))
    render(<ProjectManagerApp />)
    // 初次 effect 以 /ws 发起；切到 /ws2 后 effect 重建，第二次以 /ws2 发起
    act(() => { useWorkspaceStore.setState({workspacePath: '/ws2'}) })
    // 只让旧仓库（第一次）的响应迟到返回
    resolvers[0]!([{name: 'stale-branch', isCurrent: true}])
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByText(/stale-branch/)).toBeNull()
  })

  it('I9 切换 workspace 后防抖 readFile 迟到结果不写入新仓库', async () => {
    vi.useFakeTimers()
    try {
      const readFile = vi.mocked(window.electronAPI!.projectManager.readFile)
      let resolveRead: (v: any) => void = () => {}
      readFile.mockImplementation(() => new Promise(res => { resolveRead = res }))
      render(<ProjectManagerApp />)
      act(() => {
        useEditorTabStore.getState().openFileTab({path: 'a.ts', title: 'a.ts', content: 'old', hash: 'h1'})
        const cb = vi.mocked(window.electronAPI!.projectManager.onFileChanged).mock.calls[0][0]
        cb('/ws', {path: 'a.ts', type: 'change'})
      })
      act(() => { vi.advanceTimersByTime(500) })   // 防抖到期，readFile 在途
      act(() => { useWorkspaceStore.setState({workspacePath: '/ws2'}) })   // 请求在途时切仓库
      resolveRead({path: 'a.ts', size: 1, content: 'new', isBinary: false, isImage: false, decodeError: false, mimeType: '', truncated: false, mtime: 0, hash: 'h2'})
      await act(async () => { await Promise.resolve() })
      const tab = useEditorTabStore.getState().tabs.find(t => t.filePath === 'a.ts')
      expect(tab?.fileHash).toBe('h1')   // 旧仓库响应被丢弃，未覆盖
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('TooltipPortal 接管原生 title（spec §13.7）', () => {
  it('根节点挂载公共 TooltipPortal（.tooltip-portal 存在）', () => {
    render(<ProjectManagerApp />)
    expect(document.querySelector('.tooltip-portal')).not.toBeNull()
  })

  it('mouseOver 带 title 的元素：portal 渲染该文案，且原生 title 属性被移除', () => {
    // 前置用例（I8/I9）会把 workspace 切到 /ws2，这里显式复位，避免断言依赖执行顺序
    useWorkspaceStore.setState({workspacePath: '/ws'} as never)
    render(<ProjectManagerApp />)
    // 标题栏次级文字（绝对路径）带 title=[title]；它同时不是任何交互控件，最干净
    const el = screen.getByTestId('titlebar-subtitle')
    expect(el).toHaveAttribute('title', '/ws')

    const portal = document.querySelector('.tooltip-portal') as HTMLElement
    expect(portal.textContent).toBe('')
    fireEvent.mouseOver(el)
    expect(portal.textContent).toBe('/ws')
    // 接管特征：title 被摘掉（避免原生白条 tooltip 与主题化 tooltip 同时出现）
    expect(el).not.toHaveAttribute('title')

    // 移出后恢复 title，不留后遗症
    fireEvent.mouseOut(el, {relatedTarget: document.body})
    expect(el).toHaveAttribute('title', '/ws')
  })
})
describe('ProjectManagerApp 外部删除清理标签', () => {
  const captureOnFileChanged = () => {
    let handler: ((ws: string, payload: {path: string, type: string}) => void) | null = null
    ;(window.electronAPI!.projectManager.onFileChanged as ReturnType<typeof vi.fn>).mockImplementation((cb: typeof handler) => {
      handler = cb
      return () => {}
    })
    return () => handler
  }

  it('unlink：外部删除文件后关闭对应残留标签', () => {
    const getHandler = captureOnFileChanged()
    render(<ProjectManagerApp />)
    act(() => { useEditorTabStore.getState().openFileTab({path: 'a.ts', title: 'a.ts', content: 'x', hash: 'h1'}) })
    expect(useEditorTabStore.getState().tabs).toHaveLength(1)
    act(() => { getHandler()?.('/ws', {path: 'a.ts', type: 'unlink'}) })
    expect(useEditorTabStore.getState().tabs).toHaveLength(0)
  })

  it('unlinkDir：目录删除按前缀关闭其下所有标签', () => {
    const getHandler = captureOnFileChanged()
    render(<ProjectManagerApp />)
    act(() => {
      useEditorTabStore.getState().openFileTab({path: 'src/a.ts', title: 'a.ts', content: 'x', hash: 'h1'})
      useEditorTabStore.getState().openFileTab({path: 'b.ts', title: 'b.ts', content: 'x', hash: 'h2'})
    })
    act(() => { getHandler()?.('/ws', {path: 'src', type: 'unlinkDir'}) })
    expect(useEditorTabStore.getState().tabs.map(t => t.filePath)).toEqual(['b.ts'])
  })
})
