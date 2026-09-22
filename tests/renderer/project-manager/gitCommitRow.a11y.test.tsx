// @vitest-environment jsdom
import {describe, it, expect, beforeEach, vi} from 'vitest'
import {render, screen, fireEvent} from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import {GitDagGraph} from '../../../src/renderer/project-manager/components/GitDagGraph'
import {useGitLogStore} from '../../../src/renderer/project-manager/stores/gitLogStore'
import type {GitLogEntry} from '../../../src/shared/types/project-manager'

// commit 行的键盘可达性（方案 C′：roving tabindex + 行内 onKeyDown）。
// jsdom 未实现 Element.scrollIntoView，而行导航后要把目标行滚入视区 → 注入 stub 防 TypeError。
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

const mk = (seed: string, subject: string): GitLogEntry => ({
  hash: seed.repeat(40),
  abbreviatedHash: seed.repeat(10),
  parents: ['p1'],
  message: subject,
  body: '',
  author: 'Haoming Sun',
  authorEmail: 'x@y.z',
  authorDate: Date.parse('2020-01-15T10:00:00'),
  date: Date.parse('2020-01-15T10:00:00'),
  branches: [],
  tags: [],
  isHead: false,
})

// 展示顺序 = entries 顺序（sortAsc=false 的默认口径）：A 最新、C 最旧
const A = mk('a', 'first')
const B = mk('b', 'second')
const C = mk('c', 'third')
const entries = [A, B, C]

const setState = (selectedHash: string | null) =>
  useGitLogStore.setState({
    entries,
    selectedHash,
    selectedHashes: new Set(selectedHash ? [selectedHash] : []),
    anchorHash: selectedHash,
  })

const rows = () => screen.getAllByTestId('pm-commit-row')
const selectedHash = () => useGitLogStore.getState().selectedHash

beforeEach(() => {
  setState(null)
})

describe('commit 行 roving tabindex', () => {
  it('选中行 tabIndex=0，其余行 -1', () => {
    setState(B.hash)
    render(<GitDagGraph />)
    const [r0, r1, r2] = rows()
    expect(r0).toHaveAttribute('tabindex', '-1')
    expect(r1).toHaveAttribute('tabindex', '0')
    expect(r2).toHaveAttribute('tabindex', '-1')
  })

  it('无选中时首行 tabIndex=0（Tab 可进入列表），其余行 -1', () => {
    render(<GitDagGraph />)
    const [r0, r1, r2] = rows()
    expect(r0).toHaveAttribute('tabindex', '0')
    expect(r1).toHaveAttribute('tabindex', '-1')
    expect(r2).toHaveAttribute('tabindex', '-1')
  })

  it('选中行不在当前列表（被过滤）时退化到首行 tabIndex=0', () => {
    useGitLogStore.setState({
      entries,
      selectedHash: 'z'.repeat(40),
      selectedHashes: new Set(['z'.repeat(40)]),
      anchorHash: 'z'.repeat(40),
    })
    render(<GitDagGraph />)
    const [r0, r1, r2] = rows()
    expect(r0).toHaveAttribute('tabindex', '0')
    expect(r1).toHaveAttribute('tabindex', '-1')
    expect(r2).toHaveAttribute('tabindex', '-1')
  })
})

describe('commit 行键盘导航（移动即选中）', () => {
  it('无选中时从首行起步：ArrowDown 选中第二行并把焦点移过去', () => {
    render(<GitDagGraph />)
    expect(selectedHash()).toBeNull()
    fireEvent.keyDown(rows()[0], {key: 'ArrowDown'})
    expect(selectedHash()).toBe(B.hash)
    expect(document.activeElement).toBe(rows()[1])
  })

  it('ArrowDown 选中下一行并把焦点移过去、滚入视区', () => {
    setState(A.hash)
    render(<GitDagGraph />)
    fireEvent.keyDown(rows()[0], {key: 'ArrowDown'})
    expect(selectedHash()).toBe(B.hash)
    expect(document.activeElement).toBe(rows()[1])
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
  })

  it('ArrowUp 选中上一行', () => {
    setState(C.hash)
    render(<GitDagGraph />)
    fireEvent.keyDown(rows()[2], {key: 'ArrowUp'})
    expect(selectedHash()).toBe(B.hash)
  })

  it('Home / End 跳到首行 / 末行', () => {
    setState(B.hash)
    render(<GitDagGraph />)
    fireEvent.keyDown(rows()[1], {key: 'End'})
    expect(selectedHash()).toBe(C.hash)
    fireEvent.keyDown(rows()[2], {key: 'Home'})
    expect(selectedHash()).toBe(A.hash)
  })

  it('边界处不越界：首行 ArrowUp 停在原位且不清空选中', () => {
    setState(A.hash)
    render(<GitDagGraph />)
    fireEvent.keyDown(rows()[0], {key: 'ArrowUp'})
    expect(selectedHash()).toBe(A.hash)
  })

  it('边界处不越界：末行 ArrowDown 停在原位且不清空选中', () => {
    setState(C.hash)
    render(<GitDagGraph />)
    fireEvent.keyDown(rows()[2], {key: 'ArrowDown'})
    expect(selectedHash()).toBe(C.hash)
  })
})

describe('commit 行 Enter / Space 等价鼠标单击', () => {
  it('Enter 选中当前行', () => {
    render(<GitDagGraph />)
    fireEvent.keyDown(rows()[1], {key: 'Enter'})
    expect(selectedHash()).toBe(B.hash)
  })

  it('Space 选中当前行', () => {
    render(<GitDagGraph />)
    fireEvent.keyDown(rows()[2], {key: ' '})
    expect(selectedHash()).toBe(C.hash)
  })

  it('Shift+Enter 保持区间选能力（mods 透传）', () => {
    setState(A.hash)
    render(<GitDagGraph />)
    fireEvent.keyDown(rows()[2], {key: 'Enter', shiftKey: true})
    expect([...useGitLogStore.getState().selectedHashes]).toEqual([A.hash, B.hash, C.hash])
  })

  it('Ctrl+Enter 保持多选切换能力（mods 透传）', () => {
    setState(A.hash)
    render(<GitDagGraph />)
    fireEvent.keyDown(rows()[1], {key: 'Enter', ctrlKey: true})
    expect([...useGitLogStore.getState().selectedHashes]).toEqual([A.hash, B.hash])
  })
})
