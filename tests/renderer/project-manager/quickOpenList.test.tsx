// @vitest-environment jsdom
/**
 * QuickOpen 列表的渲染行为（纯展示组件，不接 hook）。
 *
 * 保护：文件名 + 相对路径尾段的拼装、命中区间的 `<mark>` 切片（区间来自主进程，renderer 不重算）、
 * 加载中指示（用户明确抱怨过没有它）、空态与无结果文案、截断标注、键盘选中项高亮、
 * 点击列表项等同回车、Recent Files 的「清空记录」入口、失效条目标灰。
 *
 * 不测键位手感与 IPC（spec §Testing Decisions 明确不测）：键位语义在 useQuickOpen.test.tsx，
 * 数据来源在 useQuickOpen.test.tsx，本文件只喂 props 看渲染结果。
 */
import {describe, it, expect, vi} from 'vitest'
import {render, screen, fireEvent} from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import {QuickOpen, type QuickOpenProps} from '../../../src/renderer/project-manager/components/QuickOpen'
import type {QuickOpenItem} from '../../../src/renderer/project-manager/lib/quickOpenResults'

const NOW = Date.now()

function item(path: string, extra: Partial<QuickOpenItem> = {}): QuickOpenItem {
  return {path, matchStart: null, matchEnd: null, ...extra}
}

function renderQuickOpen(overrides: Partial<QuickOpenProps> = {}) {
  const props: QuickOpenProps = {
    mode: 'file-search',
    query: '',
    onQueryChange: vi.fn(),
    results: [],
    activeIndex: 0,
    loading: false,
    truncated: false,
    error: null,
    stalePaths: new Set<string>(),
    onActivate: vi.fn(),
    ...overrides,
  }
  return {...render(<QuickOpen {...props} />), props}
}

const rows = () => screen.queryAllByTestId('pm-quickopen-row')

describe('QuickOpen 列表渲染', () => {
  it('列表项拆成文件名 + 相对路径尾段', () => {
    renderQuickOpen({results: [item('src/renderer/components/QuickOpen.tsx')]})
    expect(rows()).toHaveLength(1)
    expect(rows()[0].querySelector('.pm-quickopen-row-name')).toHaveTextContent('QuickOpen.tsx')
    expect(rows()[0].querySelector('.pm-quickopen-row-dir')).toHaveTextContent('src/renderer/components/')
  })

  it('File Search：只高亮主进程给出的区间，且不重算匹配', () => {
    // 'src/app/QuickOpen.tsx' 中 'app' 位于 [4, 7)
    renderQuickOpen({results: [item('src/app/QuickOpen.tsx', {matchStart: 4, matchEnd: 7})]})
    const marks = rows()[0].querySelectorAll('mark')
    expect(marks).toHaveLength(1)
    expect(marks[0]).toHaveTextContent('app')
    // 命中区间落在目录段：文件名段不出现 mark
    expect(rows()[0].querySelector('.pm-quickopen-row-name mark')).toBeNull()
  })

  it('File Search：命中区间落在文件名段时高亮文件名', () => {
    renderQuickOpen({results: [item('src/QuickOpen.tsx', {matchStart: 4, matchEnd: 9})]})
    expect(rows()[0].querySelector('.pm-quickopen-row-name mark')).toHaveTextContent('Quick')
  })

  it('无命中区间（Recent Files）时不渲染任何 mark', () => {
    renderQuickOpen({mode: 'recent-files', results: [item('a/b.ts')]})
    expect(rows()[0].querySelectorAll('mark')).toHaveLength(0)
  })

  it('Recent Files 显示打开时间', () => {
    renderQuickOpen({mode: 'recent-files', results: [item('a/b.ts', {openedAt: NOW - 5 * 60_000})]})
    expect(rows()[0].querySelector('.pm-quickopen-row-time')).toHaveTextContent('分钟前')
  })

  it('加载中：显示带动画的状态行，且不显示空态', () => {
    renderQuickOpen({query: 'app', loading: true})
    const status = screen.getByTestId('pm-quickopen-loading')
    expect(status).toHaveTextContent('搜索中')
    // 动画载体：旋转图标挂既有 .pm-spin（globals.css 提供 keyframes）
    expect(status.querySelector('.pm-spin')).not.toBeNull()
    expect(screen.queryByTestId('pm-quickopen-empty')).toBeNull()
  })

  it('空查询：给出引导文案而不是空白列表', () => {
    renderQuickOpen({query: ''})
    expect(screen.getByTestId('pm-quickopen-empty')).toHaveTextContent('输入文件名片段开始搜索')
  })

  it('有查询但无结果：给出「无匹配文件」', () => {
    renderQuickOpen({query: 'zzz'})
    expect(screen.getByTestId('pm-quickopen-empty')).toHaveTextContent('无匹配文件')
  })

  it('Recent Files 空列表：给出「还没有打开过文件」', () => {
    renderQuickOpen({mode: 'recent-files'})
    expect(screen.getByTestId('pm-quickopen-empty')).toHaveTextContent('还没有打开过文件')
  })

  it('检索失败：错误文案占据空态位', () => {
    renderQuickOpen({query: 'app', error: '检索失败'})
    expect(screen.getByTestId('pm-quickopen-empty')).toHaveTextContent('检索失败')
  })

  it('结果被截断时给出标注', () => {
    renderQuickOpen({query: 'app', results: [item('a.ts')], truncated: true})
    expect(screen.getByTestId('pm-quickopen-truncated')).toHaveTextContent('仅显示前 50 条匹配')
  })

  it('键盘选中项：对应行 aria-selected 且有高亮类，其余行没有', () => {
    renderQuickOpen({query: 'a', results: [item('a.ts'), item('b.ts'), item('c.ts')], activeIndex: 1})
    expect(rows()[0]).toHaveAttribute('aria-selected', 'false')
    expect(rows()[1]).toHaveAttribute('aria-selected', 'true')
    expect(rows()[1]).toHaveClass('is-active')
    expect(rows()[2]).not.toHaveClass('is-active')
  })

  it('点击列表项等同回车：回调收到该行下标', () => {
    const onActivate = vi.fn()
    renderQuickOpen({query: 'a', results: [item('a.ts'), item('b.ts')], onActivate})
    fireEvent.click(rows()[1])
    expect(onActivate).toHaveBeenCalledWith(1)
  })

  it('Recent Files：有记录时提供「清空记录」入口，点击回调', () => {
    const onClearRecent = vi.fn()
    renderQuickOpen({mode: 'recent-files', results: [item('a.ts')], onClearRecent})
    fireEvent.click(screen.getByTestId('pm-quickopen-clear-recent'))
    expect(onClearRecent).toHaveBeenCalled()
  })

  it('Recent Files：列表为空时不显示「清空记录」', () => {
    renderQuickOpen({mode: 'recent-files', results: []})
    expect(screen.queryByTestId('pm-quickopen-clear-recent')).toBeNull()
  })

  it('打开失败的条目标灰并标注「已失效」，但仍留在列表里', () => {
    renderQuickOpen({
      mode: 'recent-files',
      results: [item('gone.ts'), item('here.ts')],
      stalePaths: new Set(['gone.ts']),
    })
    expect(rows()[0]).toHaveClass('is-stale')
    expect(rows()[0].querySelector('.pm-quickopen-row-flag')).toHaveTextContent('已失效')
    expect(rows()[1]).not.toHaveClass('is-stale')
  })

  it('预览区：无选中项时给提示，有选中项时给出完整相对路径（工单 04 的容器已就位）', () => {
    const {unmount} = renderQuickOpen({results: []})
    expect(screen.getByTestId('pm-quickopen-preview')).toHaveTextContent('上下键选择条目以查看预览')
    unmount()

    renderQuickOpen({results: [item('src/a.ts')]})
    expect(screen.getByTestId('pm-quickopen-preview')).toHaveTextContent('src/a.ts')
  })
})
