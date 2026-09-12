// @vitest-environment jsdom
import {describe, it, expect, vi, afterEach, beforeEach} from 'vitest'
import {readFileSync} from 'fs'
import {join} from 'path'
import {render, screen, fireEvent, waitFor, act, within} from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import {EditorArea} from '../../../src/renderer/project-manager/components/EditorArea'
import {useEditorTabStore} from '../../../src/renderer/project-manager/stores/editorTabStore'
import {useWorkspaceStore} from '../../../src/renderer/project-manager/stores/workspaceStore'
import {SendToConversationProvider} from '../../../src/renderer/project-manager/ui/SendToConversationProvider'

// CodeEditor 依赖 CodeMirror 动态加载，本文件只关心分支选择，mock 之。
// 额外挂一个按钮用于触发选区回调（Task 23 要测「编辑器选区 → 右键发送」）。
// 结构化 mock：真实 CodeEditor 宿主 `.pm-code-editor` 内部是 CodeMirror 根 `.cm-editor`，
// EditorArea 的右键守卫依赖该祖先判定「落点在源码栏」，故 mock 必须复现这一 DOM 契约。
vi.mock('../../../src/renderer/project-manager/components/CodeEditor', () => ({
  CodeEditor: (props: {content: string, onSelectionChange?: (s: {lineNumbers: number[]} | null) => void}) => (
    <div data-testid="code-editor">{props.content}
      <div className="cm-editor">
        <div className="cm-line">source line</div>
      </div>
      <button type="button" onClick={() => props.onSelectionChange?.({lineNumbers: [3]})}>sel</button>
    </div>
  ),
}))

const win = window as unknown as {electronAPI?: {projectManager: Record<string, unknown>}}
afterEach(() => { delete win.electronAPI })

/** 打开 n 个 file tab，返回它们的 title */
const openFileTabs = (titles: string[]) => {
  useEditorTabStore.setState({tabs: [], activeTabId: null})
  for (const t of titles) {
    useEditorTabStore.getState().openFileTab({path: t, title: t, content: `// ${t}`, hash: `h-${t}`})
  }
}

/** 读 globals.css 里某个选择器的规则体（jsdom 不解析外部 CSS → 静态断言，同 themeTokens.test.ts 手法） */
const CSS = readFileSync(join(process.cwd(), 'src/renderer/styles/globals.css'), 'utf-8')
function cssRuleBody(selector: string): string {
  const at = CSS.indexOf(`\n${selector} {`)
  expect(at, `globals.css 里找不到规则 ${selector}`).toBeGreaterThan(-1)
  const start = CSS.indexOf('{', at)
  const end = CSS.indexOf('}', start)
  return CSS.slice(start + 1, end)
}

const bigDiff = {
  filePath: 'big.ts',
  oldContent: 'a'.repeat(3 * 1024 * 1024),
  newContent: 'b'.repeat(3 * 1024 * 1024),
  diffType: 'working-tree' as const,
  oldRef: 'HEAD',
  newRef: 'w',
  additions: 1,
  deletions: 1,
}

describe('EditorArea 空文件渲染', () => {
  it('content 为空串且 hash 非空的真实空文件仍渲染编辑器', () => {
    useEditorTabStore.setState({tabs: [], activeTabId: null})
    useEditorTabStore.getState().openFileTab({path: 'empty.ts', title: 'empty.ts', content: '', hash: 'h-empty'})
    useWorkspaceStore.setState({workspacePath: '/ws'} as never)
    render(<EditorArea />)
    expect(screen.getByTestId('code-editor')).toBeInTheDocument()
  })
})

describe('EditorArea diff tab 默认 side-by-side', () => {
  it('打开 diff tab 后默认渲染 side-by-side 容器（而非 inline）', () => {
    useEditorTabStore.setState({tabs: [], activeTabId: null})
    const diffData = {
      filePath: 'a.ts', oldContent: 'a', newContent: 'b',
      diffType: 'working-tree' as const, oldRef: 'HEAD', newRef: 'worktree', additions: 1, deletions: 1,
    }
    useEditorTabStore.getState().openDiffTab({
      filePath: 'a.ts', title: 'a.ts', diffType: 'working-tree', diffData,
    })
    render(<EditorArea />)
    expect(screen.getByTestId('diff-side-by-side')).toBeInTheDocument()
    expect(screen.queryByTestId('diff-inline')).not.toBeInTheDocument()
  })

  it('diff 面板用 .pm-diff-pane 包住工具条与 diff 区（工具条固定、diff 区自行滚动）', () => {
    useEditorTabStore.setState({tabs: [], activeTabId: null})
    const diffData = {
      filePath: 'a.ts', oldContent: 'a', newContent: 'b',
      diffType: 'working-tree' as const, oldRef: 'HEAD', newRef: 'worktree', additions: 1, deletions: 1,
    }
    useEditorTabStore.getState().openDiffTab({
      filePath: 'a.ts', title: 'a.ts', diffType: 'working-tree', diffData,
    })
    const {container} = render(<EditorArea />)
    const pane = container.querySelector('.pm-diff-pane')
    expect(pane).not.toBeNull()
    expect(pane!.querySelector('.pm-diff-toolbar')).not.toBeNull()
    expect(pane!.querySelector('.pm-diff-scroll')).not.toBeNull()
  })

  it('diff 面板：.pm-diff-pane 是纵向 flex 且高度占满，.pm-diff-scroll 独占剩余高度', () => {
    const pane = cssRuleBody('.pm-diff-pane')
    expect(pane).toMatch(/display:\s*flex/)
    expect(pane).toMatch(/flex-direction:\s*column/)
    expect(pane).toMatch(/height:\s*100%/)
    expect(pane).toMatch(/min-height:\s*0/)
    expect(cssRuleBody('.pm-diff-scroll')).toMatch(/flex:\s*1 1 0/)
  })
})

describe('EditorArea markdown 分屏 / 预览视图', () => {
  /** 打开一个 md 文件 tab（真实 file tab：有 content + hash） */
  const openMdTab = (path = 'doc.md', content = '# 标题\n\n正文') => {
    useEditorTabStore.setState({tabs: [], activeTabId: null})
    useWorkspaceStore.setState({workspacePath: '/ws'} as never)
    useEditorTabStore.getState().openFileTab({path, title: path, content, hash: `h-${path}`})
  }

  it('md 文件默认渲染分屏：源码（code-editor）与预览同时出现', () => {
    openMdTab()
    render(<EditorArea />)
    // 两个按钮都在
    expect(screen.getByRole('button', {name: '分屏'})).toHaveClass('pm-toggle-chip', 'is-active')
    expect(screen.getByRole('button', {name: '预览'})).not.toHaveClass('is-active')
    // 左源码 + 右预览同时出现
    expect(screen.getByTestId('code-editor')).toBeInTheDocument()
    expect(screen.getByTestId('md-source-pane')).toBeInTheDocument()
    expect(screen.getByTestId('md-preview-pane')).toBeInTheDocument()
    expect(document.querySelector('.pm-md-preview')).not.toBeNull()
    expect(screen.getByText('标题')).toBeInTheDocument()
  })

  it('切到「预览」后源码不再渲染，仅预览', () => {
    openMdTab()
    render(<EditorArea />)
    fireEvent.click(screen.getByRole('button', {name: '预览'}))
    expect(screen.queryByTestId('code-editor')).not.toBeInTheDocument()
    expect(screen.queryByTestId('md-source-pane')).not.toBeInTheDocument()
    expect(screen.getByRole('button', {name: '预览'})).toHaveClass('is-active')
    expect(document.querySelector('.pm-md-preview')).not.toBeNull()
    expect(screen.getByText('标题')).toBeInTheDocument()
  })

  // 回归：tab.filePath 来自文件树，是**工作区相对路径**（fileSystem.ts 的 DirEntry.path）。
  // 若直接拿它当图片解析基准，相对图会停在 `docs/images/a.png` 这种相对形态仍然 404，
  // 必须拼上工作区根（workspaceStore）才是可用的 hclaw-media:// 绝对 URL。
  it('相对路径图片按「工作区根 + 文件相对路径」解析为 hclaw-media://', () => {
    openMdTab('docs/README.md', '![x](images/a.png)')
    render(<EditorArea />)
    const img = document.querySelector('.pm-md-preview img')
    expect(img, '预览里应渲染出图片').not.toBeNull()
    expect(img!.getAttribute('src')).toBe('hclaw-media:///ws/docs/images/a.png')
  })

  it('markdown 扩展名忽略大小写：.MARKDOWN 同样出现切换器', () => {
    openMdTab('README.MARKDOWN')
    render(<EditorArea />)
    expect(screen.getByRole('button', {name: '分屏'})).toBeInTheDocument()
    expect(screen.getByRole('button', {name: '预览'})).toBeInTheDocument()
  })

  it('非 md 文件不出现这两个按钮，且仍渲染 code-editor（防回归）', () => {
    openFileTabs(['a.ts'])
    render(<EditorArea />)
    expect(screen.queryByRole('button', {name: '分屏'})).not.toBeInTheDocument()
    expect(screen.queryByRole('button', {name: '预览'})).not.toBeInTheDocument()
    expect(screen.queryByTestId('md-source-pane')).not.toBeInTheDocument()
    expect(screen.getByTestId('code-editor')).toBeInTheDocument()
  })

  it('md 面板：.pm-md-pane 纵向 flex 占满高度，分屏两栏各自 flex:1 1 0 且独立滚动', () => {
    const pane = cssRuleBody('.pm-md-pane')
    expect(pane).toMatch(/display:\s*flex/)
    expect(pane).toMatch(/flex-direction:\s*column/)
    expect(pane).toMatch(/height:\s*100%/)
    expect(pane).toMatch(/min-height:\s*0/)
    expect(cssRuleBody('.pm-md-split')).toMatch(/flex:\s*1 1 0/)
    expect(cssRuleBody('.pm-md-half')).toMatch(/flex:\s*1 1 0/)
    expect(cssRuleBody('.pm-md-half')).toMatch(/min-width:\s*0/)
    // 分屏两栏的滚动各自落在内层容器，外层不设 overflow → 不与 .pm-editor-body 打架
    expect(cssRuleBody('.pm-md-half > .pm-md-preview')).toMatch(/overflow:\s*auto/)
    expect(cssRuleBody('.pm-md-preview-pane')).toMatch(/overflow:\s*auto/)
  })
})

describe('EditorArea diff tab 淘汰后回填', () => {
  const setupEvictedDiffTab = () => {
    useEditorTabStore.setState({tabs: [], activeTabId: null})
    useWorkspaceStore.setState({workspacePath: '/ws'} as never)
    useEditorTabStore.getState().openDiffTab({
      filePath: 'big.ts', title: 'Diff: big.ts', diffType: 'working-tree', diffData: bigDiff,
    })
    const diffId = useEditorTabStore.getState().tabs[0]!.id
    // 切到另一个 tab → 大 diffData 被淘汰（tab 与其 filePath/ref 保留）
    useEditorTabStore.getState().openFileTab({path: 'other.ts', title: 'other.ts', content: 'x', hash: 'h'})
    expect(useEditorTabStore.getState().tabs.find(t => t.id === diffId)!.diffData).toBeUndefined()
    return diffId
  }

  it('diff tab 被淘汰后经点击激活可自动回填（不白屏）', async () => {
    const diffId = setupEvictedDiffTab()
    let resolveDiff!: (v: unknown) => void
    const gitDiffFile = vi.fn(() => new Promise(res => { resolveDiff = res }))
    win.electronAPI = {projectManager: {gitDiffFile}}

    render(<EditorArea />)
    // 点击 tab 条激活被淘汰的 diff tab
    fireEvent.click(screen.getByTestId('editor-tab-Diff: big.ts'))

    // 加载中表现，而非空白面板
    expect(screen.getByText('加载中…')).toBeInTheDocument()
    expect(gitDiffFile).toHaveBeenCalledWith('/ws', 'big.ts', undefined)

    await act(async () => { resolveDiff(bigDiff) })

    await waitFor(() => expect(screen.getByTestId('diff-side-by-side')).toBeInTheDocument())
    expect(useEditorTabStore.getState().tabs.find(t => t.id === diffId)!.diffData).toBeDefined()
    expect(useEditorTabStore.getState().tabs).toHaveLength(2)   // 未新建重复 tab
  })

  it('回填失败时展示失败文案而非白屏', async () => {
    setupEvictedDiffTab()
    let rejectDiff!: (e: unknown) => void
    const gitDiffFile = vi.fn(() => new Promise((_, rej) => { rejectDiff = rej }))
    win.electronAPI = {projectManager: {gitDiffFile}}

    render(<EditorArea />)
    fireEvent.click(screen.getByTestId('editor-tab-Diff: big.ts'))
    expect(screen.getByText('加载中…')).toBeInTheDocument()

    await act(async () => { rejectDiff(new Error('boom')) })

    await waitFor(() => expect(screen.getByText('无法加载此 diff')).toBeInTheDocument())
    expect(screen.queryByTestId('diff-side-by-side')).not.toBeInTheDocument()
  })
})

describe('EditorArea tab 条：右侧「已打开文件」下拉切换器（spec §11.4 / §13.6）', () => {
  it('点击 picker 打开菜单，列出全部 tab；点击某项只切换激活，不新增 tab', () => {
    openFileTabs(['a.ts', 'b.ts', 'c.ts'])
    const before = useEditorTabStore.getState().tabs
    expect(before).toHaveLength(3)
    const cId = before[2]!.id
    // 初始激活的是最后一个打开的 tab
    expect(useEditorTabStore.getState().activeTabId).toBe(cId)

    render(<EditorArea />)
    fireEvent.click(screen.getByTestId('editor-tab-picker'))

    const menu = screen.getByRole('menu')
    const items = screen.getAllByRole('menuitem')
    expect(items).toHaveLength(3)
    expect(items.map(i => i.textContent)).toEqual(['a.ts', 'b.ts', 'c.ts'])

    // 点击第 2 项 → 激活该 tab
    fireEvent.click(items[1]!)
    const bId = before[1]!.id
    expect(useEditorTabStore.getState().activeTabId).toBe(bId)
    // 只切换，不新增 tab
    expect(useEditorTabStore.getState().tabs).toHaveLength(3)
    expect(menu).not.toBeInTheDocument()
  })

  it('tab 根元素保留 role=tab 与 data-testid，激活态走 .is-active 类', () => {
    openFileTabs(['a.ts', 'b.ts'])
    render(<EditorArea />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(2)
    expect(screen.getByTestId('editor-tab-b.ts')).toHaveClass('pm-tab', 'is-active')
    expect(screen.getByTestId('editor-tab-a.ts')).toHaveClass('pm-tab')
    expect(screen.getByTestId('editor-tab-a.ts')).not.toHaveClass('is-active')
  })

  it('视图模式切换器复用 ToggleChip：当前模式 aria-pressed=true，点击其他模式切换', () => {
    useEditorTabStore.setState({tabs: [], activeTabId: null})
    useEditorTabStore.getState().openDiffTab({
      filePath: 'a.ts', title: 'a.ts', diffType: 'working-tree',
      diffData: {filePath: 'a.ts', oldContent: 'a\n', newContent: 'b\n', diffType: 'working-tree', oldRef: 'HEAD', newRef: 'worktree', additions: 1, deletions: 1},
    })
    render(<EditorArea />)
    const current = screen.getByRole('button', {name: '并排'})
    expect(current).toHaveClass('pm-toggle-chip', 'is-active')
    expect(current).toHaveAttribute('aria-pressed', 'true')
    // 已激活项再点不改变模式（保持既有 disabled 语义）
    fireEvent.click(current)
    expect(screen.getByTestId('diff-side-by-side')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', {name: '内联'}))
    expect(screen.getByTestId('diff-inline')).toBeInTheDocument()
    expect(screen.queryByTestId('diff-side-by-side')).not.toBeInTheDocument()
  })

  it('空态复用 EmptyState', () => {
    useEditorTabStore.setState({tabs: [], activeTabId: null})
    render(<EditorArea />)
    expect(document.querySelector('.pm-empty-state')).not.toBeNull()
  })

  it('组件不写内联样式（视觉一律走 .pm-* 类）', () => {
    openFileTabs(['a.ts'])
    const {container} = render(<EditorArea />)
    expect(container.querySelectorAll('[style]')).toHaveLength(0)
    expect(container.querySelector('.pm-editor-area')).not.toBeNull()
    expect(container.querySelector('.pm-tabbar')).not.toBeNull()
    expect(container.querySelector('.pm-tabbar-scroll')).not.toBeNull()
  })

  it('tab 单行不换行：.pm-tab 规则含 nowrap 与 flex: 0 0 auto（jsdom 不解析外部 CSS → 静态断言）', () => {
    const body = cssRuleBody('.pm-tab')
    expect(body).toMatch(/white-space:\s*nowrap/)
    expect(body).toMatch(/flex:\s*0 0 auto/)
  })

  it('tab 标题省略号三件套 + 宽度上限在 .pm-tab-title 规则内', () => {
    const body = cssRuleBody('.pm-tab-title')
    expect(body).toMatch(/white-space:\s*nowrap/)
    expect(body).toMatch(/overflow:\s*hidden/)
    expect(body).toMatch(/text-overflow:\s*ellipsis/)
    expect(body).toMatch(/max-width:\s*180px/)
  })

  it('tab 条容器自带横向滚动（多 tab 时才出现滚动条）', () => {
    expect(cssRuleBody('.pm-tabbar-scroll')).toMatch(/overflow-x:\s*auto/)
  })
})

describe('EditorArea 激活 tab 自动滚入可视区', () => {
  // jsdom 无布局：getBoundingClientRect 全零、scrollLeft 恒 0，effect 会天然 no-op 而无法验证。
  // 因此在 render 之前替换这两者：按元素特征分派 rect，并把 scrollLeft 存进 WeakMap 以便断言。
  const ORIG_RECT = Element.prototype.getBoundingClientRect
  const ORIG_SCROLLLEFT = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollLeft')
  const scrollLeftStore = new WeakMap<Element, number>()

  const mkRect = (left: number, right: number): DOMRect => ({
    left, right, top: 0, bottom: 0, width: right - left, height: 0, x: left, y: 0,
    toJSON: () => ({}),
  }) as unknown as DOMRect

  // 可视区用「视口坐标」表达：container 为容器可视区，tabs 为各 tab 的视口矩形
  let layout: {container: {left: number, right: number}, tabs: Record<string, {left: number, right: number}>} | null = null

  beforeEach(() => {
    layout = null
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if (!layout) return mkRect(0, 0)
      if (this.classList?.contains('pm-tabbar-scroll')) return mkRect(layout.container.left, layout.container.right)
      const id = this.getAttribute?.('data-tab-id')
      if (id && layout.tabs[id]) return mkRect(layout.tabs[id]!.left, layout.tabs[id]!.right)
      return mkRect(0, 0)
    } as typeof Element.prototype.getBoundingClientRect
    Object.defineProperty(HTMLElement.prototype, 'scrollLeft', {
      configurable: true,
      get(this: HTMLElement) { return scrollLeftStore.get(this) ?? 0 },
      set(this: HTMLElement, v: number) { scrollLeftStore.set(this, v) },
    })
  })

  afterEach(() => {
    Element.prototype.getBoundingClientRect = ORIG_RECT
    if (ORIG_SCROLLLEFT) Object.defineProperty(HTMLElement.prototype, 'scrollLeft', ORIG_SCROLLLEFT)
    else delete (HTMLElement.prototype as unknown as {scrollLeft?: unknown}).scrollLeft
  })

  const scrollOf = (container: HTMLElement) =>
    container.querySelector<HTMLElement>('.pm-tabbar-scroll')!.scrollLeft

  it('挂载时激活的 tab 在可视区右侧之外 → 容器 scrollLeft 增大到其右边缘可见', () => {
    openFileTabs(['a.ts', 'b.ts', 'c.ts'])
    const [a, b, c] = useEditorTabStore.getState().tabs.map(t => t.id)
    // 容器可视区 [0,100]，初始激活 c 的右边缘 160 越界
    layout = {
      container: {left: 0, right: 100},
      tabs: {[a!]: {left: 0, right: 60}, [b!]: {left: 60, right: 110}, [c!]: {left: 110, right: 160}},
    }
    const {container} = render(<EditorArea />)
    expect(scrollOf(container)).toBe(60)   // 160 - 100
  })

  it('激活的 tab 已完全可见 → scrollLeft 不变', () => {
    openFileTabs(['a.ts'])
    const id = useEditorTabStore.getState().tabs[0]!.id
    layout = {container: {left: 0, right: 100}, tabs: {[id!]: {left: 10, right: 50}}}
    const {container} = render(<EditorArea />)
    expect(scrollOf(container)).toBe(0)
  })

  it('点击激活一个在可视区外的 tab 会滚动容器（activeTabId 变化即触发，不依赖具体入口）', () => {
    openFileTabs(['a.ts', 'b.ts'])
    const [a, b] = useEditorTabStore.getState().tabs.map(t => t.id)
    // a 在左侧外部、b 可见 → 挂载时（激活 b）不滚
    layout = {
      container: {left: 0, right: 100},
      tabs: {[a!]: {left: -30, right: 20}, [b!]: {left: 20, right: 70}},
    }
    const {container} = render(<EditorArea />)
    expect(scrollOf(container)).toBe(0)

    fireEvent.click(screen.getByTestId('editor-tab-a.ts'))
    // 左边缘 -30 越界 → 左移 30（测试公式；真实浏览器再自行 clamp 到 0）
    expect(scrollOf(container)).toBe(-30)
  })
})

describe('EditorArea 右键「发送到会话」（spec §9.4）', () => {
  const workingDiff = {
    filePath: 'a.ts', oldContent: 'line1\nline2', newContent: 'line1\nline2 changed',
    diffType: 'working-tree' as const, oldRef: 'HEAD', newRef: 'worktree', additions: 1, deletions: 1,
  }
  // workspaceStore.workspacePath 是惰性 getter，读取 window.electronAPI.projectManager.workspacePath
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
    ;(window as unknown as {electronAPI: unknown}).electronAPI = {
      projectManager: {workspacePath: '/ws'},
      conversationListByWorkspace: vi.fn(async () => []),
    }
  })
  const openWorkingDiff = () => {
    useEditorTabStore.setState({tabs: [], activeTabId: null})
    useEditorTabStore.getState().openDiffTab({filePath: 'a.ts', title: 'a.ts', diffType: 'working-tree', diffData: workingDiff})
  }

  it('diff 右栏选区 → 右键 → 「发送到会话」→ 预览为绝对路径 + 新版本行号', async () => {
    openWorkingDiff()
    const {container} = render(<SendToConversationProvider><EditorArea /></SendToConversationProvider>)
    const cell = container.querySelector<HTMLElement>('.pm-diff-code[data-side="right"][data-row="0"]')!
    fireEvent.mouseDown(cell, {button: 0})
    fireEvent.contextMenu(cell)
    fireEvent.click(screen.getByRole('menuitem', {name: '发送到会话'}))
    expect(await screen.findByTestId('pm-send-dialog-preview')).toHaveTextContent('/ws/a.ts:1')
  })

  it('CodeEditor 选区 → 右键 → 菜单出现且可发送', async () => {
    openFileTabs(['a.ts'])
    render(<SendToConversationProvider><EditorArea /></SendToConversationProvider>)
    fireEvent.click(screen.getByRole('button', {name: 'sel'}))
    fireEvent.contextMenu(screen.getByTestId('code-editor'))
    fireEvent.click(screen.getByRole('menuitem', {name: '发送到会话'}))
    expect(await screen.findByTestId('pm-send-dialog-preview')).toHaveTextContent('/ws/a.ts:3')
  })

  it('无选区时右键不出现「发送到会话」', () => {
    openFileTabs(['a.ts'])
    render(<SendToConversationProvider><EditorArea /></SendToConversationProvider>)
    fireEvent.contextMenu(screen.getByTestId('code-editor'))
    expect(screen.queryByRole('menuitem', {name: '发送到会话'})).toBeNull()
  })
})

// Markdown 区此前被守卫整块屏蔽（含 split 左侧源码栏），属遗漏：源码栏同样是可发送的 CodeEditor。
// 本组锁定「源码栏放行、预览区 / 工具栏不接管」的边界。
describe('EditorArea 右键「发送到会话」— Markdown 源码栏', () => {
  const MENU = '发送到会话'
  const openMd = () => {
    useEditorTabStore.setState({tabs: [], activeTabId: null})
    useWorkspaceStore.setState({workspacePath: '/ws'} as never)
    useEditorTabStore.getState().openFileTab({path: 'doc.md', title: 'doc.md', content: '# 标题\n\n正文', hash: 'h-doc'})
  }
  /** 选中一行（mock CodeEditor 的 sel 按钮 → lineNumbers [3]），使 selectionSnapshot 就绪 */
  const selectLine = () => fireEvent.click(screen.getByRole('button', {name: 'sel'}))
  /** 源码栏里的行节点（位于 .cm-editor 之内，模拟真实右键落点） */
  const sourceLine = () => within(screen.getByTestId('md-source-pane')).getByText('source line')

  beforeEach(() => {
    ;(window as unknown as {electronAPI: unknown}).electronAPI = {
      projectManager: {workspacePath: '/ws'},
      conversationListByWorkspace: vi.fn(async () => []),
    }
  })

  it('split 模式源码栏选中行后右键 → 出现「发送到会话」并可发送', async () => {
    openMd()
    render(<SendToConversationProvider><EditorArea /></SendToConversationProvider>)
    selectLine()
    fireEvent.contextMenu(sourceLine())
    fireEvent.click(screen.getByRole('menuitem', {name: MENU}))
    expect(await screen.findByTestId('pm-send-dialog-preview')).toHaveTextContent('/ws/doc.md:3')
  })

  it('preview 模式（无源码栏）右键不出现菜单', () => {
    openMd()
    render(<SendToConversationProvider><EditorArea /></SendToConversationProvider>)
    selectLine()
    fireEvent.click(screen.getByRole('button', {name: '预览'}))
    // 快照仍在（选区未清），但落点在整块预览面板 → 必须被守卫拦截
    fireEvent.contextMenu(document.querySelector<HTMLElement>('.pm-md-preview-pane')!)
    expect(screen.queryByRole('menuitem', {name: MENU})).toBeNull()
  })

  it('split 模式右侧预览半区右键不出现菜单', () => {
    openMd()
    render(<SendToConversationProvider><EditorArea /></SendToConversationProvider>)
    selectLine()
    fireEvent.contextMenu(screen.getByTestId('md-preview-pane'))
    expect(screen.queryByRole('menuitem', {name: MENU})).toBeNull()
  })

  it('Markdown 工具栏右键不出现菜单', () => {
    openMd()
    render(<SendToConversationProvider><EditorArea /></SendToConversationProvider>)
    selectLine()
    fireEvent.contextMenu(document.querySelector<HTMLElement>('.pm-md-toolbar')!)
    expect(screen.queryByRole('menuitem', {name: MENU})).toBeNull()
  })
})

