// @vitest-environment jsdom
import '@testing-library/jest-dom'
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, fireEvent, waitFor, act} from '@testing-library/react'
import {GitDagGraph} from '../../../src/renderer/project-manager/components/GitDagGraph'
import {useGitLogStore} from '../../../src/renderer/project-manager/stores/gitLogStore'
import {useWorkspaceStore} from '../../../src/renderer/project-manager/stores/workspaceStore'
import * as format from '../../../src/renderer/project-manager/utils/format'

const mk = (i: number) => ({
  hash: `hash${i}`, abbreviatedHash: `hash${i}`.slice(0, 9), parents: [], message: `commit ${i}`, body: '',
  author: 'a', authorEmail: 'a@a', authorDate: i, date: i, branches: [], tags: [], isHead: i === 0,
})

/** jsdom 里 scrollTop/scrollHeight/clientHeight 恒为 0，需手动补几何信息才能驱动滚动分支 */
function setGeometry(
  el: HTMLElement,
  {scrollTop, clientHeight, scrollHeight}: {scrollTop: number, clientHeight: number, scrollHeight: number},
) {
  Object.defineProperty(el, 'scrollTop', {value: scrollTop, writable: true, configurable: true})
  Object.defineProperty(el, 'clientHeight', {value: clientHeight, configurable: true})
  Object.defineProperty(el, 'scrollHeight', {value: scrollHeight, configurable: true})
}

const scrollElOf = (container: HTMLElement) => container.querySelector('.pm-commits-scroll') as HTMLElement

beforeEach(() => {
  useWorkspaceStore.setState({workspacePath: '/ws'})
  useGitLogStore.setState({
    entries: [], selectedHash: null, selectedHashes: new Set(), anchorHash: null,
    selectedBranch: null, pendingHeadRefresh: false, loading: false, hasMore: false, lastOptions: null,
  })
  ;(window as any).electronAPI = {projectManager: {gitLog: vi.fn(async () => [])}}
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('GitDagGraph 滚动语义：底部加载历史', () => {
  it('滚到底部（距 scrollHeight 阈值内）触发 loadMore，且 skip = 已加载条数', async () => {
    useGitLogStore.setState({
      entries: Array.from({length: 100}, (_, i) => mk(i)), hasMore: true, loading: false, lastOptions: {limit: 100},
    })
    const {container} = render(<GitDagGraph />)
    const el = scrollElOf(container)
    // 2600 + 400 = 3000 = scrollHeight → 严格触底
    setGeometry(el, {scrollTop: 2600, clientHeight: 400, scrollHeight: 3000})
    fireEvent.scroll(el)
    await waitFor(() => expect((window as any).electronAPI.projectManager.gitLog).toHaveBeenCalledTimes(1))
    expect((window as any).electronAPI.projectManager.gitLog).toHaveBeenCalledWith('/ws', {limit: 100, skip: 100})
  })

  it('阈值内的次触底（差 48px 以内）也触发（亚像素/事件丢失兜底）', async () => {
    useGitLogStore.setState({
      entries: Array.from({length: 100}, (_, i) => mk(i)), hasMore: true, loading: false, lastOptions: {limit: 100},
    })
    const {container} = render(<GitDagGraph />)
    const el = scrollElOf(container)
    // 2570 + 400 = 2970，距 3000 还差 30px（< 48）→ 命中阈值
    setGeometry(el, {scrollTop: 2570, clientHeight: 400, scrollHeight: 3000})
    fireEvent.scroll(el)
    await waitFor(() => expect((window as any).electronAPI.projectManager.gitLog).toHaveBeenCalledTimes(1))
  })

  it('滚到顶部不再触发 loadMore（顶部语义改为消费待刷新）', () => {
    useGitLogStore.setState({
      entries: Array.from({length: 100}, (_, i) => mk(i)), hasMore: true, loading: false, lastOptions: {limit: 100},
    })
    // spy 必须在 render 前装：组件渲染时从 store 取走 loadMore 引用
    const loadMoreSpy = vi.spyOn(useGitLogStore.getState(), 'loadMore').mockResolvedValue(undefined)
    const {container} = render(<GitDagGraph />)
    const el = scrollElOf(container)
    setGeometry(el, {scrollTop: 0, clientHeight: 400, scrollHeight: 8000})
    fireEvent.scroll(el)
    expect(loadMoreSpy).not.toHaveBeenCalled()
    loadMoreSpy.mockRestore()
  })
})

describe('GitDagGraph 触底 re-arm：滚动锚定不会连环翻页', () => {
  it('sortAsc：触发端在顶部，到顶只加载一页且 skip 连续', async () => {
    useGitLogStore.setState({
      entries: Array.from({length: 100}, (_, i) => mk(i)), hasMore: true, loading: false, lastOptions: {limit: 100},
    })
    const gitLog = (window as any).electronAPI.projectManager.gitLog
    // 按 skip 分页返回，保证追加后 hash 不重复；每页满 100 → hasMore 保持 true
    gitLog.mockImplementation(async (_ws: string, o: {skip?: number}) =>
      Array.from({length: 100}, (_, i) => mk((o.skip ?? 0) + i)))
    const {container} = render(<GitDagGraph sortAsc />)
    const el = scrollElOf(container)
    // 升序显示顺序被 reverse，更早历史插到**视觉顶部** → 触发端必须是顶部（≥1100 不在阈值内）
    setGeometry(el, {scrollTop: 0, clientHeight: 400, scrollHeight: 3000})
    fireEvent.scroll(el)
    await waitFor(() => expect(gitLog).toHaveBeenCalledTimes(1))
    expect(gitLog).toHaveBeenLastCalledWith('/ws', {limit: 100, skip: 100})
    // 模拟 Chromium 滚动锚定：新页插到顶部后为维持视口不动把 scrollTop 抬高（离开 ≤48 阈值）→
    // 只重新武装、不再触发；未修复时会连环翻页直到 MAX_LOG_ENTRIES。
    setGeometry(el, {scrollTop: 400, clientHeight: 400, scrollHeight: 3400})
    fireEvent.scroll(el)
    fireEvent.scroll(el)
    await act(async () => { await Promise.resolve() })
    expect(gitLog).toHaveBeenCalledTimes(1)
    // 用户继续上滚到顶部 → 再次触发下一页（滚离阈值后已重新武装）
    setGeometry(el, {scrollTop: 0, clientHeight: 400, scrollHeight: 3400})
    fireEvent.scroll(el)
    await waitFor(() => expect(gitLog).toHaveBeenCalledTimes(2))
    expect(gitLog).toHaveBeenLastCalledWith('/ws', {limit: 100, skip: 200})
  })

  it('sortAsc：停在顶部连续派发 scroll 只加载一页（不连环）', async () => {
    useGitLogStore.setState({
      entries: Array.from({length: 100}, (_, i) => mk(i)), hasMore: true, loading: false, lastOptions: {limit: 100},
    })
    const gitLog = (window as any).electronAPI.projectManager.gitLog
    gitLog.mockImplementation(async (_ws: string, o: {skip?: number}) =>
      Array.from({length: 100}, (_, i) => mk((o.skip ?? 0) + i)))
    const {container} = render(<GitDagGraph sortAsc />)
    const el = scrollElOf(container)
    setGeometry(el, {scrollTop: 0, clientHeight: 400, scrollHeight: 3000})
    fireEvent.scroll(el)
    await waitFor(() => expect(gitLog).toHaveBeenCalledTimes(1))
    // 未离开阈值（仍 <=48）：不重新武装 → 不连环
    fireEvent.scroll(el)
    fireEvent.scroll(el)
    await act(async () => { await Promise.resolve() })
    expect(gitLog).toHaveBeenCalledTimes(1)
    // 滚离顶部阈值再回顶 → 允许再次加载
    setGeometry(el, {scrollTop: 300, clientHeight: 400, scrollHeight: 3000})
    fireEvent.scroll(el)
    setGeometry(el, {scrollTop: 0, clientHeight: 400, scrollHeight: 3000})
    fireEvent.scroll(el)
    await waitFor(() => expect(gitLog).toHaveBeenCalledTimes(2))
  })

  it('loadMore 失败后恢复 armed 并可重试（消除 unhandled rejection）', async () => {
    useGitLogStore.setState({
      entries: Array.from({length: 100}, (_, i) => mk(i)), hasMore: true, loading: false, lastOptions: {limit: 100},
    })
    const gitLog = (window as any).electronAPI.projectManager.gitLog
    gitLog.mockRejectedValueOnce(new Error('ipc fail'))
      .mockImplementation(async (_ws: string, o: {skip?: number}) =>
        Array.from({length: 100}, (_, i) => mk((o.skip ?? 0) + i)))
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const {container} = render(<GitDagGraph />)
      const el = scrollElOf(container)
      setGeometry(el, {scrollTop: 2600, clientHeight: 400, scrollHeight: 3000})
      fireEvent.scroll(el)
      await waitFor(() => expect(gitLog).toHaveBeenCalledTimes(1))
      await act(async () => { await new Promise(r => setTimeout(r, 20)) })
      // 失败 → armed 恢复：仍贴底再派发 scroll 能重试（旧实现 armed 永久 false）
      fireEvent.scroll(el)
      await waitFor(() => expect(gitLog).toHaveBeenCalledTimes(2))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('滚离底部阈值区间再回到底部可再次触发（正常手感保留）', async () => {
    useGitLogStore.setState({
      entries: Array.from({length: 100}, (_, i) => mk(i)), hasMore: true, loading: false, lastOptions: {limit: 100},
    })
    const gitLog = (window as any).electronAPI.projectManager.gitLog
    gitLog.mockImplementation(async (_ws: string, o: {skip?: number}) =>
      Array.from({length: 100}, (_, i) => mk((o.skip ?? 0) + i)))
    const {container} = render(<GitDagGraph />)
    const el = scrollElOf(container)
    setGeometry(el, {scrollTop: 2600, clientHeight: 400, scrollHeight: 3000})
    fireEvent.scroll(el)
    await waitFor(() => expect(gitLog).toHaveBeenCalledTimes(1))
    // 滚开（距底 > 48px）→ 重新武装
    setGeometry(el, {scrollTop: 1000, clientHeight: 400, scrollHeight: 3000})
    fireEvent.scroll(el)
    // 再回到底部 → 允许再次加载
    setGeometry(el, {scrollTop: 2600, clientHeight: 400, scrollHeight: 3000})
    fireEvent.scroll(el)
    await waitFor(() => expect(gitLog).toHaveBeenCalledTimes(2))
  })
})

describe('GitDagGraph 滚动语义：顶部消费待刷新增量', () => {
  it('非顶部时置标记不刷新；滚到顶部才消费并 loadInitial', () => {
    useGitLogStore.setState({entries: [mk(0), mk(1)], hasMore: false, lastOptions: {limit: 100}})
    const loadInitialSpy = vi.spyOn(useGitLogStore.getState(), 'loadInitial').mockResolvedValue(undefined)
    const {container} = render(<GitDagGraph />)
    const el = scrollElOf(container)
    setGeometry(el, {scrollTop: 200, clientHeight: 400, scrollHeight: 3000})
    // refs 变动：用户不在顶部 → 只记标记，不打断当前阅读
    act(() => { useGitLogStore.getState().markHeadRefresh() })
    expect(useGitLogStore.getState().pendingHeadRefresh).toBe(true)
    expect(loadInitialSpy).not.toHaveBeenCalled()
    // 用户滚回顶部 → 消费标记并重取首屏
    el.scrollTop = 0
    fireEvent.scroll(el)
    expect(useGitLogStore.getState().pendingHeadRefresh).toBe(false)
    expect(loadInitialSpy).toHaveBeenCalledWith('/ws')
    loadInitialSpy.mockRestore()
  })

  it('置标记时用户已停在顶部 → 立即消费刷新（无需等下次滚动事件）', () => {
    useGitLogStore.setState({entries: [mk(0)], hasMore: false, lastOptions: {limit: 100}})
    const loadInitialSpy = vi.spyOn(useGitLogStore.getState(), 'loadInitial').mockResolvedValue(undefined)
    const {container} = render(<GitDagGraph />)
    setGeometry(scrollElOf(container), {scrollTop: 0, clientHeight: 400, scrollHeight: 3000})
    act(() => { useGitLogStore.getState().markHeadRefresh() })
    expect(useGitLogStore.getState().pendingHeadRefresh).toBe(false)
    expect(loadInitialSpy).toHaveBeenCalledWith('/ws')
    loadInitialSpy.mockRestore()
  })
})

describe('GitDagGraph 行渲染 memo', () => {
  it('无关状态变化（selectedHash 指向列表外）不导致行重渲染', () => {
    useGitLogStore.setState({entries: [mk(0), mk(1), mk(2)], selectedHash: null, selectedHashes: new Set()})
    // relativeTime 在行组件渲染体内调用 → 调用次数即「行渲染次数」的代理计数器
    const rtSpy = vi.spyOn(format, 'relativeTime')
    render(<GitDagGraph />)
    expect(rtSpy).toHaveBeenCalledTimes(3)   // 初始 3 行各一次
    // 选中一个不在列表内的 hash → 各行 selected 均不变 → memo 全部命中
    act(() => { useGitLogStore.setState({selectedHash: 'zzz'}) })
    expect(rtSpy).toHaveBeenCalledTimes(3)
    // 选中列表内的一行 → 仅该行 selected 变化 → 仅该行重渲染
    act(() => { useGitLogStore.setState({selectedHash: 'hash1'}) })
    expect(rtSpy).toHaveBeenCalledTimes(4)
    rtSpy.mockRestore()
  })
})
