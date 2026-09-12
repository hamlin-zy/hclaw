// tests/renderer/project-manager/usePaneSize.test.tsx
// @vitest-environment jsdom
import {describe, it, expect, beforeEach} from 'vitest'
import {renderHook, act} from '@testing-library/react'
import {
  usePaneSize, readPaneLayout, writePaneLayout, patchPaneLayout, paneLayoutKey, clampPane,
  GIT_HEIGHT_KEY, COLLAPSED_GIT_HEIGHT, type PaneSizeSpecs,
} from '../../../src/renderer/project-manager/hooks/usePaneSize'

const SPECS: PaneSizeSpecs = {
  fileTree: {default: 200, min: 140, max: 420},
  changes: {default: 210, min: 200, max: 420},
  branches: {default: 186, min: 150, max: 380},
  detail: {default: 236, min: 220, max: 480},
  [GIT_HEIGHT_KEY]: {default: 236, min: 120, max: 100000},
}

beforeEach(() => localStorage.clear())

describe('clampPane', () => {
  it('夹紧到 [min, max]', () => {
    expect(clampPane(50, SPECS.fileTree)).toBe(140)
    expect(clampPane(9999, SPECS.fileTree)).toBe(420)
    expect(clampPane(260, SPECS.fileTree)).toBe(260)
  })
  it('非有限数回落默认值', () => {
    expect(clampPane(undefined, SPECS.fileTree)).toBe(200)
    expect(clampPane('abc', SPECS.fileTree)).toBe(200)
    expect(clampPane(NaN, SPECS.fileTree)).toBe(200)
    expect(clampPane(Infinity, SPECS.fileTree)).toBe(200)
  })
  it('数字字符串可被接受（localStorage 往返）', () => {
    expect(clampPane('260', SPECS.fileTree)).toBe(260)
  })
})

describe('readPaneLayout / writePaneLayout', () => {
  it('无存储时全部回落默认值', () => {
    const layout = readPaneLayout('/ws', SPECS)
    expect(layout.sizes).toEqual({fileTree: 200, changes: 210, branches: 186, detail: 236, gitHeight: 236})
    expect(layout.gitCollapsed).toBe(false)
    expect(layout.gitHeightBeforeCollapse).toBe(236)
  })

  it('往返：写入后读回一致', () => {
    writePaneLayout('/ws', {sizes: {fileTree: 300, changes: 240, branches: 200, detail: 300, gitHeight: 400}, gitCollapsed: false, gitHeightBeforeCollapse: 236})
    const layout = readPaneLayout('/ws', SPECS)
    expect(layout.sizes.fileTree).toBe(300)
    expect(layout.sizes.gitHeight).toBe(400)
  })

  it('越界值被夹紧，不抛错', () => {
    localStorage.setItem(paneLayoutKey('/ws'), JSON.stringify({sizes: {fileTree: 5, detail: 99999}, gitCollapsed: false, gitHeightBeforeCollapse: -1}))
    const layout = readPaneLayout('/ws', SPECS)
    expect(layout.sizes.fileTree).toBe(140)
    expect(layout.sizes.detail).toBe(480)
    expect(layout.gitHeightBeforeCollapse).toBe(120)
  })

  it('损坏的 JSON 回落默认值，不抛错', () => {
    localStorage.setItem(paneLayoutKey('/ws'), '{ not json')
    expect(readPaneLayout('/ws', SPECS).sizes.fileTree).toBe(200)
  })

  it('缺字段的对象回落默认值', () => {
    localStorage.setItem(paneLayoutKey('/ws'), JSON.stringify({}))
    expect(readPaneLayout('/ws', SPECS).sizes.fileTree).toBe(200)
  })

  it('不同 workspace 互不干扰', () => {
    writePaneLayout('/a', {sizes: {fileTree: 300, changes: 210, branches: 186, detail: 236, gitHeight: 236}, gitCollapsed: false, gitHeightBeforeCollapse: 236})
    expect(readPaneLayout('/a', SPECS).sizes.fileTree).toBe(300)
    expect(readPaneLayout('/b', SPECS).sizes.fileTree).toBe(200)
  })

  it('key 形如 pm:layout:<workspacePath>', () => {
    expect(paneLayoutKey('E:\\proj\\app')).toBe('pm:layout:E:\\proj\\app')
  })
})

describe('usePaneSize', () => {
  it('commitSize 提交后写盘且夹紧', () => {
    const {result} = renderHook(() => usePaneSize('/ws', SPECS))
    act(() => result.current.commitSize('fileTree', 310))
    expect(result.current.sizes.fileTree).toBe(310)
    expect(JSON.parse(localStorage.getItem(paneLayoutKey('/ws'))!).sizes.fileTree).toBe(310)

    act(() => result.current.commitSize('fileTree', 1))
    expect(result.current.sizes.fileTree).toBe(140)
  })

  it('提交 Git 区高度会顺带解除折叠', () => {
    const {result} = renderHook(() => usePaneSize('/ws', SPECS))
    act(() => result.current.setGitCollapsed(true))
    expect(result.current.gitCollapsed).toBe(true)
    act(() => result.current.commitSize(GIT_HEIGHT_KEY, 320))
    expect(result.current.gitCollapsed).toBe(false)
    expect(result.current.sizes.gitHeight).toBe(320)
  })

  it('折叠记录当前高度并收到 22px；展开还原（持久化）', () => {
    const {result} = renderHook(() => usePaneSize('/ws', SPECS))
    act(() => result.current.commitSize(GIT_HEIGHT_KEY, 380))
    act(() => result.current.setGitCollapsed(true))
    expect(result.current.sizes.gitHeight).toBe(COLLAPSED_GIT_HEIGHT)
    expect(JSON.parse(localStorage.getItem(paneLayoutKey('/ws'))!).gitHeightBeforeCollapse).toBe(380)

    act(() => result.current.setGitCollapsed(false))
    expect(result.current.sizes.gitHeight).toBe(380)
  })

  it('重挂载后从 localStorage 恢复（含折叠态）', () => {
    const first = renderHook(() => usePaneSize('/ws', SPECS))
    act(() => first.result.current.commitSize('detail', 300))
    act(() => first.result.current.setGitCollapsed(true))
    first.unmount()

    const second = renderHook(() => usePaneSize('/ws', SPECS))
    expect(second.result.current.sizes.detail).toBe(300)
    expect(second.result.current.gitCollapsed).toBe(true)
  })

  it('切换 workspace 时重新读取该仓库的布局', () => {
    writePaneLayout('/a', {sizes: {fileTree: 300, changes: 210, branches: 186, detail: 236, gitHeight: 236}, gitCollapsed: false, gitHeightBeforeCollapse: 236})
    const {result, rerender} = renderHook(({ws}) => usePaneSize(ws, SPECS), {initialProps: {ws: '/b'}})
    expect(result.current.sizes.fileTree).toBe(200)
    rerender({ws: '/a'})
    expect(result.current.sizes.fileTree).toBe(300)
  })

  it('未知 key 的 commitSize 不改变状态', () => {
    const {result} = renderHook(() => usePaneSize('/ws', SPECS))
    act(() => result.current.commitSize('nope', 999))
    expect(result.current.sizes).toEqual({fileTree: 200, changes: 210, branches: 186, detail: 236, gitHeight: 236})
  })

  it('patchPaneLayout 按 key 合并，不擦掉别的实例写的键', () => {
    // 模拟两个 usePaneSize 实例：先用整体写盘铺一份含 branches 的布局
    writePaneLayout('/ws', {sizes: {fileTree: 200, branches: 300}, gitCollapsed: false, gitHeightBeforeCollapse: 236})
    // 另一个实例只提交自己管的 fileTree
    patchPaneLayout('/ws', {sizes: {fileTree: 260}})
    const stored = JSON.parse(localStorage.getItem(paneLayoutKey('/ws'))!)
    expect(stored.sizes.fileTree).toBe(260)
    expect(stored.sizes.branches).toBe(300)   // ← 未被擦掉
  })

  it('两个 usePaneSize 实例共享同一 key 且互不覆盖', () => {
    const app = renderHook(() => usePaneSize('/ws', SPECS))
    const gitZone = renderHook(() => usePaneSize('/ws', {branches: {default: 186, min: 150, max: 380}, detail: {default: 236, min: 220, max: 480}}))

    act(() => app.result.current.commitSize('fileTree', 320))
    act(() => gitZone.result.current.commitSize('branches', 210))

    const stored = JSON.parse(localStorage.getItem(paneLayoutKey('/ws'))!)
    expect(stored.sizes.fileTree).toBe(320)
    expect(stored.sizes.branches).toBe(210)
  })
})
