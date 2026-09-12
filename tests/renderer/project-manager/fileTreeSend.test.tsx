// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {render, screen, fireEvent} from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import {FileTree} from '../../../src/renderer/project-manager/components/FileTree'
import {SendToConversationProvider} from '../../../src/renderer/project-manager/ui/SendToConversationProvider'
import {useFileTreeStore} from '../../../src/renderer/project-manager/stores/fileTreeStore'
import {useEditorTabStore} from '../../../src/renderer/project-manager/stores/editorTabStore'
import {useGitStatusStore} from '../../../src/renderer/project-manager/stores/gitStatusStore'
import {useWorkspaceStore} from '../../../src/renderer/project-manager/stores/workspaceStore'

const listDir = vi.fn()
const entry = (name: string, path: string, isDir: boolean) => ({
  name, path, isDir, size: 1, gitStatus: 'none' as const, hasChildren: isDir, ignored: false,
})

const ROOT = [entry('src', 'src', true), entry('a.ts', 'a.ts', false), entry('b.ts', 'b.ts', false)]

beforeEach(() => {
  listDir.mockReset()
  ;(window as any).electronAPI = {
    projectManager: {listDirectory: listDir, workspacePath: '/ws'},
    conversationListByWorkspace: vi.fn(async () => []),
  }
  useWorkspaceStore.setState({workspacePath: '/ws'})
  useFileTreeStore.setState({expanded: new Set(), childrenCache: {}, cacheOrder: [], selectedPath: null, selectedPaths: new Set(), anchorPath: null})
  useEditorTabStore.setState({tabs: [], activeTabId: null})
  useGitStatusStore.setState({summary: null})
})

function renderTree() {
  listDir.mockResolvedValue(ROOT)
  return render(<SendToConversationProvider><FileTree /></SendToConversationProvider>)
}

describe('FileTree 发送到会话', () => {
  it('目录行菜单项置灰并给出原因', async () => {
    renderTree()
    fireEvent.contextMenu(await screen.findByRole('treeitem', {name: 'src'}))
    const item = screen.getByRole('menuitem', {name: '发送到会话'})
    expect(item).toBeDisabled()
    expect(item).toHaveAttribute('title', '目录不支持发送')
  })

  it('文件行点击「发送到会话」打开弹窗，预览为绝对路径', async () => {
    renderTree()
    fireEvent.contextMenu(await screen.findByRole('treeitem', {name: 'a.ts'}))
    fireEvent.click(screen.getByRole('menuitem', {name: '发送到会话'}))
    expect(screen.getByTestId('pm-send-dialog-preview')).toHaveTextContent('/ws/a.ts')
  })

  it('Ctrl 多选后右键集合内行，发送全部选中文件', async () => {
    renderTree()
    const a = await screen.findByRole('treeitem', {name: 'a.ts'})
    const b = screen.getByRole('treeitem', {name: 'b.ts'})
    fireEvent.click(a)
    fireEvent.click(b, {ctrlKey: true})
    // 右键集合内的 a.ts（不应清空选择）
    fireEvent.contextMenu(a)
    fireEvent.click(screen.getByRole('menuitem', {name: '发送到会话'}))
    const preview = await screen.findByTestId('pm-send-dialog-preview')
    expect(preview).toHaveTextContent('/ws/a.ts')
    expect(preview).toHaveTextContent('/ws/b.ts')
  })

  // F1 顺序回归：多选「先点靠后、再点靠前」的文件，发送顺序必须按可见顺序（flatOrder），
  // 而非 Set 插入序（点击序）。旧实现 [...selectedPaths] → b.ts,a.ts，本用例会失败。
  it('多选乱序后发送，paths 按可见顺序（b 先点、a 后点 → a,b）', async () => {
    renderTree()
    const a = await screen.findByRole('treeitem', {name: 'a.ts'})
    const b = screen.getByRole('treeitem', {name: 'b.ts'})
    fireEvent.click(b)
    fireEvent.click(a, {ctrlKey: true})
    // 自证插入序确为乱序（点击序）
    expect([...useFileTreeStore.getState().selectedPaths]).toEqual(['b.ts', 'a.ts'])
    fireEvent.contextMenu(a)
    fireEvent.click(screen.getByRole('menuitem', {name: '发送到会话'}))
    const preview = await screen.findByTestId('pm-send-dialog-preview')
    expect(preview.textContent).toBe('/ws/a.ts\n/ws/b.ts')   // 可见顺序
  })

  // F1 副作用回归：折叠目录**不**清除选中集合。发送时必须保留「已选中但当前不可见」的条目，
  // 只按可见顺序排序（不可见项排末尾）；不得用 filter 把成员一起裁剪掉。
  it('折叠目录后发送仍包含被折叠目录下已选中的文件（排序不丢成员）', async () => {
    listDir.mockImplementation(async (_ws: string, path: string) =>
      path === 'src'
        ? [entry('a.ts', 'src/a.ts', false)]
        : [entry('src', 'src', true), entry('b.ts', 'b.ts', false)])
    render(<SendToConversationProvider><FileTree /></SendToConversationProvider>)

    // 展开 src 露出 src/a.ts
    const srcRow = await screen.findByRole('treeitem', {name: 'src'})
    fireEvent.click(srcRow.querySelector('[role="button"]')!)
    const a = await screen.findByRole('treeitem', {name: 'a.ts'})

    // 跨目录选中 src/a.ts 与 b.ts
    fireEvent.click(a)
    fireEvent.click(screen.getByRole('treeitem', {name: 'b.ts'}), {ctrlKey: true})
    expect([...useFileTreeStore.getState().selectedPaths].sort()).toEqual(['b.ts', 'src/a.ts'])

    // 折叠 src：a.ts 从可见行消失，但选中集合不变
    fireEvent.click(srcRow.querySelector('[role="button"]')!)
    expect(screen.queryByRole('treeitem', {name: 'a.ts'})).toBeNull()
    expect(useFileTreeStore.getState().selectedPaths.has('src/a.ts')).toBe(true)

    // 右键仍可见的 b.ts → 发送：paths 必须同时含 b.ts 与 src/a.ts
    fireEvent.contextMenu(screen.getByRole('treeitem', {name: 'b.ts'}))
    fireEvent.click(screen.getByRole('menuitem', {name: '发送到会话'}))
    const preview = await screen.findByTestId('pm-send-dialog-preview')
    // 可见顺序在前（b.ts），被折叠的不可见项在末尾（src/a.ts）
    expect(preview.textContent).toBe('/ws/b.ts\n/ws/src/a.ts')
  })

  // F2：选中集合含目录时置灰并给出原因（目录行与文件行走同一 select）
  it('Ctrl 混选目录+文件后，右键集合内文件 → 菜单置灰并给出原因', async () => {
    renderTree()
    const a = await screen.findByRole('treeitem', {name: 'a.ts'})
    const src = screen.getByRole('treeitem', {name: 'src'})
    fireEvent.click(a)
    fireEvent.click(src, {ctrlKey: true})
    fireEvent.contextMenu(a)
    const item = screen.getByRole('menuitem', {name: '发送到会话'})
    expect(item).toBeDisabled()
    expect(item).toHaveAttribute('title', '选中项包含目录，不能发送')
  })

  it('单击选中文件行（不再依赖右键）', async () => {
    renderTree()
    fireEvent.click(await screen.findByRole('treeitem', {name: 'a.ts'}))
    expect(useFileTreeStore.getState().selectedPath).toBe('a.ts')
    expect([...useFileTreeStore.getState().selectedPaths]).toEqual(['a.ts'])
  })
})
