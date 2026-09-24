// tests/renderer/project-manager/shortcutHelpDialog.test.tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import {beforeEach, describe, expect, it} from 'vitest'
import {fireEvent, render, screen} from '@testing-library/react'
import {StatusBar} from '../../../src/renderer/project-manager/components/StatusBar'
import {useGitStatusStore} from '../../../src/renderer/project-manager/stores/gitStatusStore'
import {quickOpenBindings} from '../../../src/renderer/project-manager/lib/quickOpenKeymap'
import {IS_MAC} from '../../../src/renderer/lib/platform'
import type {GitStatus} from '../../../src/shared/types/project-manager'

const WS = 'E:/ws/pm'
const UPDATED_AT = new Date('2026-09-23T10:20:30').getTime()

const changed = (path: string): GitStatus => ({path, status: 'M', indexStatus: ' ', worktreeStatus: 'M'})

beforeEach(() => {
  ;(window as any).electronAPI = {projectManager: {workspacePath: WS}}
  useGitStatusStore.setState({
    ws: WS,
    generation: 1,
    loading: false,
    summary: {
      statusMap: {'a.ts': changed('a.ts'), 'b.ts': changed('b.ts')},
      additions: 7,
      deletions: 3,
      updatedAt: UPDATED_AT,
    },
  })
})

/** Kbd 的显示口径（与 components/common/Kbd.tsx 的 displayKey 对 CommandOrControl 的解析一致） */
const displayKey = (key: string) => (key === 'CommandOrControl' ? (IS_MAC ? '⌘' : 'Ctrl') : key)

/** 取某一行渲染出的键位文本（kbd 文本按 '+' 连接，与键位串同形，便于逐字比对） */
function rowKeys(label: string): string {
  const row = screen.getByText(label).closest('[data-testid="pm-shortcut-help-row"]')
  if (!row) throw new Error(`未找到快捷键行: ${label}`)
  return Array.from(row.querySelectorAll('kbd')).map(k => k.textContent ?? '').join('+')
}

function renderStatusBar() {
  render(<StatusBar branchName="main"/>)
}

function openDialog() {
  renderStatusBar()
  fireEvent.click(screen.getByRole('button', {name: '快捷键说明'}))
  return screen.getByRole('dialog')
}

describe('ShortcutHelpDialog', () => {
  it('状态栏按钮打开弹窗：模态语义 + 四个档位标题齐备', () => {
    const dialog = openDialog()
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveTextContent('快捷键说明')
    for (const title of ['呼出（PM 窗口内全局生效）', 'QuickOpen 浮层内', '编辑区 / 差异视图（按行选中）', '面板拖拽重排中']) {
      expect(dialog).toHaveTextContent(title)
    }
  })

  it('呼出三键文案 = quickOpenBindings(IS_MAC) 计算值（改键位表必红）', () => {
    openDialog()
    const bindings = quickOpenBindings(IS_MAC)
    const expected = (acc: string) => acc.split('+').map(displayKey).join('+')
    expect(rowKeys('文件搜索')).toBe(expected(bindings.quickOpenFileSearch))
    expect(rowKeys('最近文件')).toBe(expected(bindings.quickOpenRecentFiles))
    expect(rowKeys('全局搜索（在文件中查找）')).toBe(expected(bindings.quickOpenFindInFiles))
  })

  it('Esc 关闭弹窗', () => {
    openDialog()
    fireEvent.keyDown(document, {key: 'Escape'})
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('点击遮罩关闭弹窗', () => {
    openDialog()
    fireEvent.click(screen.getByTestId('pm-shortcut-help-backdrop'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('点击关闭按钮关闭弹窗', () => {
    openDialog()
    fireEvent.click(screen.getByRole('button', {name: '关闭'}))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('关闭后 Esc 监听已解绑（不残留 document 监听副作用）', () => {
    openDialog()
    fireEvent.click(screen.getByRole('button', {name: '关闭'}))
    expect(() => fireEvent.keyDown(document, {key: 'Escape'})).not.toThrow()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('回归：状态栏原有三段信息仍在（路径 / 变更统计 / 时间）', () => {
    renderStatusBar()
    const bar = document.querySelector('.pm-status-bar')!
    expect(bar.textContent).toContain('pm')
    expect(bar.textContent).toContain('main')
    expect(bar.textContent).toContain('已更改 2 个文件 · +7 · −3')
    expect(bar.textContent).toContain(new Date(UPDATED_AT).toLocaleTimeString())
    expect(bar.querySelector('.pm-status-bar-path')).toBeInTheDocument()
  })
})
