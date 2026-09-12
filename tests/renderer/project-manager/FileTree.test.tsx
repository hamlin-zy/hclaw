// @vitest-environment jsdom
import '@testing-library/jest-dom'
import {describe, it, expect, vi, beforeEach, beforeAll} from 'vitest'
import {render, screen, fireEvent, waitFor, act} from '@testing-library/react'
import {readFileSync} from 'fs'
import {join} from 'path'
import type {DirEntry} from '@shared/types/project-manager'
import {FileTree} from '../../../src/renderer/project-manager/components/FileTree'
import {useFileTreeStore} from '../../../src/renderer/project-manager/stores/fileTreeStore'
import {useWorkspaceStore} from '../../../src/renderer/project-manager/stores/workspaceStore'
import {useEditorTabStore} from '../../../src/renderer/project-manager/stores/editorTabStore'

// ConfirmDialog 必须 mock：真实实现依赖 window 事件 + 用户点击才会 resolve，
// 否则 `await confirm(...)` 会永久挂起（测试超时）
vi.mock('../../../src/renderer/components/ConfirmDialog', () => ({
  confirm: vi.fn(async () => true),
  default: () => null,
}))
import {confirm} from '../../../src/renderer/components/ConfirmDialog'
const confirmMock = vi.mocked(confirm)

// vitest.config.ts 未开启 css: true，globals.css 不会自动进入 jsdom。
// 本文件断言状态色走 --vcs-* 令牌（.pm-c--M），故手动注入一次真实样式表
// （与 tests/renderer/project-manager/treeRow.test.tsx 同源做法）。
beforeAll(() => {
  const css = readFileSync(join(process.cwd(), 'src/renderer/styles/globals.css'), 'utf-8')
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
})

// 显式标注 listDirectory 的签名：DirEntry.ignored 是必填字段，标注后所有 fixture 都被类型系统强制检查
const listDir = vi.fn<(ws: string, dir: string) => Promise<DirEntry[]>>()
const readFile = vi.fn()
// jsdom 不实现 scrollIntoView；用 spy 断言 reveal 滚动到的是"那个元素"（dataset.path）
const scrollSpy = vi.fn()

beforeEach(() => {
  listDir.mockReset()
  readFile.mockReset()
  scrollSpy.mockReset()
  confirmMock.mockReset()
  confirmMock.mockResolvedValue(true)
  ;(Element.prototype as unknown as {scrollIntoView: unknown}).scrollIntoView = scrollSpy
  ;(window as any).electronAPI = {projectManager: {listDirectory: listDir, readFile}}
  useWorkspaceStore.setState({workspacePath: '/ws'})
  useFileTreeStore.setState({expanded: new Set(), childrenCache: {}, cacheOrder: [], selectedPath: null})
  useEditorTabStore.setState({tabs: [], activeTabId: null})
})

/** 复刻浏览器真实双击序列（见 spec §7.2：直接 fireEvent.doubleClick 会假绿通过） */
function doubleClickWithClicks(el: Element, row: Element) {
  fireEvent.click(el, {detail: 1, bubbles: true})
  fireEvent.click(el, {detail: 2, bubbles: true})
  fireEvent.dblClick(row, {bubbles: true})
}

const dirEntry = (name: string, path: string) =>
  ({name, path, isDir: true, size: 0, gitStatus: 'none' as const, hasChildren: true, ignored: false})
const fileEntry = (name: string, path: string, ignored = false) =>
  ({name, path, isDir: false, size: 1, gitStatus: 'none' as const, hasChildren: false, ignored})

describe('FileTree', () => {
  it('首层加载并跳过黑名单后渲染', async () => {
    listDir.mockResolvedValue([
      {name: 'src', path: 'src', isDir: true, size: 0, gitStatus: 'none', hasChildren: true, ignored: false},
      {name: 'a.ts', path: 'a.ts', isDir: false, size: 10, gitStatus: 'M', hasChildren: false, ignored: false},
    ])
    render(<FileTree />)
    expect(await screen.findByText('src')).toBeInTheDocument()
    // 状态色走令牌（.pm-c--M → var(--vcs-modified)），不再写死 Darcula hex
    expect(screen.getByText('a.ts')).toHaveStyle({color: 'var(--vcs-modified)'})
  })

  it('根节点存在（workspace 基名 "ws"）且默认展开', async () => {
    listDir.mockResolvedValue([
      {name: 'src', path: 'src', isDir: true, size: 0, gitStatus: 'none', hasChildren: true, ignored: false},
    ])
    render(<FileTree />)
    // 根节点文本
    const root = await screen.findByRole('treeitem', {name: 'ws'})
    expect(root).toBeInTheDocument()
    // 子节点默认展开可见
    expect(screen.getByRole('treeitem', {name: 'src'})).toBeInTheDocument()
  })

  it('根节点带条目计数 trailing', async () => {
    listDir.mockResolvedValue([
      {name: 'src', path: 'src', isDir: true, size: 0, gitStatus: 'none', hasChildren: true, ignored: false},
      {name: 'a.ts', path: 'a.ts', isDir: false, size: 10, gitStatus: 'none', hasChildren: false, ignored: false},
    ])
    render(<FileTree />)
    const root = await screen.findByRole('treeitem', {name: 'ws'})
    expect(root.textContent).toContain('2')
  })

  it('点击根节点 chevron 折叠整棵树（隐藏所有子条目）', async () => {
    listDir.mockResolvedValue([
      {name: 'src', path: 'src', isDir: true, size: 0, gitStatus: 'none', hasChildren: true, ignored: false},
    ])
    render(<FileTree />)
    const root = await screen.findByRole('treeitem', {name: 'ws'})
    const chevron = root.querySelector('[role="button"]')!
    fireEvent.click(chevron)
    // 子条目已隐藏
    expect(screen.queryByRole('treeitem', {name: 'src'})).toBeNull()
    // 根节点自身仍存在
    expect(screen.getByRole('treeitem', {name: 'ws'})).toBeInTheDocument()
  })

  it('chevron 独立 span 存在（文件行 = 占位；目录行 = 按钮）', async () => {
    listDir.mockResolvedValue([
      {name: 'src', path: 'src', isDir: true, size: 0, gitStatus: 'none', hasChildren: true, ignored: false},
      {name: 'a.ts', path: 'a.ts', isDir: false, size: 10, gitStatus: 'none', hasChildren: false, ignored: false},
    ])
    render(<FileTree />)
    const dirRow = await screen.findByRole('treeitem', {name: 'src'})
    const dirChevron = dirRow.querySelector('[role="button"]')
    expect(dirChevron).not.toBeNull()
    expect(dirChevron).toHaveAttribute('aria-label', '展开')      // 目录行有真 chevron
    // 文件行 chevron 退化为占位 span：无 role、无 aria-label
    const fileRow = screen.getByRole('treeitem', {name: 'a.ts'})
    expect(fileRow.querySelector('[role="button"]')).toBeNull()
  })

  it('点击 chevron 只切换展开不选行', async () => {
    listDir.mockResolvedValue([
      {name: 'src', path: 'src', isDir: true, size: 0, gitStatus: 'none', hasChildren: true, ignored: false},
    ])
    listDir.mockResolvedValueOnce([
      {name: 'src', path: 'src', isDir: true, size: 0, gitStatus: 'none', hasChildren: true, ignored: false},
    ])
    listDir.mockResolvedValueOnce([
      {name: 'b.ts', path: 'src/b.ts', isDir: false, size: 5, gitStatus: 'none', hasChildren: false, ignored: false},
    ])
    render(<FileTree />)
    const row = await screen.findByRole('treeitem', {name: 'src'})
    const chevron = row.querySelector('[role="button"]')!
    // 先点 chevron（展开并触发懒加载）
    fireEvent.click(chevron)
    expect(await screen.findByRole('treeitem', {name: 'b.ts'})).toBeInTheDocument()
    // 选中态应保持空（点 chevron 不选行）
    expect(useFileTreeStore.getState().selectedPath).toBeNull()
  })

  it('点击目录行只选中不切换展开', async () => {
    listDir.mockResolvedValue([
      {name: 'src', path: 'src', isDir: true, size: 0, gitStatus: 'none', hasChildren: true, ignored: false},
    ])
    render(<FileTree />)
    const row = await screen.findByRole('treeitem', {name: 'src'})
    // 点击行文本（不是 chevron）
    fireEvent.click(row)
    // 选中态更新
    expect(useFileTreeStore.getState().selectedPath).toBe('src')
    // 展开态未变（初始为折叠）
    expect(useFileTreeStore.getState().expanded.has('src')).toBe(false)
    // 子条目未渲染
    expect(screen.queryByRole('treeitem', {name: /b\.ts/})).toBeNull()
  })

  it('点击 chevron 展开目录触发懒加载', async () => {
    listDir.mockResolvedValueOnce([{name: 'src', path: 'src', isDir: true, size: 0, gitStatus: 'none', hasChildren: true, ignored: false}])
    listDir.mockResolvedValueOnce([{name: 'b.ts', path: 'src/b.ts', isDir: false, size: 5, gitStatus: 'none', hasChildren: false, ignored: false}])
    render(<FileTree />)
    const row = await screen.findByRole('treeitem', {name: 'src'})
    const chevron = row.querySelector('[role="button"]')!
    fireEvent.click(chevron)
    expect(await screen.findByRole('treeitem', {name: 'b.ts'})).toBeInTheDocument()
    expect(listDir).toHaveBeenCalledWith('/ws', 'src')
  })

  it('>5MB 文件双击打开占位 tab（content 为空，title 含"过大"）', async () => {
    listDir.mockResolvedValue([{name: 'big.bin', path: 'big.bin', isDir: false, size: 6 * 1024 * 1024, gitStatus: 'none', hasChildren: false, ignored: false}])
    readFile.mockResolvedValue({path: 'big.bin', size: 6 * 1024 * 1024, content: null, isBinary: true, isImage: false, decodeError: false, mimeType: '', truncated: false, mtime: 0, hash: ''})
    render(<FileTree />)
    fireEvent.doubleClick(await screen.findByRole('treeitem', {name: 'big.bin'}))
    await waitFor(() => expect(useEditorTabStore.getState().tabs).toHaveLength(1))
    const tab = useEditorTabStore.getState().tabs[0]
    expect(tab.title).toContain('过大')
    expect(tab.title).toMatch(/6\.0 MB/)
    expect(tab.content).toBe('')
    expect(tab.fileHash).toBe('')
  })

  it('1-5MB 文件正常打开：content 回填且 tab 保留 size', async () => {
    listDir.mockResolvedValue([{name: 'mid.ts', path: 'mid.ts', isDir: false, size: 2 * 1024 * 1024, gitStatus: 'none', hasChildren: false, ignored: false}])
    readFile.mockResolvedValue({path: 'mid.ts', size: 2 * 1024 * 1024, content: 'export {}', isBinary: false, isImage: false, decodeError: false, mimeType: '', truncated: false, mtime: 0, hash: 'h1'})
    render(<FileTree />)
    fireEvent.doubleClick(await screen.findByRole('treeitem', {name: 'mid.ts'}))
    await waitFor(() => expect(useEditorTabStore.getState().tabs).toHaveLength(1))
    const tab = useEditorTabStore.getState().tabs[0]
    expect(tab.title).toBe('mid.ts')
    expect(tab.content).toBe('export {}')
    expect(tab.fileHash).toBe('h1')
    expect(tab.size).toBe(2 * 1024 * 1024)
  })

  it('>5MB 图片同样走占位拦截（不转 base64）', async () => {
    listDir.mockResolvedValue([{name: 'big.png', path: 'big.png', isDir: false, size: 6 * 1024 * 1024, gitStatus: 'none', hasChildren: false, ignored: false}])
    readFile.mockResolvedValue({path: 'big.png', size: 6 * 1024 * 1024, content: null, isBinary: true, isImage: true, decodeError: false, mimeType: 'image/png', truncated: false, mtime: 0, hash: ''})
    render(<FileTree />)
    fireEvent.doubleClick(await screen.findByRole('treeitem', {name: 'big.png'}))
    await waitFor(() => expect(useEditorTabStore.getState().tabs).toHaveLength(1))
    const tab = useEditorTabStore.getState().tabs[0]
    expect(tab.title).toContain('过大')
    expect(tab.content).toBe('')
  })

  it('双击目录行切换展开（等价于点 chevron；不打开文件 tab）', async () => {
    listDir.mockResolvedValueOnce([{name: 'src', path: 'src', isDir: true, size: 0, gitStatus: 'none', hasChildren: true, ignored: false}])
    listDir.mockResolvedValueOnce([{name: 'b.ts', path: 'src/b.ts', isDir: false, size: 5, gitStatus: 'none', hasChildren: false, ignored: false}])
    render(<FileTree />)
    const row = await screen.findByRole('treeitem', {name: 'src'})
    // 初始 src 折叠
    expect(screen.queryByRole('treeitem', {name: 'b.ts'})).toBeNull()
    // 双击目录行 → 展开（触发懒加载）
    fireEvent.doubleClick(row)
    expect(await screen.findByRole('treeitem', {name: 'b.ts'})).toBeInTheDocument()
    expect(useFileTreeStore.getState().expanded.has('src')).toBe(true)
    // 双击再次 → 折叠
    fireEvent.doubleClick(screen.getByRole('treeitem', {name: 'src'}))
    expect(screen.queryByRole('treeitem', {name: 'b.ts'})).toBeNull()
    expect(useFileTreeStore.getState().expanded.has('src')).toBe(false)
    // 全程未打开文件 tab（目录行不参与文件打开逻辑）
    expect(useEditorTabStore.getState().tabs).toHaveLength(0)
  })

  it('I5 切换 workspace 后旧 readFile 迟到结果被丢弃', async () => {
    listDir.mockResolvedValue([{name: 'a.ts', path: 'a.ts', isDir: false, size: 10, gitStatus: 'none', hasChildren: false, ignored: false}])
    let resolveRead: (v: unknown) => void = () => {}
    readFile.mockImplementation(() => new Promise(res => { resolveRead = res }))
    render(<FileTree />)
    fireEvent.doubleClick(await screen.findByRole('treeitem', {name: 'a.ts'}))
    // 请求在途时切到另一个 workspace
    act(() => { useWorkspaceStore.setState({workspacePath: '/ws2'}) })
    resolveRead({path: 'a.ts', size: 10, content: 'x', isBinary: false, isImage: false, decodeError: false, mimeType: '', truncated: false, mtime: 0, hash: 'h'})
    await new Promise(r => setTimeout(r, 0))
    expect(useEditorTabStore.getState().tabs).toHaveLength(0)
  })
})

describe('FileTree 双击语义统一（R4 / spec §3.2）', () => {
  const entries = () => [
    {name: 'src', path: 'src', isDir: true, size: 0, gitStatus: 'none' as const, hasChildren: true, ignored: false},
  ]

  it('B14 双击 root 行体 → rootExpanded 恰好翻转一次', async () => {
    listDir.mockResolvedValue(entries())
    render(<FileTree />)
    const root = await screen.findByRole('treeitem', {name: 'ws'})
    doubleClickWithClicks(root, root)
    await waitFor(() => expect(screen.queryByRole('treeitem', {name: 'src'})).toBeNull())
    doubleClickWithClicks(screen.getByRole('treeitem', {name: 'ws'}), screen.getByRole('treeitem', {name: 'ws'}))
    expect(await screen.findByRole('treeitem', {name: 'src'})).toBeInTheDocument()
  })

  it('B15 双击 root 箭头 → rootExpanded 恰好翻转一次', async () => {
    listDir.mockResolvedValue(entries())
    render(<FileTree />)
    const root = await screen.findByRole('treeitem', {name: 'ws'})
    const chevron = root.querySelector('[role="button"]')!
    doubleClickWithClicks(chevron, chevron)
    await waitFor(() => expect(screen.queryByRole('treeitem', {name: 'src'})).toBeNull())
  })

  it('B16 单击 root 行体只选中，不改变展开态', async () => {
    listDir.mockResolvedValue(entries())
    render(<FileTree />)
    const root = await screen.findByRole('treeitem', {name: 'ws'})
    fireEvent.click(root)
    expect(useFileTreeStore.getState().selectedPath).toBe('.')
    expect(screen.getByRole('treeitem', {name: 'src'})).toBeInTheDocument()
  })

  it('B17 单击箭头：expanded 在同一 act 内立即包含该路径（同步性，不用 fake timers）', async () => {
    // 根目录返回 src；src 的懒加载必须返回非自引用条目，否则 renderEntries 会自递归爆栈
    listDir.mockResolvedValueOnce(entries())
    listDir.mockResolvedValue([])
    render(<FileTree />)
    const row = await screen.findByRole('treeitem', {name: 'src'})
    act(() => { fireEvent.click(row.querySelector('[role="button"]')!) })
    expect(useFileTreeStore.getState().expanded.has('src')).toBe(true)
    // 清空懒加载 Promise，避免其落地在 act 之外触发告警
    await act(async () => {})
  })
})

describe('FileTree 定位（R3 / spec §3.1）', () => {
  const setActiveFile = (filePath: string | undefined, type: 'file' | 'diff' = 'file') => {
    useEditorTabStore.setState({
      tabs: [{id: 't1', type, filePath, title: 't', pinned: false, externalChangeDetected: false} as never],
      activeTabId: 't1',
    })
  }

  it('B1 定位按钮的可访问名', async () => {
    listDir.mockResolvedValue([])
    render(<FileTree />)
    expect(await screen.findByRole('button', {name: '在文件树中定位当前文件'})).toBeInTheDocument()
  })

  it('B2 三态：无 tab / filePath 为空 → disabled；file tab 与 diff tab（都带 filePath）→ 可点', async () => {
    listDir.mockResolvedValue([])
    const {rerender} = render(<FileTree />)
    const btn = () => screen.getByRole('button', {name: '在文件树中定位当前文件'})
    expect(btn()).toBeDisabled()

    setActiveFile(undefined)
    rerender(<FileTree />)
    expect(btn()).toBeDisabled()

    setActiveFile('a.ts')
    rerender(<FileTree />)
    expect(btn()).toBeEnabled()

    // diff tab 同样携带 filePath（openDiffTab 的调用点都传了），因此也启用：
    // diff 视图不再单独放按钮，统一复用文件树头部这一个
    setActiveFile('a.ts', 'diff')
    rerender(<FileTree />)
    expect(btn()).toBeEnabled()
  })

  it('B2b diff tab 激活时点击 → 定位该 diff 的文件（diff 视图复用同一按钮）', async () => {
    listDir.mockImplementation(async (_ws: string, dir: string) =>
      dir === '.' ? [dirEntry('a', 'a')] : dir === 'a' ? [dirEntry('b', 'a/b')] : [fileEntry('c.ts', 'a/b/c.ts')])
    const {rerender} = render(<FileTree />)
    await screen.findByRole('treeitem', {name: 'ws'})
    setActiveFile('a/b/c.ts', 'diff')
    rerender(<FileTree />)   // 必须重渲染：否则 click 闭包仍持有旧的 activeFilePath（undefined）
    expect(screen.getByRole('button', {name: '在文件树中定位当前文件'})).toBeEnabled()
    act(() => { fireEvent.click(screen.getByRole('button', {name: '在文件树中定位当前文件'})) })
    await waitFor(() => expect(listDir).toHaveBeenCalledWith('/ws', 'a'))
    await waitFor(() => {
      const inst = scrollSpy.mock.instances[scrollSpy.mock.instances.length - 1] as unknown as HTMLElement
      expect(inst?.dataset?.path).toBe('a/b/c.ts')
    })
  })

  it('B3 完整定位：展开祖先、选中目标、不含 "."、root 展开', async () => {
    listDir.mockImplementation(async (_ws: string, dir: string) =>
      dir === '.' ? [dirEntry('a', 'a')] : dir === 'a' ? [dirEntry('b', 'a/b')] : [fileEntry('c.ts', 'a/b/c.ts')])
    render(<FileTree />)
    await screen.findByRole('treeitem', {name: 'ws'})
    act(() => { useFileTreeStore.getState().requestReveal('a/b/c.ts') })
    await waitFor(() => expect(useFileTreeStore.getState().selectedPath).toBe('a/b/c.ts'))
    const st = useFileTreeStore.getState()
    expect(st.expanded.has('a')).toBe(true)
    expect(st.expanded.has('a/b')).toBe(true)
    expect(st.expanded.has('.')).toBe(false)
    expect(st.revealTarget).toBeNull()
  })

  it('B4 滚动断言到元素身份（不是"被调用过"）', async () => {
    listDir.mockImplementation(async (_ws: string, dir: string) =>
      dir === '.' ? [dirEntry('a', 'a')] : dir === 'a' ? [dirEntry('b', 'a/b')] : [fileEntry('c.ts', 'a/b/c.ts')])
    render(<FileTree />)
    await screen.findByRole('treeitem', {name: 'ws'})
    act(() => { useFileTreeStore.getState().requestReveal('a/b/c.ts') })
    await waitFor(() => expect(useFileTreeStore.getState().revealTarget).toBeNull())
    const last = scrollSpy.mock.instances[scrollSpy.mock.instances.length - 1] as unknown as HTMLElement
    expect(last.dataset.path).toBe('a/b/c.ts')
  })

  it('B5 行尚未渲染时不动（父目录 promise 未 resolve 前不滚动）', async () => {
    let resolveA: (v: DirEntry[]) => void = () => {}
    listDir.mockImplementation(async (_ws: string, dir: string) => {
      if (dir === '.') return [dirEntry('a', 'a')]
      if (dir === 'a') return new Promise(res => { resolveA = res })
      return []
    })
    render(<FileTree />)
    await screen.findByRole('treeitem', {name: 'ws'})
    act(() => { useFileTreeStore.getState().requestReveal('a/b/c.ts') })
    await waitFor(() => expect(listDir).toHaveBeenCalledWith('/ws', 'a'))
    expect(scrollSpy).not.toHaveBeenCalled()
    await act(async () => { resolveA([dirEntry('b', 'a/b')]) })
  })

  it('B6 单一路径：同一目录只被加载一次', async () => {
    listDir.mockImplementation(async (_ws: string, dir: string) =>
      dir === '.' ? [dirEntry('a', 'a')] : [fileEntry('x.ts', 'a/x.ts')])
    render(<FileTree />)
    await screen.findByRole('treeitem', {name: 'a'})
    act(() => { useFileTreeStore.getState().requestReveal('a/x.ts') })
    await waitFor(() => expect(useFileTreeStore.getState().revealTarget).toBeNull())
    expect(listDir.mock.calls.filter(c => c[1] === '.').length).toBe(1)
    expect(listDir.mock.calls.filter(c => c[1] === 'a').length).toBe(1)
  })

  it('B7 顺序语义：a 未 resolve 前不请求 a/b', async () => {
    let resolveA: (v: DirEntry[]) => void = () => {}
    listDir.mockImplementation(async (_ws: string, dir: string) => {
      if (dir === '.') return [dirEntry('a', 'a')]
      if (dir === 'a') return new Promise(res => { resolveA = res })
      return []
    })
    render(<FileTree />)
    await screen.findByRole('treeitem', {name: 'ws'})
    act(() => { useFileTreeStore.getState().requestReveal('a/b/c.ts') })
    await waitFor(() => expect(listDir).toHaveBeenCalledWith('/ws', 'a'))
    expect(listDir.mock.calls.some(c => c[1] === 'a/b')).toBe(false)
    await act(async () => { resolveA([dirEntry('b', 'a/b')]) })
  })

  it('B8 CSS.escape 转义：路径含空格 / # / 引号仍能命中', async () => {
    listDir.mockImplementation(async (_ws: string, dir: string) =>
      dir === '.' ? [dirEntry('a b', 'a b'), fileEntry('q.ts', 'a b/c#d"e.ts', false)]
        : [fileEntry('q.ts', 'a b/c#d"e.ts')])
    render(<FileTree />)
    await screen.findByRole('treeitem', {name: 'ws'})
    act(() => { useFileTreeStore.getState().requestReveal('a b/c#d"e.ts') })
    await waitFor(() => expect(useFileTreeStore.getState().revealTarget).toBeNull())
    expect((scrollSpy.mock.instances[scrollSpy.mock.instances.length - 1] as unknown as HTMLElement).dataset.path).toBe('a b/c#d"e.ts')
  })

  it('B9 目标不存在 → 不抛错、不滚动、revealTarget 被清空', async () => {
    listDir.mockResolvedValue([dirEntry('a', 'a')])
    render(<FileTree />)
    await screen.findByRole('treeitem', {name: 'ws'})
    act(() => { useFileTreeStore.getState().requestReveal('nope/missing.ts') })
    await waitFor(() => expect(useFileTreeStore.getState().revealTarget).toBeNull())
    expect(scrollSpy).not.toHaveBeenCalled()
  })

  it('B10 归属守卫：加载途中切 ws → 不写 expanded、不滚动', async () => {
    let resolveA: (v: DirEntry[]) => void = () => {}
    listDir.mockImplementation(async (_ws: string, dir: string) => {
      if (dir === '.') return [dirEntry('a', 'a')]
      return new Promise(res => { resolveA = res })
    })
    render(<FileTree />)
    await screen.findByRole('treeitem', {name: 'ws'})
    act(() => { useFileTreeStore.getState().requestReveal('a/x.ts') })
    await waitFor(() => expect(listDir).toHaveBeenCalledWith('/ws', 'a'))
    act(() => { useWorkspaceStore.setState({workspacePath: '/ws2'}) })
    await act(async () => { resolveA([fileEntry('x.ts', 'a/x.ts')]) })
    expect(useFileTreeStore.getState().expanded.has('a')).toBe(false)
    expect(scrollSpy).not.toHaveBeenCalled()
  })

  it('B11 归属守卫（卸载）：卸载后不写 expanded、无 React 警告', async () => {
    let resolveA: (v: DirEntry[]) => void = () => {}
    listDir.mockImplementation(async (_ws: string, dir: string) => {
      if (dir === '.') return [dirEntry('a', 'a')]
      return new Promise(res => { resolveA = res })
    })
    const {unmount} = render(<FileTree />)
    await screen.findByRole('treeitem', {name: 'ws'})
    act(() => { useFileTreeStore.getState().requestReveal('a/x.ts') })
    await waitFor(() => expect(listDir).toHaveBeenCalledWith('/ws', 'a'))
    unmount()
    await act(async () => { resolveA([fileEntry('x.ts', 'a/x.ts')]) })
    expect(scrollSpy).not.toHaveBeenCalled()
  })

  it('B12 被忽略目标：showIgnored 关闭时自动打开后再定位', async () => {
    listDir.mockResolvedValue([fileEntry('ign.log', 'ign.log', true)])
    render(<FileTree />)
    await screen.findByRole('treeitem', {name: 'ws'})
    // 关闭「显示被忽略文件」
    fireEvent.click(screen.getByRole('button', {name: '隐藏被忽略文件'}))
    expect(screen.queryByRole('treeitem', {name: 'ign.log'})).toBeNull()
    act(() => { useFileTreeStore.getState().requestReveal('ign.log') })
    await waitFor(() => expect(useFileTreeStore.getState().revealTarget).toBeNull())
    expect(screen.getByRole('treeitem', {name: 'ign.log'})).toBeInTheDocument()
  })

  it('B13 定位进行中按钮 disabled 且连点只跑一轮', async () => {
    let resolveA: (v: DirEntry[]) => void = () => {}
    listDir.mockImplementation(async (_ws: string, dir: string) => {
      if (dir === '.') return [dirEntry('a', 'a')]
      return new Promise(res => { resolveA = res })
    })
    setActiveFile('a/x.ts')
    render(<FileTree />)
    await screen.findByRole('treeitem', {name: 'ws'})
    const btn = screen.getByRole('button', {name: '在文件树中定位当前文件'})
    act(() => { fireEvent.click(btn) })
    await waitFor(() => expect(listDir).toHaveBeenCalledWith('/ws', 'a'))
    // 进行中：按钮置灰，再点不再发起请求
    expect(screen.getByRole('button', {name: '在文件树中定位当前文件'})).toBeDisabled()
    fireEvent.click(screen.getByRole('button', {name: '在文件树中定位当前文件'}))
    expect(listDir.mock.calls.filter(c => c[1] === 'a').length).toBe(1)
    await act(async () => { resolveA([fileEntry('x.ts', 'a/x.ts')]) })
  })

  it('B24 重叠请求：旧请求后落地不覆盖新请求', async () => {
    let resolveA: (v: DirEntry[]) => void = () => {}
    listDir.mockImplementation(async (_ws: string, dir: string) => {
      if (dir === '.') return [dirEntry('a', 'a'), dirEntry('b', 'b')]
      if (dir === 'a') return new Promise(res => { resolveA = res })
      if (dir === 'b') return [fileEntry('y.ts', 'b/y.ts')]
      return []
    })
    render(<FileTree />)
    await screen.findByRole('treeitem', {name: 'ws'})

    // 1) 请求 A：其祖先目录 a 的加载挂起（deferredA）
    act(() => { useFileTreeStore.getState().requestReveal('a/x.ts') })
    await waitFor(() => expect(listDir).toHaveBeenCalledWith('/ws', 'a'))

    // 2) 请求 B：b 立即 resolve，B 完整落地
    act(() => { useFileTreeStore.getState().requestReveal('b/y.ts') })
    await waitFor(() => expect(useFileTreeStore.getState().selectedPath).toBe('b/y.ts'))
    await waitFor(() => expect(useFileTreeStore.getState().revealTarget).toBeNull())

    // 3) 旧请求 A 迟到落地：不得覆盖新请求
    await act(async () => { resolveA([fileEntry('x.ts', 'a/x.ts')]) })

    expect(useFileTreeStore.getState().selectedPath).toBe('b/y.ts')
    const last = scrollSpy.mock.instances[scrollSpy.mock.instances.length - 1] as unknown as HTMLElement
    expect(last.dataset.path).toBe('b/y.ts')
    const st = useFileTreeStore.getState()
    expect(st.expanded.has('b')).toBe(true)
    expect(st.expanded.has('a')).toBe(false)
  })
})


describe('FileTree 全部展开（R5 / spec §3.3）', () => {
  const dirEntry = (path: string) =>
    ({name: path.split('/').pop()!, path, isDir: true, size: 0, gitStatus: 'none' as const, hasChildren: true, ignored: false})

  /** 造一棵「root 下串行 n 个平铺目录」的树，便于精确控制目录计数 */
  it('B18 递归加载全部目录 + root 展开', async () => {
    listDir.mockImplementation(async (_ws: string, dir: string) =>
      dir === '.' ? [dirEntry('a'), dirEntry('b')]
        : dir === 'a' ? [dirEntry('a/x')]
        : dir === 'a/x' ? [] : [])
    render(<FileTree />)
    await screen.findByRole('treeitem', {name: 'ws'})
    fireEvent.click(screen.getByRole('button', {name: '全部展开'}))
    await waitFor(() => expect(useFileTreeStore.getState().expanded.has('a/x')).toBe(true))
    const st = useFileTreeStore.getState()
    expect(st.expanded.has('a')).toBe(true)
    expect(st.expanded.has('b')).toBe(true)
    expect(st.childrenCache['a/x']).toBeDefined()
    expect(confirmMock).not.toHaveBeenCalled()
  })

  it('B19 触顶边界量化：401 个目录 → 提示且 expanded.size === 400', async () => {
    const names = Array.from({length: 401}, (_, i) => `d${i}`)
    listDir.mockImplementation(async (_ws: string, dir: string) => (dir === '.' ? names.map(dirEntry) : []))
    render(<FileTree />)
    await screen.findByRole('treeitem', {name: 'ws'})
    fireEvent.click(screen.getByRole('button', {name: '全部展开'}))
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1))
    expect(useFileTreeStore.getState().expanded.size).toBe(400)
    expect(confirmMock.mock.calls[0]![0]).toMatchObject({confirmText: '知道了'})
  })

  it('B20 恰 400 个目录 → 不提示且全展', async () => {
    const names = Array.from({length: 400}, (_, i) => `d${i}`)
    listDir.mockImplementation(async (_ws: string, dir: string) => (dir === '.' ? names.map(dirEntry) : []))
    render(<FileTree />)
    await screen.findByRole('treeitem', {name: 'ws'})
    fireEvent.click(screen.getByRole('button', {name: '全部展开'}))
    await waitFor(() => expect(useFileTreeStore.getState().expanded.size).toBe(400))
    expect(confirmMock).not.toHaveBeenCalled()
  })

  it('B21 无假展开：expanded 中每个目录都能在 childrenCache 命中', async () => {
    const names = Array.from({length: 401}, (_, i) => `d${i}`)
    listDir.mockImplementation(async (_ws: string, dir: string) => (dir === '.' ? names.map(dirEntry) : []))
    render(<FileTree />)
    await screen.findByRole('treeitem', {name: 'ws'})
    fireEvent.click(screen.getByRole('button', {name: '全部展开'}))
    await waitFor(() => expect(confirmMock).toHaveBeenCalled())
    const {expanded, childrenCache} = useFileTreeStore.getState()
    for (const d of expanded) expect(childrenCache[d]).toBeDefined()
  })

  it('B25 全展期间 childrenCache 只提交一次（禁止逐目录提交放大成全树重渲）', async () => {
    const names = Array.from({length: 12}, (_, i) => `d${i}`)   // 3 个批次：多批次才有意义
    listDir.mockImplementation(async (_ws: string, dir: string) => (dir === '.' ? names.map(dirEntry) : []))
    let commits = 0
    const unsub = useFileTreeStore.subscribe((s, prev) => {
      if (s.childrenCache !== prev.childrenCache) commits++
    })
    render(<FileTree />)
    await screen.findByRole('treeitem', {name: 'ws'})
    commits = 0                                                 // 忽略首屏 root 加载
    fireEvent.click(screen.getByRole('button', {name: '全部展开'}))
    await waitFor(() => expect(useFileTreeStore.getState().expanded.size).toBe(12))
    unsub()
    expect(commits).toBe(1)
    // 语义不变：批量提交后每个目录（含 root）都在缓存中
    expect(Object.keys(useFileTreeStore.getState().childrenCache).sort()).toEqual(['.', ...names].sort())
  })

  it('B23 受控并发：在途 listDirectory 不超过 4', async () => {
    let inFlight = 0
    let maxInFlight = 0
    listDir.mockImplementation(async (_ws: string, dir: string) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(r => setTimeout(r, 0))
      inFlight--
      return dir === '.' ? Array.from({length: 12}, (_, i) => dirEntry(`d${i}`)) : []
    })
    render(<FileTree />)
    await screen.findByRole('treeitem', {name: 'ws'})
    fireEvent.click(screen.getByRole('button', {name: '全部展开'}))
    await waitFor(() => expect(useFileTreeStore.getState().expanded.size).toBe(12))
    expect(maxInFlight).toBeLessThanOrEqual(4)
  })

  it('B22 执行中按钮 disabled', async () => {
    listDir.mockImplementation(async (_ws: string, dir: string) =>
      dir === '.' ? [dirEntry('d0')] : new Promise(r => setTimeout(() => r([]), 5)) as never)
    render(<FileTree />)
    await screen.findByRole('treeitem', {name: 'ws'})
    fireEvent.click(screen.getByRole('button', {name: '全部展开'}))
    expect(screen.getByRole('button', {name: '全部展开'})).toBeDisabled()
    await waitFor(() => expect(screen.getByRole('button', {name: '全部展开'})).toBeEnabled())
  })
})

describe('FileTree 未跟踪行徽章（R1 作用范围守卫）', () => {
  it('A4 作用范围守卫：文件树未跟踪行仍渲染 ?? 徽章（本次只改变更列表）', async () => {
    listDir.mockResolvedValue([{name: 'u.txt', path: 'u.txt', isDir: false, size: 1, gitStatus: '??', hasChildren: false, ignored: false}])
    render(<FileTree />)
    const row = await screen.findByRole('treeitem', {name: 'u.txt'})
    expect(row.querySelector('[data-testid="status-badge"]')).toHaveTextContent('??')
  })
})

describe('FileTree 外部变更后补齐缓存（invalidateFrom → invalidateTick）', () => {
  it('根目录被失效后自动重取，行不消失', async () => {
    listDir.mockResolvedValue([fileEntry('a.ts', 'a.ts')])
    render(<FileTree />)
    expect(await screen.findByRole('treeitem', {name: 'a.ts'})).toBeInTheDocument()

    listDir.mockClear()
    act(() => { useFileTreeStore.getState().invalidateFrom('.') })
    // 锁定 bug 现象：invalidateFrom 只清缓存不重取 → 根行在，子项消失
    expect(screen.queryByRole('treeitem', {name: 'a.ts'})).toBeNull()

    // 去抖 500ms 后应自动补齐根目录，行重新出现
    await waitFor(() => expect(listDir).toHaveBeenCalledWith('/ws', '.'), {timeout: 2000})
    expect(await screen.findByRole('treeitem', {name: 'a.ts'})).toBeInTheDocument()
  })

  it('已展开子目录被失效后自动重取，子项不消失', async () => {
    listDir.mockImplementation(async (_ws: string, dir: string) =>
      dir === '.' ? [dirEntry('src', 'src')] : [fileEntry('x.ts', 'src/x.ts')])
    render(<FileTree />)
    const srcRow = await screen.findByRole('treeitem', {name: 'src'})
    fireEvent.click(srcRow.querySelector('[role="button"]')!)
    expect(await screen.findByRole('treeitem', {name: 'x.ts'})).toBeInTheDocument()

    listDir.mockClear()
    act(() => { useFileTreeStore.getState().invalidateFrom('src') })
    expect(screen.queryByRole('treeitem', {name: 'x.ts'})).toBeNull()

    await waitFor(() => expect(listDir).toHaveBeenCalledWith('/ws', 'src'), {timeout: 2000})
    expect(await screen.findByRole('treeitem', {name: 'x.ts'})).toBeInTheDocument()
  })
})

describe('FileTree 右键删除（danger）', () => {
  const deletePath = vi.fn(async () => {})

  /** 公共前置：挂载文件树并打开 a.ts 的右键菜单（三条用例只差对 deletePath 的打桩） */
  const openDeleteMenu = async () => {
    listDir.mockResolvedValue([fileEntry('a.ts', 'a.ts')])
    render(<FileTree />)
    fireEvent.contextMenu(await screen.findByRole('treeitem', {name: 'a.ts'}))
  }

  beforeEach(() => {
    // 文件级 beforeEach 未挂 deletePath，删除用例在此补齐
    deletePath.mockReset().mockResolvedValue(undefined)
    ;(window as any).electronAPI = {projectManager: {listDirectory: listDir, readFile, deletePath}}
  })

  it('菜单含「删除」危险项，确认后调用 deletePath', async () => {
    await openDeleteMenu()
    const item = screen.getByRole('menuitem', {name: '删除'})
    expect(item).toHaveClass('pm-context-menu-item--danger')
    fireEvent.click(item)
    await waitFor(() => expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({
      title: '删除', confirmText: '删除', confirmVariant: 'danger',
    })))
    await waitFor(() => expect(deletePath).toHaveBeenCalledWith('/ws', 'a.ts'))
  })

  it('取消确认时不调用 deletePath', async () => {
    confirmMock.mockResolvedValue(false)
    await openDeleteMenu()
    fireEvent.click(screen.getByRole('menuitem', {name: '删除'}))
    await waitFor(() => expect(confirmMock).toHaveBeenCalled())
    expect(deletePath).not.toHaveBeenCalled()
  })

  it('删除失败弹「删除失败」提示', async () => {
    deletePath.mockRejectedValueOnce(new Error('EPERM'))
    await openDeleteMenu()
    fireEvent.click(screen.getByRole('menuitem', {name: '删除'}))
    await waitFor(() => expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({title: '删除失败', confirmText: '知道了'})))
  })
})
