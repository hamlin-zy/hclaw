// @vitest-environment jsdom
import {describe, it, expect, beforeAll, beforeEach} from 'vitest'
import {render, screen, fireEvent} from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import {readFileSync} from 'fs'
import {join} from 'path'
import {GitDagGraph} from '../../../src/renderer/project-manager/components/GitDagGraph'
import {useGitLogStore} from '../../../src/renderer/project-manager/stores/gitLogStore'
import type {GitLogEntry} from '../../../src/shared/types/project-manager'

// vitest.config.ts 未开启 css: true，globals.css 不会自动进入 jsdom。
// 本文件读的是 **class 驱动**的计算样式（fontFamily / flexGrow / whiteSpace / textOverflow /
// minWidth / height），故手动注入一次真实样式表
// （与 tests/renderer/project-manager/treeRow.test.tsx、FileTree.test.tsx 同源做法）。
beforeAll(() => {
  const css = readFileSync(join(process.cwd(), 'src/renderer/styles/globals.css'), 'utf-8')
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
})

const entry: GitLogEntry = {
  hash: 'a'.repeat(40),
  abbreviatedHash: 'a1b2c3d4e',
  parents: ['p1'],
  message: 'feat(pm): 一个很长很长很长很长很长很长很长很长很长很长很长的 commit 标题',
  body: '',
  author: 'Haoming Sun',
  authorEmail: 'x@y.z',
  authorDate: Date.parse('2020-01-15T10:00:00'),
  date: Date.now() - 3600_000,
  branches: ['main'],
  tags: ['v1.0'],
  isHead: true,
}

const setEntries = (entries: GitLogEntry[], selectedHash: string | null = null) =>
  useGitLogStore.setState({entries, selectedHash})

beforeEach(() => {
  setEntries([entry])
})

describe('Commit 行四段式（spec §9.1 / G9）', () => {
  it('渲染 rail / hash / subject / refs / author·time 五段', () => {
    render(<GitDagGraph sortAsc={false} />)
    const row = screen.getByTestId('pm-commit-row')
    expect(row.querySelector('.pm-commit-rail')).toBeTruthy()
    expect(row.querySelector('.pm-commit-hash')).toHaveTextContent('a1b2c3d4e')
    expect(row.querySelector('.pm-commit-subject')).toHaveTextContent('feat(pm)')
    expect(row.querySelector('.pm-commit-meta')).toHaveTextContent('Haoming Sun')
    expect(row.querySelector('.pm-commit-refs')).toBeTruthy()
  })

  it('hash 是等宽字体、固定宽度不参与收缩', () => {
    render(<GitDagGraph sortAsc={false} />)
    const hash = screen.getByTestId('pm-commit-row').querySelector('.pm-commit-hash') as HTMLElement
    expect(getComputedStyle(hash).fontFamily).toMatch(/mono/i)
    expect(getComputedStyle(hash).flexGrow).toBe('0')
  })

  it('subject 单行省略，flex:1 min-width:0', () => {
    render(<GitDagGraph sortAsc={false} />)
    const subject = screen.getByTestId('pm-commit-row').querySelector('.pm-commit-subject') as HTMLElement
    const cs = getComputedStyle(subject)
    expect(cs.whiteSpace).toBe('nowrap')
    expect(cs.textOverflow).toBe('ellipsis')
    expect(cs.minWidth).toBe('0px')
  })

  it('行高 26px（commit 列表专属尺度，spec §13.2）', () => {
    render(<GitDagGraph sortAsc={false} />)
    expect(getComputedStyle(screen.getByTestId('pm-commit-row')).height).toBe('26px')
  })

  it('subject 全文走 tooltip', () => {
    render(<GitDagGraph sortAsc={false} />)
    expect(screen.getByTestId('pm-commit-row')).toHaveAttribute('title', entry.message)
  })

  it('meta 是 author · 相对时间（用 authorDate，不是 committer date）', () => {
    // authorDate 是 2020 年 → 显示绝对日期；date 是 1 小时前。
    // 若实现误用 e.date，这里会得到 '1 小时前'，断言失败（spec §9.1 段名即「author · 相对时间」）。
    render(<GitDagGraph sortAsc={false} />)
    const meta = screen.getByTestId('pm-commit-row').querySelector('.pm-commit-meta') as HTMLElement
    expect(meta).toHaveTextContent('Haoming Sun')
    expect(meta.textContent).toMatch(/2020-01-15/)
  })

  it('HEAD 与 tag 徽章保留', () => {
    render(<GitDagGraph sortAsc={false} />)
    const refs = screen.getByTestId('pm-commit-row').querySelector('.pm-commit-refs')!
    expect(refs.textContent).toMatch(/HEAD/)
    expect(refs.textContent).toMatch(/tag:v1\.0/)
  })

  it('refs 为空时不渲染任何徽章', () => {
    setEntries([{...entry, branches: [], tags: [], isHead: false}])
    render(<GitDagGraph sortAsc={false} />)
    const refs = screen.getByTestId('pm-commit-row').querySelector('.pm-commit-refs') as HTMLElement
    expect(refs.textContent).toBe('')
    expect(refs.querySelectorAll('.pm-ref-badge')).toHaveLength(0)
  })

  it('选中态走 is-selected 类', () => {
    setEntries([entry], entry.hash)
    render(<GitDagGraph sortAsc={false} />)
    const row = screen.getByTestId('pm-commit-row')
    expect(row).toHaveClass('is-selected')
    expect(row).toHaveAttribute('aria-selected', 'true')
  })

  it('回归：行内恰好五段（rail / hash / subject / refs / meta）', () => {
    render(<GitDagGraph sortAsc={false} />)
    const row = screen.getByTestId('pm-commit-row')
    expect(row.children).toHaveLength(5)   // rail / hash / subject / refs / meta
  })
})

// 行是 <div role="treeitem">（不是 <button>），行内文本默认可被浏览器原生选区选中：
// 普通单击会把 caret 落在行内成为 selection anchor，此后的 Shift+单击会触发原生「扩展选区」
// → 视觉上出现一段被选中的文字（用户报告的缺陷）。
// 列表行是选择控件、文本本就不该可选（.pm-tree-row 用 <button> 天然如此），
// 故左键按下即 preventDefault 抑制原生文本选择；右键必须放行，交给 onContextMenu 弹菜单。
describe('Commit 行不发生原生文本选择（Shift 区间选的副作用）', () => {
  it('左键 mousedown 被 preventDefault（抑制原生选区，含 Shift 扩展）', () => {
    render(<GitDagGraph sortAsc={false} />)
    const row = screen.getByTestId('pm-commit-row')
    expect(fireEvent.mouseDown(row, {button: 0})).toBe(false)
    expect(fireEvent.mouseDown(row, {button: 0, shiftKey: true})).toBe(false)
  })

  it('右键 mousedown 放行：不吞掉上下文菜单', () => {
    render(<GitDagGraph sortAsc={false} />)
    const row = screen.getByTestId('pm-commit-row')
    expect(fireEvent.mouseDown(row, {button: 2})).toBe(true)
  })

  it('Shift 区间选语义不受影响（仍由 click 完成）', () => {
    const two = [entry, {...entry, hash: 'b'.repeat(40), abbreviatedHash: 'b1b2c3d4e'}]
    setEntries(two)
    render(<GitDagGraph sortAsc={false} />)
    const rows = screen.getAllByTestId('pm-commit-row')
    fireEvent.click(rows[0])
    fireEvent.click(rows[1], {shiftKey: true})
    expect([...useGitLogStore.getState().selectedHashes]).toEqual([two[0].hash, two[1].hash])
  })
})
