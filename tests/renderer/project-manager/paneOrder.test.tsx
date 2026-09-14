// tests/renderer/project-manager/paneOrder.test.tsx
// @vitest-environment jsdom
import {describe, it, expect, beforeEach} from 'vitest'
import {renderHook, act} from '@testing-library/react'
import {
  PANE_IDS, DEFAULT_ORDER, normalizeOrder, readPaneOrder, patchPaneOrder, usePaneOrder, type PaneId,
} from '../../../src/renderer/project-manager/hooks/paneOrder'
import {paneLayoutKey, patchPaneLayout} from '../../../src/renderer/project-manager/hooks/usePaneSize'

const KEY = paneLayoutKey('/ws')
const read = () => JSON.parse(localStorage.getItem(KEY)!) as Record<string, unknown>

beforeEach(() => localStorage.clear())

describe('normalizeOrder', () => {
  it('合法的排列原样返回（默认顺序 + 任意旋转）', () => {
    expect(normalizeOrder(['fileTree', 'editor', 'changes'])).toEqual(['fileTree', 'editor', 'changes'])
    expect(normalizeOrder(['editor', 'changes', 'fileTree'])).toEqual(['editor', 'changes', 'fileTree'])
    expect(normalizeOrder(['changes', 'fileTree', 'editor'])).toEqual(['changes', 'fileTree', 'editor'])
  })

  it('非数组一律回落默认顺序', () => {
    for (const raw of [undefined, null, 'fileTree', 42, {}, [['fileTree']]]) {
      expect(normalizeOrder(raw), String(raw)).toEqual(DEFAULT_ORDER)
    }
  })

  it('长度不是 3 一律回落默认顺序', () => {
    expect(normalizeOrder(['fileTree', 'editor'])).toEqual(DEFAULT_ORDER)
    expect(normalizeOrder(['fileTree', 'editor', 'changes', 'changes'])).toEqual(DEFAULT_ORDER)
    expect(normalizeOrder([])).toEqual(DEFAULT_ORDER)
  })

  it('含未知 id 一律回落默认顺序', () => {
    expect(normalizeOrder(['fileTree', 'editor', 'editorx'])).toEqual(DEFAULT_ORDER)
  })

  it('含重复 id 一律回落默认顺序（哪怕长度恰好是 3）', () => {
    expect(normalizeOrder(['editor', 'editor', 'changes'])).toEqual(DEFAULT_ORDER)
    expect(normalizeOrder(['fileTree', 'fileTree', 'fileTree'])).toEqual(DEFAULT_ORDER)
  })

  it('返回的是新数组，调用方改写不会污染 DEFAULT_ORDER', () => {
    const got = normalizeOrder(['fileTree', 'editor', 'changes'])
    got[0] = 'editor'
    expect(DEFAULT_ORDER).toEqual(['fileTree', 'editor', 'changes'])
  })
})

describe('readPaneOrder', () => {
  it('无记录 → 默认顺序', () => {
    expect(readPaneOrder('/ws')).toEqual(DEFAULT_ORDER)
  })

  it('空 workspacePath → 默认顺序（不读盘）', () => {
    localStorage.setItem(paneLayoutKey(''), JSON.stringify({order: ['editor', 'fileTree', 'changes']}))
    expect(readPaneOrder('')).toEqual(DEFAULT_ORDER)
  })

  it('损坏的 JSON → 默认顺序，不抛错', () => {
    localStorage.setItem(KEY, '{ not json')
    expect(readPaneOrder('/ws')).toEqual(DEFAULT_ORDER)
  })

  it('顶层是数组 / 字符串 → 默认顺序', () => {
    localStorage.setItem(KEY, JSON.stringify(['fileTree', 'editor', 'changes']))
    expect(readPaneOrder('/ws')).toEqual(DEFAULT_ORDER)
    localStorage.setItem(KEY, JSON.stringify('nope'))
    expect(readPaneOrder('/ws')).toEqual(DEFAULT_ORDER)
  })

  it('记录里没有 order 字段 → 默认顺序', () => {
    localStorage.setItem(KEY, JSON.stringify({sizes: {fileTree: 300}}))
    expect(readPaneOrder('/ws')).toEqual(DEFAULT_ORDER)
  })

  it('记录了非法 order → 默认顺序', () => {
    localStorage.setItem(KEY, JSON.stringify({order: ['editor', 'editor', 'changes']}))
    expect(readPaneOrder('/ws')).toEqual(DEFAULT_ORDER)
  })

  it('记录了合法 order → 原样读回', () => {
    localStorage.setItem(KEY, JSON.stringify({order: ['changes', 'fileTree', 'editor']}))
    expect(readPaneOrder('/ws')).toEqual(['changes', 'fileTree', 'editor'])
  })

  it('按 workspace 分键：另一个仓库的记录互不可见', () => {
    localStorage.setItem(paneLayoutKey('/a'), JSON.stringify({order: ['editor', 'fileTree', 'changes']}))
    expect(readPaneOrder('/a')).toEqual(['editor', 'fileTree', 'changes'])
    expect(readPaneOrder('/b')).toEqual(DEFAULT_ORDER)
  })

  it('通过 patchPaneLayout 写入的 order 也能读回（两条通道同构）', () => {
    patchPaneLayout('/ws', {order: ['changes', 'editor', 'fileTree']})
    expect(readPaneOrder('/ws')).toEqual(['changes', 'editor', 'fileTree'])
  })
})

describe('patchPaneOrder', () => {
  it('只写 order，保留既有 sizes / gitCollapsed 键', () => {
    localStorage.setItem(KEY, JSON.stringify({sizes: {fileTree: 300, changes: 260}, gitCollapsed: true}))
    patchPaneOrder('/ws', ['editor', 'fileTree', 'changes'])
    const stored = read()
    expect(stored.order).toEqual(['editor', 'fileTree', 'changes'])
    expect(stored.sizes).toEqual({fileTree: 300, changes: 260})
    expect(stored.gitCollapsed).toBe(true)
  })

  it('无既有记录时也能写入（sizes 保持空对象，不凭空造出尺寸键）', () => {
    patchPaneOrder('/ws', ['changes', 'editor', 'fileTree'])
    expect(read()).toEqual({order: ['changes', 'editor', 'fileTree'], sizes: {}})
  })
})

describe('usePaneOrder', () => {
  it('初始顺序取自 localStorage', () => {
    localStorage.setItem(KEY, JSON.stringify({order: ['changes', 'fileTree', 'editor']}))
    const {result} = renderHook(() => usePaneOrder('/ws'))
    expect(result.current.order).toEqual(['changes', 'fileTree', 'editor'])
  })

  it('commitOrder 更新内存状态并落盘，且不动 sizes', () => {
    localStorage.setItem(KEY, JSON.stringify({sizes: {fileTree: 300}}))
    const {result} = renderHook(() => usePaneOrder('/ws'))
    act(() => result.current.commitOrder(['editor', 'fileTree', 'changes']))
    expect(result.current.order).toEqual(['editor', 'fileTree', 'changes'])
    expect(read().order).toEqual(['editor', 'fileTree', 'changes'])
    expect(read().sizes).toEqual({fileTree: 300})
  })

  it('commitOrder 传入非法排列时按默认顺序落盘（写入侧也归一化）', () => {
    const {result} = renderHook(() => usePaneOrder('/ws'))
    act(() => result.current.commitOrder(['editor', 'editor', 'changes'] as PaneId[]))
    expect(result.current.order).toEqual(DEFAULT_ORDER)
    expect(read().order).toEqual(DEFAULT_ORDER)
  })

  it('重挂载从 localStorage 恢复', () => {
    const first = renderHook(() => usePaneOrder('/ws'))
    act(() => first.result.current.commitOrder(['changes', 'editor', 'fileTree']))
    first.unmount()
    const second = renderHook(() => usePaneOrder('/ws'))
    expect(second.result.current.order).toEqual(['changes', 'editor', 'fileTree'])
  })

  it('切 workspace 重读该仓库自己的值（无记录 ⇒ 默认）', () => {
    localStorage.setItem(paneLayoutKey('/a'), JSON.stringify({order: ['changes', 'editor', 'fileTree']}))
    const {result, rerender} = renderHook(({ws}) => usePaneOrder(ws), {initialProps: {ws: '/a'}})
    expect(result.current.order).toEqual(['changes', 'editor', 'fileTree'])
    rerender({ws: '/b'})
    expect(result.current.order).toEqual(DEFAULT_ORDER)
    rerender({ws: '/a'})
    expect(result.current.order).toEqual(['changes', 'editor', 'fileTree'])
  })

  it('PANE_IDS 与 order 的合法值集合一致（3 个 id，editor 必在其内）', () => {
    expect([...PANE_IDS]).toEqual(['fileTree', 'editor', 'changes'])
    expect(DEFAULT_ORDER).toEqual([...PANE_IDS])
  })
})
