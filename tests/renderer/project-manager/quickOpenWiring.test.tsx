// @vitest-environment jsdom
/**
 * QuickOpen 在 **App 层**的接线（工单 06 的回归缺口）：`ProjectManagerApp.tsx` 里的
 * 「`quickOpen.mode !== null` 条件渲染 + 15 个 props 传递」过去只靠 tsc 兜着，没有任何测试。
 * 用户报的原始 bug 恰好就在这一层（接线断了 ≠ 组件坏）：hook、组件各自单测全绿，浮层却打不开。
 *
 * 断言只针对外部可观察行为：浮层是否出现 / 以什么模式出现、列表是否渲染出命中行、
 * 加载态是否出现过、发给主进程的 IPC 调用、Esc 是否卸载浮层。
 * 不测浮层手感与 rg 真实行为（spec §Testing Decisions）。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, act} from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import {ProjectManagerApp} from '../../../src/renderer/project-manager/ProjectManagerApp'
import {useEditorTabStore} from '../../../src/renderer/project-manager/stores/editorTabStore'
import {useFileTreeStore} from '../../../src/renderer/project-manager/stores/fileTreeStore'

const WS = '/ws'

/** 暴露在 window 上的 preload 桥；每个用例重建 */
const pmWindow = window as unknown as {electronAPI?: unknown}

function mockPM() {
  const pm = {
    workspacePath: WS,
    listDirectory: vi.fn(async () => []),
    readFile: vi.fn(async () => ({
      path: 'src/app.ts', size: 12, content: 'const a = 1', isBinary: false, isImage: false,
      decodeError: false, mimeType: '', truncated: false, mtime: 0, hash: 'h1',
    })),
    readLines: vi.fn(async () => ({
      path: 'src/app.ts', startLine: 1, endLine: 1, totalLines: 1, lines: ['const a = 1'], size: 12, mtime: 0,
    })),
    searchFiles: vi.fn(async () => [{path: 'src/app.ts', matchStart: 4, matchEnd: 7}]),
    findInFilesStart: vi.fn(async () => ({sessionId: 's1'})),
    findInFilesPage: vi.fn(async () => ({matches: [], truncated: false, done: true})),
    findInFilesStop: vi.fn(async () => {}),
    gitStatus: vi.fn(async () => ({statusMap: {}, additions: 0, deletions: 0, updatedAt: 1})),
    gitLog: vi.fn(async () => []),
    gitBranches: vi.fn(async () => []),
    gitDiffFile: vi.fn(async () => ({
      filePath: 'a.ts', oldContent: '', newContent: '', diffType: 'working-tree',
      oldRef: 'HEAD', newRef: 'worktree', additions: 0, deletions: 0,
    })),
    gitShowCommit: vi.fn(async () => ({hash: '', message: '', files: []})),
    gitShowDetail: vi.fn(async () => ''),
    gitAdd: vi.fn(async () => {}),
    gitRmCached: vi.fn(async () => {}),
    onStatusChanged: vi.fn(() => () => {}),
    onRefsChanged: vi.fn(() => () => {}),
    onFileChanged: vi.fn(() => () => {}),
  }
  pmWindow.electronAPI = {projectManager: pm}
  return pm
}

/** 拦截快捷键：useQuickOpen 的监听器挂在 document 的 capture 阶段 */
function pressKey(init: KeyboardEventInit) {
  const evt = new KeyboardEvent('keydown', {bubbles: true, cancelable: true, ...init})
  act(() => { document.dispatchEvent(evt) })
  return evt
}

/** 推进防抖计时器并把落地的 promise 链跑完 */
async function flush(ms = 120) {
  act(() => { vi.advanceTimersByTime(ms) })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  mockPM()
  useEditorTabStore.getState().closeAll()
  useFileTreeStore.setState({expanded: new Set(), childrenCache: {}, cacheOrder: [], selectedPath: null})
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ProjectManagerApp 的 QuickOpen 接线', () => {
  it('Ctrl+Shift+N：浮层出现 → 加载态 → 命中行渲染 → Esc 卸载浮层', async () => {
    const pm = mockPM()
    render(<ProjectManagerApp />)

    // 1) 快捷键呼出：浮层以 file-search 模式出现（条件渲染这一层是过去的覆盖缺口）
    pressKey({ctrlKey: true, shiftKey: true, key: 'N'})
    const overlay = screen.getByTestId('pm-quickopen')
    expect(overlay).toHaveAttribute('data-mode', 'file-search')

    // 2) 输入后先进加载态，120ms 防抖内不发请求
    fireEvent.change(screen.getByTestId('pm-quickopen-input'), {target: {value: 'app'}})
    expect(screen.getByTestId('pm-quickopen-loading')).toBeInTheDocument()
    expect(pm.searchFiles).not.toHaveBeenCalled()

    // 3) 防抖到点：取数、加载态消失、命中行落在列表里
    await flush(120)
    expect(pm.searchFiles).toHaveBeenCalledWith(WS, 'app', 50)
    expect(screen.queryByTestId('pm-quickopen-loading')).toBeNull()
    const rows = screen.getAllByTestId('pm-quickopen-row')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveAttribute('data-path', 'src/app.ts')

    // 4) Esc：浮层整棵卸载（不是隐藏）
    pressKey({key: 'Escape'})
    expect(screen.queryByTestId('pm-quickopen')).toBeNull()
  })

  it('Ctrl+Shift+F：以 find-in-files 模式出现，输入后发出 findInFilesStart', async () => {
    const pm = mockPM()
    render(<ProjectManagerApp />)

    pressKey({ctrlKey: true, shiftKey: true, key: 'F'})
    expect(screen.getByTestId('pm-quickopen')).toHaveAttribute('data-mode', 'find-in-files')

    fireEvent.change(screen.getByTestId('pm-quickopen-input'), {target: {value: 'foo'}})
    await flush(120)

    expect(pm.findInFilesStart).toHaveBeenCalledWith(WS, 'foo')
  })
})
